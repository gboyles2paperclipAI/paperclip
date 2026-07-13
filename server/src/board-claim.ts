import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { conflict } from "./errors.js";
import {
  LOCAL_BOARD_USER_ID,
  lockLocalBoardInstanceAdminForUpdate,
} from "./local-board-retirement.js";
import { ensureHumanRoleDefaultGrants } from "./services/principal-access-compatibility.js";

const CLAIM_TTL_MS = 1000 * 60 * 60 * 24;

type ChallengeStatus = "available" | "claimed" | "expired" | "invalid";

/**
 * Ordered stages inside the atomic claim transaction.
 * Test-only failure injection can throw after any named stage completes.
 */
export type BoardClaimTxStage =
  | "promote_claimant_admin"
  | "ensure_claimant_owner_memberships"
  | "ensure_claimant_owner_grants"
  | "revoke_local_board_api_keys"
  | "cancel_pending_cli_challenges"
  | "archive_local_board_memberships"
  | "delete_local_board_grants"
  | "demote_local_board_admin"
  | "write_cleanup_audit";

type ClaimChallenge = {
  token: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
};

export type BoardClaimCleanupSummary = {
  revokedBoardApiKeyIds: string[];
  cancelledCliChallengeIds: string[];
  archivedMembershipIds: string[];
  deletedGrantCount: number;
  demotedLocalBoardAdmin: boolean;
  claimedCompanyIds: string[];
};

let activeChallenge: ClaimChallenge | null = null;

/**
 * Process-local serialization for the in-memory one-time claim challenge.
 * Held only for the duration of a single claimBoardOwnership attempt so two
 * concurrent callers with the same token/code cannot both promote. Released
 * before return so later/unrelated challenges are not blocked.
 */
let boardClaimChallengeOp: Promise<void> = Promise.resolve();

async function withBoardClaimChallengeOp<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = boardClaimChallengeOp;
  boardClaimChallengeOp = gate;
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function createChallenge(now = new Date()): ClaimChallenge {
  return {
    token: randomBytes(24).toString("hex"),
    code: randomBytes(12).toString("hex"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
    claimedAt: null,
    claimedByUserId: null,
  };
}

function getChallengeStatus(token: string, code: string | undefined): ChallengeStatus {
  if (!activeChallenge) return "invalid";
  if (activeChallenge.token !== token) return "invalid";
  if (activeChallenge.code !== (code ?? "")) return "invalid";
  if (activeChallenge.claimedAt) return "claimed";
  if (activeChallenge.expiresAt.getTime() <= Date.now()) return "expired";
  return "available";
}

function maybeFailAfterStage(
  stage: BoardClaimTxStage,
  failAfterStage: BoardClaimTxStage | undefined,
): void {
  if (failAfterStage && failAfterStage === stage) {
    throw new Error(`board-claim test fault after stage: ${stage}`);
  }
}

async function writeCleanupAudit(
  tx: Db,
  opts: {
    actorUserId: string;
    companyIds: string[];
    summary: BoardClaimCleanupSummary;
  },
): Promise<void> {
  if (opts.companyIds.length === 0) return;

  const now = new Date();
  const common = {
    actorType: "user" as const,
    actorId: opts.actorUserId,
    entityType: "user",
    entityId: LOCAL_BOARD_USER_ID,
    createdAt: now,
  };

  const rows = opts.companyIds.flatMap((companyId) => [
    {
      ...common,
      companyId,
      action: "board_claim.local_board_api_keys_revoked",
      details: {
        revokedVia: "board_claim",
        count: opts.summary.revokedBoardApiKeyIds.length,
        boardApiKeyIds: opts.summary.revokedBoardApiKeyIds,
      },
    },
    {
      ...common,
      companyId,
      action: "board_claim.local_board_cli_challenges_cancelled",
      details: {
        cancelledVia: "board_claim",
        count: opts.summary.cancelledCliChallengeIds.length,
        challengeIds: opts.summary.cancelledCliChallengeIds,
      },
    },
    {
      ...common,
      companyId,
      action: "board_claim.local_board_memberships_archived",
      details: {
        archivedVia: "board_claim",
        count: opts.summary.archivedMembershipIds.length,
        membershipIds: opts.summary.archivedMembershipIds,
      },
    },
    {
      ...common,
      companyId,
      action: "board_claim.local_board_grants_deleted",
      details: {
        deletedVia: "board_claim",
        count: opts.summary.deletedGrantCount,
      },
    },
    {
      ...common,
      companyId,
      action: "board_claim.local_board_instance_admin_removed",
      details: {
        demotedVia: "board_claim",
        demoted: opts.summary.demotedLocalBoardAdmin,
      },
    },
    {
      ...common,
      companyId,
      action: "board_claim.completed",
      details: {
        claimantUserId: opts.actorUserId,
        claimedCompanyIds: opts.summary.claimedCompanyIds,
        revokedBoardApiKeyCount: opts.summary.revokedBoardApiKeyIds.length,
        cancelledCliChallengeCount: opts.summary.cancelledCliChallengeIds.length,
        archivedMembershipCount: opts.summary.archivedMembershipIds.length,
        deletedGrantCount: opts.summary.deletedGrantCount,
        demotedLocalBoardAdmin: opts.summary.demotedLocalBoardAdmin,
      },
    },
  ]);

  await tx.insert(activityLog).values(rows);
}

export async function initializeBoardClaimChallenge(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Promise<void> {
  if (opts.deploymentMode !== "authenticated") {
    activeChallenge = null;
    return;
  }

  const admins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));

  const onlyLocalBoardAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_USER_ID;
  if (!onlyLocalBoardAdmin) {
    activeChallenge = null;
    return;
  }

  if (!activeChallenge || activeChallenge.expiresAt.getTime() <= Date.now() || activeChallenge.claimedAt) {
    activeChallenge = createChallenge();
  }
}

export function getBoardClaimWarningUrl(host: string, port: number): string | null {
  if (!activeChallenge) return null;
  if (activeChallenge.claimedAt || activeChallenge.expiresAt.getTime() <= Date.now()) return null;
  const visibleHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${visibleHost}:${port}/board-claim/${activeChallenge.token}?code=${activeChallenge.code}`;
}

export function inspectBoardClaimChallenge(token: string, code: string | undefined) {
  const status = getChallengeStatus(token, code);
  return {
    status,
    requiresSignIn: true,
    expiresAt: activeChallenge?.expiresAt?.toISOString() ?? null,
    claimedByUserId: activeChallenge?.claimedByUserId ?? null,
  };
}

/**
 * Atomically transfer instance/company ownership to a signed-in user and retire
 * residual local-board access artifacts from the prior local_trusted window.
 *
 * Transaction boundary covers:
 * - claimant instance-admin promotion
 * - claimant active owner memberships + default owner grants
 * - revoke active local-board board API keys (already-revoked rows left untouched)
 * - cancel pending CLI auth challenges (approved/cancelled/expired left untouched)
 * - archive active local-board company memberships
 * - delete local-board principal permission grants
 * - demote local-board instance-admin
 * - non-secret per-company audit rows for each cleanup category
 *
 * Any failure rolls back owner promotion and cleanup together (no mixed ownership).
 * Agent API keys and credentials owned by other users are never touched.
 *
 * Single-winner durability:
 * - process-local challenge op is defense/UX only (same-process concurrent callers)
 * - durable predicate: after SELECT … FOR UPDATE on the local-board instance_admin
 *   row, the row must exist; if a prior claim already deleted it, this attempt
 *   aborts with a conflict before any claimant admin/membership/grant/audit work
 *
 * Idempotency:
 * - already-claimed challenge tokens return status "claimed" without re-running cleanup
 * - re-entry after a rolled-back failure leaves prior state intact so a later claim can retry
 * - already-terminal keys/challenges/memberships are no-ops inside the cleanup stages
 */
export async function claimBoardOwnership(
  db: Db,
  opts: {
    token: string;
    code: string | undefined;
    userId: string;
    /** Test-only: throw after the named stage completes (still inside the DB transaction). */
    __testFailAfterStage?: BoardClaimTxStage;
    /**
     * Test-only: await this after acquiring the local-board instance-admin row lock
     * (still inside the claim transaction). Not accepted from HTTP routes.
     */
    __testHoldAfterLocalBoardLock?: () => Promise<void>;
    /**
     * Test-only: skip the process-local challenge op gate so concurrent claim
     * attempts can race at the durable DB lock (FOR UPDATE). Not accepted from
     * HTTP routes. Production always uses the process-local gate as defense/UX;
     * the missing local-board admin row after lock is the durable single-winner
     * security predicate.
     */
    __testBypassChallengeOp?: boolean;
  },
): Promise<{ status: ChallengeStatus; claimedByUserId?: string; cleanup?: BoardClaimCleanupSummary }> {
  // Serialize process-local challenge consumption so two concurrent signed-in
  // callers cannot both promote under the same one-time token/code.
  // This is defense/UX only — durable single-winner security is the DB row lock
  // plus the missing-row abort below (not this in-process gate).
  const runClaim = async (): Promise<{
    status: ChallengeStatus;
    claimedByUserId?: string;
    cleanup?: BoardClaimCleanupSummary;
  }> => {
    const status = getChallengeStatus(opts.token, opts.code);
    if (status === "claimed") {
      // Report the stored claimant — never attribute a prior claim to the current caller.
      return {
        status,
        claimedByUserId: activeChallenge?.claimedByUserId ?? undefined,
      };
    }
    if (status !== "available") return { status };

    const summary: BoardClaimCleanupSummary = {
      revokedBoardApiKeyIds: [],
      cancelledCliChallengeIds: [],
      archivedMembershipIds: [],
      deletedGrantCount: 0,
      demotedLocalBoardAdmin: false,
      claimedCompanyIds: [],
    };

    await db.transaction(async (tx) => {
      // Serialize against concurrent local-board board-key mint (CLI approve and
      // named createNamedBoardApiKey) and against concurrent claim attempts before
      // any claimant promotion or cleanup mutates roles/credentials.
      const lockedLocalBoardAdmin = await lockLocalBoardInstanceAdminForUpdate(tx as unknown as Db);
      if (opts.__testHoldAfterLocalBoardLock) {
        await opts.__testHoldAfterLocalBoardLock();
      }
      // Durable single-winner predicate: if the first claim already committed and
      // deleted this row, a second claimant that waited on FOR UPDATE must abort
      // here with zero side effects. Do not treat a missing row as "already clean"
      // and continue into promote/membership/grant/audit paths.
      if (!lockedLocalBoardAdmin) {
        throw conflict("Board ownership has already been claimed");
      }

      // --- Establish real owner/admin first ---
      const existingTargetAdmin = await tx
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, opts.userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null);
      if (!existingTargetAdmin) {
        await tx.insert(instanceUserRoles).values({
          userId: opts.userId,
          role: "instance_admin",
        });
      }
      maybeFailAfterStage("promote_claimant_admin", opts.__testFailAfterStage);

      const allCompanies = await tx.select({ id: companies.id }).from(companies);
      const claimedCompanyIds = allCompanies.map((company) => company.id);
      summary.claimedCompanyIds = claimedCompanyIds;

      for (const company of allCompanies) {
        const existing = await tx
          .select({ id: companyMemberships.id, status: companyMemberships.status })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, company.id),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, opts.userId),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!existing) {
          await tx.insert(companyMemberships).values({
            companyId: company.id,
            principalType: "user",
            principalId: opts.userId,
            status: "active",
            membershipRole: "owner",
          });
          continue;
        }

        // Always reaffirm active owner for the claimant; safe/idempotent on retry.
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id));
      }
      maybeFailAfterStage("ensure_claimant_owner_memberships", opts.__testFailAfterStage);

      for (const companyId of claimedCompanyIds) {
        await ensureHumanRoleDefaultGrants(tx as unknown as Db, {
          companyId,
          principalId: opts.userId,
          membershipRole: "owner",
          grantedByUserId: opts.userId,
        });
      }
      maybeFailAfterStage("ensure_claimant_owner_grants", opts.__testFailAfterStage);

      // --- Retire local-board residual access (same transaction) ---
      const now = new Date();

      const revokedKeys = await tx
        .update(boardApiKeys)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt)))
        .returning({ id: boardApiKeys.id });
      summary.revokedBoardApiKeyIds = revokedKeys.map((row) => row.id);
      maybeFailAfterStage("revoke_local_board_api_keys", opts.__testFailAfterStage);

      // Pending challenges have no owner column; while only local-board is instance admin,
      // every incomplete challenge is a residual of that local_trusted access window.
      // Already approved / cancelled / expired rows are left alone.
      const cancelledChallenges = await tx
        .update(cliAuthChallenges)
        .set({ cancelledAt: now, updatedAt: now })
        .where(
          and(
            isNull(cliAuthChallenges.cancelledAt),
            isNull(cliAuthChallenges.approvedAt),
            gt(cliAuthChallenges.expiresAt, now),
          ),
        )
        .returning({ id: cliAuthChallenges.id });
      summary.cancelledCliChallengeIds = cancelledChallenges.map((row) => row.id);
      maybeFailAfterStage("cancel_pending_cli_challenges", opts.__testFailAfterStage);

      const activeLocalBoardMemberships = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
            eq(companyMemberships.status, "active"),
          ),
        );

      if (activeLocalBoardMemberships.length > 0) {
        const membershipIds = activeLocalBoardMemberships.map((row) => row.id);
        await tx
          .update(companyMemberships)
          .set({ status: "archived", updatedAt: now })
          .where(inArray(companyMemberships.id, membershipIds));
        summary.archivedMembershipIds = membershipIds;
      }
      maybeFailAfterStage("archive_local_board_memberships", opts.__testFailAfterStage);

      const deletedGrants = await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .returning({ id: principalPermissionGrants.id });
      summary.deletedGrantCount = deletedGrants.length;
      maybeFailAfterStage("delete_local_board_grants", opts.__testFailAfterStage);

      const demoted = await tx
        .delete(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
        .returning({ id: instanceUserRoles.id });
      summary.demotedLocalBoardAdmin = demoted.length > 0;
      maybeFailAfterStage("demote_local_board_admin", opts.__testFailAfterStage);

      await writeCleanupAudit(tx as unknown as Db, {
        actorUserId: opts.userId,
        companyIds: claimedCompanyIds,
        summary,
      });
      maybeFailAfterStage("write_cleanup_audit", opts.__testFailAfterStage);
    });

    if (activeChallenge && activeChallenge.token === opts.token) {
      activeChallenge.claimedAt = new Date();
      activeChallenge.claimedByUserId = opts.userId;
    }

    return { status: "claimed", claimedByUserId: opts.userId, cleanup: summary };
  };

  if (opts.__testBypassChallengeOp) {
    return runClaim();
  }
  return withBoardClaimChallengeOp(runClaim);
}
