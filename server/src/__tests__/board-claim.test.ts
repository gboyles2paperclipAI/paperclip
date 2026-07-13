import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
  inspectBoardClaimChallenge,
  type BoardClaimTxStage,
} from "../board-claim.js";
import { HttpError } from "../errors.js";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const LOCAL_BOARD_USER_ID = "local-board";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describeEmbeddedPostgres("board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(cliAuthChallenges);
    await db.delete(boardApiKeys);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLocalBoardUser(now = new Date()) {
    await db.insert(authUsers).values({
      id: LOCAL_BOARD_USER_ID,
      name: "Board",
      email: "local@paperclip.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_BOARD_USER_ID,
      role: "instance_admin",
    });
  }

  async function seedClaimUser(prefix: string, now = new Date()) {
    const userId = `${prefix}-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: `${prefix} User`,
      email: `${prefix}-${randomUUID().slice(0, 8)}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  async function seedCompany(name: string) {
    return db
      .insert(companies)
      .values({
        name,
        issuePrefix: `BC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function startClaimChallenge() {
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();
    const parsed = new URL(warningUrl!);
    return {
      token: parsed.pathname.split("/").pop()!,
      code: parsed.searchParams.get("code")!,
    };
  }

  it("lets a signed-in user claim a local-board-only authenticated instance", async () => {
    const now = new Date();
    const userId = await seedClaimUser("claim-user", now);
    const company = await seedCompany("Board Claim Co");
    await seedLocalBoardUser(now);

    const { token, code } = await startClaimChallenge();
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "available",
      requiresSignIn: true,
      claimedByUserId: null,
    });

    await expect(claimBoardOwnership(db, { token, code, userId })).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([
      {
        status: "active",
        membershipRole: "owner",
      },
    ]);
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
  });

  it("atomically revokes local-board keys, cancels pending CLI challenges, and archives memberships/grants", async () => {
    const now = new Date();
    const userId = await seedClaimUser("cleanup-user", now);
    const otherUserId = await seedClaimUser("other-user", now);
    const company = await seedCompany("Cleanup Co");
    await seedLocalBoardUser(now);

    await db.insert(companyMemberships).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: otherUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);

    await db.insert(principalPermissionGrants).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        permissionKey: "tasks:assign",
        grantedByUserId: LOCAL_BOARD_USER_ID,
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: otherUserId,
        permissionKey: "tasks:assign",
        grantedByUserId: otherUserId,
      },
    ]);

    const localBoardToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    const otherUserToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    const alreadyRevokedToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    const [localBoardKey, otherUserKey, alreadyRevokedKey] = await db
      .insert(boardApiKeys)
      .values([
        {
          userId: LOCAL_BOARD_USER_ID,
          name: "local-board active key",
          keyHash: hashBearerToken(localBoardToken),
        },
        {
          userId: otherUserId,
          name: "other-user key",
          keyHash: hashBearerToken(otherUserToken),
        },
        {
          userId: LOCAL_BOARD_USER_ID,
          name: "local-board already revoked",
          keyHash: hashBearerToken(alreadyRevokedToken),
          revokedAt: new Date(now.getTime() - 60_000),
        },
      ])
      .returning();

    const pendingChallengeSecret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const pendingChallenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(pendingChallengeSecret),
        command: "paperclipai login",
        clientName: "pending-local",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "pending key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const terminalCancelled = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(`pcp_cli_auth_${randomUUID().replace(/-/g, "")}`),
        command: "paperclipai login",
        clientName: "already-cancelled",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "cancelled key",
        cancelledAt: new Date(now.getTime() - 30_000),
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const terminalApproved = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(`pcp_cli_auth_${randomUUID().replace(/-/g, "")}`),
        command: "paperclipai login",
        clientName: "already-approved",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "approved key",
        approvedByUserId: otherUserId,
        boardApiKeyId: otherUserKey!.id,
        approvedAt: new Date(now.getTime() - 30_000),
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Scoped agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const agentKeyHash = createHash("sha256").update(`agent-key-${randomUUID()}`).digest("hex");
    const agentKey = await db
      .insert(agentApiKeys)
      .values({
        companyId: company.id,
        agentId: agent.id,
        name: "agent scoped key",
        keyHash: agentKeyHash,
      })
      .returning()
      .then((rows) => rows[0]!);

    const { token, code } = await startClaimChallenge();
    const claimed = await claimBoardOwnership(db, { token, code, userId });
    expect(claimed).toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
    expect(claimed.cleanup?.revokedBoardApiKeyIds).toEqual([localBoardKey!.id]);
    expect(claimed.cleanup?.cancelledCliChallengeIds).toEqual([pendingChallenge.id]);
    expect(claimed.cleanup?.archivedMembershipIds).toHaveLength(1);
    expect(claimed.cleanup?.deletedGrantCount).toBe(1);
    expect(claimed.cleanup?.demotedLocalBoardAdmin).toBe(true);

    // Active local-board board key is revoked and fails resolution.
    const boardAuth = boardAuthService(db);
    await expect(boardAuth.findBoardApiKeyByToken(localBoardToken)).resolves.toBeNull();
    const revokedLocalBoardKey = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, localBoardKey!.id))
      .then((rows) => rows[0]!);
    expect(revokedLocalBoardKey.revokedAt).toBeTruthy();

    // Already-revoked local-board key is not re-touched in a way that would re-enable it.
    const stillRevoked = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, alreadyRevokedKey!.id))
      .then((rows) => rows[0]!);
    expect(stillRevoked.revokedAt).toBeTruthy();
    await expect(boardAuth.findBoardApiKeyByToken(alreadyRevokedToken)).resolves.toBeNull();

    // Other user's board key remains active.
    await expect(boardAuth.findBoardApiKeyByToken(otherUserToken)).resolves.toMatchObject({
      id: otherUserKey!.id,
      userId: otherUserId,
      revokedAt: null,
    });

    // Pending CLI challenge cancelled; terminal challenges unchanged; cannot complete pending.
    const pendingAfter = await db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, pendingChallenge.id))
      .then((rows) => rows[0]!);
    expect(pendingAfter.cancelledAt).toBeTruthy();
    expect(pendingAfter.approvedAt).toBeNull();

    // Cancelled pending challenge cannot be completed even with the correct secret.
    await expect(
      boardAuth.approveCliAuthChallenge(pendingChallenge.id, pendingChallengeSecret, userId),
    ).resolves.toMatchObject({ status: "cancelled" });
    const stillCancelled = await db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, pendingChallenge.id))
      .then((rows) => rows[0]!);
    expect(stillCancelled.approvedAt).toBeNull();
    expect(stillCancelled.boardApiKeyId).toBeNull();

    const cancelledAfter = await db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, terminalCancelled.id))
      .then((rows) => rows[0]!);
    expect(cancelledAfter.cancelledAt?.getTime()).toBe(terminalCancelled.cancelledAt?.getTime());

    const approvedAfter = await db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, terminalApproved.id))
      .then((rows) => rows[0]!);
    expect(approvedAfter.approvedAt).toBeTruthy();
    expect(approvedAfter.cancelledAt).toBeNull();
    expect(approvedAfter.boardApiKeyId).toBe(otherUserKey!.id);

    // Local-board membership archived; other user membership preserved.
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        ),
    ).resolves.toMatchObject([{ status: "archived" }]);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, otherUserId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ).resolves.toHaveLength(1);

    // Local-board grants gone; other user's grants remain.
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, LOCAL_BOARD_USER_ID),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, otherUserId),
          ),
        ),
    ).resolves.toHaveLength(1);

    // Claimant has owner membership + owner grants; instance admin.
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([{ status: "active", membershipRole: "owner" }]);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, userId),
          ),
        ),
    ).resolves.not.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);

    // Agent keys untouched.
    await expect(
      db.select().from(agentApiKeys).where(eq(agentApiKeys.id, agentKey.id)),
    ).resolves.toMatchObject([{ revokedAt: null, keyHash: agentKeyHash }]);

    // Audit evidence for each cleanup category (non-secret).
    const auditActions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id))
      .then((rows) => new Set(rows.map((row) => row.action)));
    for (const action of [
      "board_claim.local_board_api_keys_revoked",
      "board_claim.local_board_cli_challenges_cancelled",
      "board_claim.local_board_memberships_archived",
      "board_claim.local_board_grants_deleted",
      "board_claim.local_board_instance_admin_removed",
      "board_claim.completed",
    ]) {
      expect(auditActions.has(action)).toBe(true);
    }
  });

  it.each([
    "promote_claimant_admin",
    "ensure_claimant_owner_memberships",
    "ensure_claimant_owner_grants",
    "revoke_local_board_api_keys",
    "cancel_pending_cli_challenges",
    "archive_local_board_memberships",
    "delete_local_board_grants",
    "demote_local_board_admin",
    "write_cleanup_audit",
  ] satisfies BoardClaimTxStage[])(
    "rolls back the entire claim when stage %s fails",
    async (stage) => {
      const now = new Date();
      const userId = await seedClaimUser(`rollback-${stage}`, now);
      const company = await seedCompany(`Rollback ${stage}`);
      await seedLocalBoardUser(now);

      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        permissionKey: "tasks:assign",
        grantedByUserId: LOCAL_BOARD_USER_ID,
      });

      const localBoardToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
      const [localBoardKey] = await db
        .insert(boardApiKeys)
        .values({
          userId: LOCAL_BOARD_USER_ID,
          name: "local-board active key",
          keyHash: hashBearerToken(localBoardToken),
        })
        .returning();

      const pendingChallenge = await db
        .insert(cliAuthChallenges)
        .values({
          secretHash: hashBearerToken(`pcp_cli_auth_${randomUUID().replace(/-/g, "")}`),
          command: "paperclipai login",
          clientName: "pending",
          requestedAccess: "board",
          pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
          pendingKeyName: "pending key",
          expiresAt: new Date(now.getTime() + 10 * 60_000),
        })
        .returning()
        .then((rows) => rows[0]!);

      const { token, code } = await startClaimChallenge();

      await expect(
        claimBoardOwnership(db, {
          token,
          code,
          userId,
          __testFailAfterStage: stage,
        }),
      ).rejects.toThrow(`board-claim test fault after stage: ${stage}`);

      // Challenge remains available (in-memory claim marker only set after commit).
      expect(inspectBoardClaimChallenge(token, code).status).toBe("available");

      // No mixed ownership: claimant not admin, local-board still admin.
      await expect(
        db
          .select()
          .from(instanceUserRoles)
          .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
      ).resolves.toHaveLength(0);
      await expect(
        db
          .select()
          .from(instanceUserRoles)
          .where(
            and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
          ),
      ).resolves.toHaveLength(1);

      // Local-board access artifacts remain.
      await expect(
        db.select().from(boardApiKeys).where(and(eq(boardApiKeys.id, localBoardKey!.id), isNull(boardApiKeys.revokedAt))),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select()
          .from(cliAuthChallenges)
          .where(and(eq(cliAuthChallenges.id, pendingChallenge.id), isNull(cliAuthChallenges.cancelledAt))),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, company.id),
              eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
              eq(companyMemberships.status, "active"),
            ),
          ),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select()
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, company.id),
              eq(principalPermissionGrants.principalId, LOCAL_BOARD_USER_ID),
            ),
          ),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, company.id),
              eq(companyMemberships.principalId, userId),
            ),
          ),
      ).resolves.toHaveLength(0);
      await expect(db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).resolves.toHaveLength(0);

      // Successful retry after rollback still works once.
      await expect(claimBoardOwnership(db, { token, code, userId })).resolves.toMatchObject({
        status: "claimed",
        claimedByUserId: userId,
      });
    },
  );

  it("is idempotent on already-claimed tokens and does not re-enable local-board access", async () => {
    const now = new Date();
    const userId = await seedClaimUser("idempotent-user", now);
    const company = await seedCompany("Idempotent Co");
    await seedLocalBoardUser(now);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const localBoardToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({
      userId: LOCAL_BOARD_USER_ID,
      name: "local-board active key",
      keyHash: hashBearerToken(localBoardToken),
    });

    const { token, code } = await startClaimChallenge();
    const first = await claimBoardOwnership(db, { token, code, userId });
    expect(first.status).toBe("claimed");

    const auditCountAfterFirst = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id))
      .then((rows) => rows.length);

    const second = await claimBoardOwnership(db, { token, code, userId });
    expect(second).toEqual({ status: "claimed", claimedByUserId: userId });

    // Still no local-board admin / active membership / active key.
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(boardAuthService(db).findBoardApiKeyByToken(localBoardToken)).resolves.toBeNull();

    // Claimant ownership remains singular (no duplicate admin/membership rows).
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
            eq(companyMemberships.membershipRole, "owner"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const auditCountAfterSecond = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id))
      .then((rows) => rows.length);
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });

  it("refuses local-board CLI key mint after local-board instance admin is retired", async () => {
    const now = new Date();
    await seedLocalBoardUser(now);
    const boardAuth = boardAuthService(db);

    const challengeSecret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const challenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: "paperclipai login",
        clientName: "post-retirement",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "post-retirement key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    // Local-board may approve before retirement.
    await expect(
      boardAuth.approveCliAuthChallenge(challenge.id, challengeSecret, LOCAL_BOARD_USER_ID),
    ).resolves.toMatchObject({ status: "approved" });

    await db
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );

    const secondSecret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const secondChallenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(secondSecret),
        command: "paperclipai login",
        clientName: "after-retirement",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "after-retirement key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(
      boardAuth.approveCliAuthChallenge(secondChallenge.id, secondSecret, LOCAL_BOARD_USER_ID),
    ).rejects.toMatchObject({
      status: 403,
      message: "Local board access has been retired",
    } satisfies Partial<HttpError>);

    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(1);
  });

  it("keeps ordinary non-local-board CLI approval working after local-board retirement", async () => {
    const now = new Date();
    const humanUserId = await seedClaimUser("human-cli", now);
    await seedLocalBoardUser(now);
    await db
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );
    await db.insert(instanceUserRoles).values({
      userId: humanUserId,
      role: "instance_admin",
    });

    const secret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const challenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(secret),
        command: "paperclipai login",
        clientName: "human-cli",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "human key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const approved = await boardAuthService(db).approveCliAuthChallenge(
      challenge.id,
      secret,
      humanUserId,
    );
    expect(approved).toMatchObject({ status: "approved" });
    expect(approved.challenge.boardApiKeyId).toBeTruthy();

    const key = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, approved.challenge.boardApiKeyId!))
      .then((rows) => rows[0]!);
    expect(key.userId).toBe(humanUserId);
    expect(key.revokedAt).toBeNull();
  });

  it("serializes concurrent local-board CLI mint behind claim (claim holds lock first)", async () => {
    const now = new Date();
    const userId = await seedClaimUser("race-claim-first", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Race Claim First Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const seedKeyToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({
      userId: LOCAL_BOARD_USER_ID,
      name: "seed local-board key",
      keyHash: hashBearerToken(seedKeyToken),
    });

    const challengeSecret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const challenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: "paperclipai login",
        clientName: "race-claim-first",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "race key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const { token, code } = await startClaimChallenge();
    const claimHasLock = deferred();
    const releaseClaim = deferred();

    const claimPromise = claimBoardOwnership(db, {
      token,
      code,
      userId,
      __testHoldAfterLocalBoardLock: async () => {
        claimHasLock.resolve();
        await releaseClaim.promise;
      },
    });

    await claimHasLock.promise;

    // CLI approval blocks on the same local-board admin row lock held by claim.
    let approveSettled = false;
    const approvePromise = boardAuthService(db)
      .approveCliAuthChallenge(challenge.id, challengeSecret, LOCAL_BOARD_USER_ID)
      .then(
        (value) => {
          approveSettled = true;
          return value;
        },
        (error) => {
          approveSettled = true;
          throw error;
        },
      );

    // Deterministic: claim still holds the lock; approval must not settle yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(approveSettled).toBe(false);

    releaseClaim.resolve();
    await expect(claimPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });

    await expect(approvePromise).rejects.toMatchObject({
      status: 403,
      message: "Local board access has been retired",
    } satisfies Partial<HttpError>);

    // Zero active local-board board keys remain.
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(0);

    const challengeAfter = await db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, challenge.id))
      .then((rows) => rows[0]!);
    expect(challengeAfter.approvedAt).toBeNull();
    expect(challengeAfter.boardApiKeyId).toBeNull();
    // Claim cancelled the still-pending challenge under the same transaction.
    expect(challengeAfter.cancelledAt).toBeTruthy();

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
        ),
    ).resolves.toHaveLength(0);
  });

  it("revokes a concurrent local-board CLI mint when approval commits before claim (approve holds lock first)", async () => {
    const now = new Date();
    const userId = await seedClaimUser("race-approve-first", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Race Approve First Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const seedKeyToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({
      userId: LOCAL_BOARD_USER_ID,
      name: "seed local-board key",
      keyHash: hashBearerToken(seedKeyToken),
    });

    const challengeSecret = `pcp_cli_auth_${randomUUID().replace(/-/g, "")}`;
    const challenge = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: "paperclipai login",
        clientName: "race-approve-first",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(`pcp_board_${randomUUID().replace(/-/g, "")}`),
        pendingKeyName: "race key",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const { token, code } = await startClaimChallenge();
    const approveHasLock = deferred();
    const releaseApprove = deferred();

    const approvePromise = boardAuthService(db).approveCliAuthChallenge(
      challenge.id,
      challengeSecret,
      LOCAL_BOARD_USER_ID,
      {
        __testHoldAfterLocalBoardLock: async () => {
          approveHasLock.resolve();
          await releaseApprove.promise;
        },
      },
    );

    await approveHasLock.promise;

    let claimSettled = false;
    const claimPromise = claimBoardOwnership(db, {
      token,
      code,
      userId,
    }).then(
      (value) => {
        claimSettled = true;
        return value;
      },
      (error) => {
        claimSettled = true;
        throw error;
      },
    );

    // Deterministic: approval still holds the lock; claim must not settle yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(claimSettled).toBe(false);

    releaseApprove.resolve();
    await expect(approvePromise).resolves.toMatchObject({ status: "approved" });
    await expect(claimPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });

    // Claim observed and revoked the key minted by the earlier approval.
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(0);

    const allLocalBoardKeys = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID));
    expect(allLocalBoardKeys.length).toBeGreaterThanOrEqual(2);
    expect(allLocalBoardKeys.every((row) => row.revokedAt != null)).toBe(true);

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
        ),
    ).resolves.toHaveLength(0);
  });

  it("refuses local-board named key mint after local-board instance admin is retired", async () => {
    const now = new Date();
    await seedLocalBoardUser(now);
    const boardAuth = boardAuthService(db);

    // Pre-claim local_trusted path: named mint for local-board still works.
    const preClaim = await boardAuth.createNamedBoardApiKey({
      userId: LOCAL_BOARD_USER_ID,
      name: "pre-claim named key",
    });
    expect(preClaim.id).toBeTruthy();
    expect(preClaim.token.startsWith("pcp_board_")).toBe(true);

    await db
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );

    await expect(
      boardAuth.createNamedBoardApiKey({
        userId: LOCAL_BOARD_USER_ID,
        name: "post-retirement named key",
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Local board access has been retired",
    } satisfies Partial<HttpError>);

    // Only the pre-retirement key exists; no post-retirement insert.
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), eq(boardApiKeys.name, "post-retirement named key"))),
    ).resolves.toHaveLength(0);
  });

  it("keeps ordinary non-local-board named key creation working after local-board retirement", async () => {
    const now = new Date();
    const humanUserId = await seedClaimUser("human-named", now);
    await seedLocalBoardUser(now);
    await db
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );

    const key = await boardAuthService(db).createNamedBoardApiKey({
      userId: humanUserId,
      name: "human named key",
    });
    expect(key.id).toBeTruthy();
    expect(key.revokedAt).toBeNull();

    const row = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, key.id))
      .then((rows) => rows[0]!);
    expect(row.userId).toBe(humanUserId);
    expect(row.revokedAt).toBeNull();
  });

  it("serializes concurrent local-board named mint behind claim (claim holds lock first)", async () => {
    const now = new Date();
    const userId = await seedClaimUser("race-named-claim-first", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Race Named Claim First Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const seedKeyToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({
      userId: LOCAL_BOARD_USER_ID,
      name: "seed local-board key",
      keyHash: hashBearerToken(seedKeyToken),
    });

    const { token, code } = await startClaimChallenge();
    const claimHasLock = deferred();
    const releaseClaim = deferred();

    const claimPromise = claimBoardOwnership(db, {
      token,
      code,
      userId,
      __testHoldAfterLocalBoardLock: async () => {
        claimHasLock.resolve();
        await releaseClaim.promise;
      },
    });

    await claimHasLock.promise;

    // Named mint blocks on the same local-board admin row lock held by claim.
    let mintSettled = false;
    const mintPromise = boardAuthService(db)
      .createNamedBoardApiKey(
        {
          userId: LOCAL_BOARD_USER_ID,
          name: "race named key claim-first",
        },
        {
          __testHoldAfterLocalBoardLock: async () => {
            // Should only run after claim releases the admin row lock.
          },
        },
      )
      .then(
        (value) => {
          mintSettled = true;
          return value;
        },
        (error) => {
          mintSettled = true;
          throw error;
        },
      );

    // Deterministic: claim still holds the lock; mint must not settle yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(mintSettled).toBe(false);

    releaseClaim.resolve();
    await expect(claimPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });

    await expect(mintPromise).rejects.toMatchObject({
      status: 403,
      message: "Local board access has been retired",
    } satisfies Partial<HttpError>);

    // Zero active local-board board keys remain; no race-minted row.
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(
          and(
            eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID),
            eq(boardApiKeys.name, "race named key claim-first"),
          ),
        ),
    ).resolves.toHaveLength(0);

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
        ),
    ).resolves.toHaveLength(0);
  });

  it("revokes a concurrent local-board named mint when mint commits before claim (named mint holds lock first)", async () => {
    const now = new Date();
    const userId = await seedClaimUser("race-named-mint-first", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Race Named Mint First Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const seedKeyToken = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({
      userId: LOCAL_BOARD_USER_ID,
      name: "seed local-board key",
      keyHash: hashBearerToken(seedKeyToken),
    });

    const { token, code } = await startClaimChallenge();
    const mintHasLock = deferred();
    const releaseMint = deferred();

    const mintPromise = boardAuthService(db).createNamedBoardApiKey(
      {
        userId: LOCAL_BOARD_USER_ID,
        name: "race named key mint-first",
      },
      {
        __testHoldAfterLocalBoardLock: async () => {
          mintHasLock.resolve();
          await releaseMint.promise;
        },
      },
    );

    await mintHasLock.promise;

    let claimSettled = false;
    const claimPromise = claimBoardOwnership(db, {
      token,
      code,
      userId,
    }).then(
      (value) => {
        claimSettled = true;
        return value;
      },
      (error) => {
        claimSettled = true;
        throw error;
      },
    );

    // Deterministic: mint still holds the lock; claim must not settle yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(claimSettled).toBe(false);

    releaseMint.resolve();
    const minted = await mintPromise;
    expect(minted.id).toBeTruthy();
    await expect(claimPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });

    // Claim observed and revoked the key minted by the earlier named create.
    await expect(
      db
        .select()
        .from(boardApiKeys)
        .where(and(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID), isNull(boardApiKeys.revokedAt))),
    ).resolves.toHaveLength(0);

    const allLocalBoardKeys = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.userId, LOCAL_BOARD_USER_ID));
    expect(allLocalBoardKeys.length).toBeGreaterThanOrEqual(2);
    expect(allLocalBoardKeys.every((row) => row.revokedAt != null)).toBe(true);
    expect(allLocalBoardKeys.some((row) => row.id === minted.id && row.revokedAt != null)).toBe(true);

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
        ),
    ).resolves.toHaveLength(0);
  });

  it("serializes concurrent human claims so only one user is promoted (L1)", async () => {
    const now = new Date();
    const userA = await seedClaimUser("dual-claim-a", now);
    const userB = await seedClaimUser("dual-claim-b", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Dual Claim Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const { token, code } = await startClaimChallenge();
    const claimAHasLock = deferred();
    const releaseClaimA = deferred();

    const claimAPromise = claimBoardOwnership(db, {
      token,
      code,
      userId: userA,
      __testHoldAfterLocalBoardLock: async () => {
        claimAHasLock.resolve();
        await releaseClaimA.promise;
      },
    });

    await claimAHasLock.promise;

    let claimBSettled = false;
    const claimBPromise = claimBoardOwnership(db, {
      token,
      code,
      userId: userB,
    }).then(
      (value) => {
        claimBSettled = true;
        return value;
      },
      (error) => {
        claimBSettled = true;
        throw error;
      },
    );

    // Process-local challenge op holds; second claim must wait.
    await new Promise((r) => setTimeout(r, 50));
    expect(claimBSettled).toBe(false);

    releaseClaimA.resolve();
    await expect(claimAPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userA,
    });

    // Second caller sees already-claimed and reports the stored claimant (L2),
    // never attributes success to userB.
    await expect(claimBPromise).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userA,
    });

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userA), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userB), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);

    // Loser has zero owner membership / grants and no audit attribution.
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, userB),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, userB),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, company.id), eq(activityLog.actorId, userB))),
    ).resolves.toHaveLength(0);

    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userA,
    });
  });

  it("durable DB predicate: second claim waiting on FOR UPDATE aborts with zero side effects", async () => {
    const now = new Date();
    const userA = await seedClaimUser("db-race-a", now);
    const userB = await seedClaimUser("db-race-b", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("DB Race Claim Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      permissionKey: "tasks:assign",
      grantedByUserId: LOCAL_BOARD_USER_ID,
    });

    const { token, code } = await startClaimChallenge();
    const claimAHasLock = deferred();
    const releaseClaimA = deferred();

    // Winner holds the durable local-board admin row lock inside its claim TX.
    const claimAPromise = claimBoardOwnership(db, {
      token,
      code,
      userId: userA,
      __testHoldAfterLocalBoardLock: async () => {
        claimAHasLock.resolve();
        await releaseClaimA.promise;
      },
    });

    await claimAHasLock.promise;

    // Bypass process-local gate so this attempt races at the DB lock (the durable
    // single-winner predicate), not only at the in-process challenge op.
    let claimBSettled = false;
    const claimBPromise = claimBoardOwnership(db, {
      token,
      code,
      userId: userB,
      __testBypassChallengeOp: true,
    }).then(
      (value) => {
        claimBSettled = true;
        return value;
      },
      (error) => {
        claimBSettled = true;
        throw error;
      },
    );

    // Deterministic: A still holds FOR UPDATE; B must not settle yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(claimBSettled).toBe(false);

    releaseClaimA.resolve();
    await expect(claimAPromise).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userA,
    });

    // After A commits (deletes local-board admin), B's lock wait ends on a
    // missing row and aborts before any promotion/membership/grant/audit.
    await expect(claimBPromise).rejects.toMatchObject({
      status: 409,
      message: "Board ownership has already been claimed",
    } satisfies Partial<HttpError>);

    // Exactly one winner.
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userA), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userB), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
        ),
    ).resolves.toHaveLength(0);

    // Loser: zero owner membership/grants, no audit attribution.
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, userB),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, userB),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, company.id), eq(activityLog.actorId, userB))),
    ).resolves.toHaveLength(0);

    // Winner remains the stored claimant; loser cannot become stored claimant.
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userA,
    });
    await expect(claimBoardOwnership(db, { token, code, userId: userB })).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userA,
    });
  });

  it("refuses claim when local-board admin row is already gone (missing-row predicate)", async () => {
    const now = new Date();
    const userId = await seedClaimUser("missing-row", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Missing Row Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const { token, code } = await startClaimChallenge();

    // Simulate prior winner already demoting local-board while challenge is still
    // visible as available (e.g. multi-worker / process-local gap).
    await db
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );

    await expect(claimBoardOwnership(db, { token, code, userId })).rejects.toMatchObject({
      status: 409,
      message: "Board ownership has already been claimed",
    } satisfies Partial<HttpError>);

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, userId)),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, userId),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).resolves.toHaveLength(
      0,
    );
    // Challenge remains unconsumed; missing-row abort does not promote or mark.
    expect(inspectBoardClaimChallenge(token, code).status).toBe("available");
  });

  it("allows retry after rolled-back claim without dual promotion (L1 rollback)", async () => {
    const now = new Date();
    const userA = await seedClaimUser("rollback-retry-a", now);
    const userB = await seedClaimUser("rollback-retry-b", now);
    await seedLocalBoardUser(now);
    const company = await seedCompany("Rollback Retry Co");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const { token, code } = await startClaimChallenge();

    await expect(
      claimBoardOwnership(db, {
        token,
        code,
        userId: userA,
        __testFailAfterStage: "promote_claimant_admin",
      }),
    ).rejects.toThrow("board-claim test fault after stage: promote_claimant_admin");

    expect(inspectBoardClaimChallenge(token, code).status).toBe("available");

    // Loser of the failed attempt has zero side effects.
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userA), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, userA)),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, userA),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, company.id), eq(activityLog.actorId, userA))),
    ).resolves.toHaveLength(0);

    // After rollback the challenge remains consumable by a later caller.
    await expect(claimBoardOwnership(db, { token, code, userId: userB })).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userB,
    });

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userA), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userB), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalId, userB),
            eq(companyMemberships.status, "active"),
            eq(companyMemberships.membershipRole, "owner"),
          ),
        ),
    ).resolves.toHaveLength(1);

    // Subsequent caller still reports stored claimant, not themselves.
    await expect(claimBoardOwnership(db, { token, code, userId: userA })).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userB,
    });
  });

  it("does not expose claim/approve/named-mint lock hold hooks through HTTP route source", async () => {
    // Service options `__testHoldAfterLocalBoardLock` / `__testFailAfterStage` /
    // `__testBypassChallengeOp` are not part of the HTTP contract. Routes only
    // pass token/code/userId (claim), challenge id + body.token + actor userId
    // (approve), or named-key body fields.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const accessRoutePath = fileURLToPath(new URL("../routes/access.ts", import.meta.url));
    const source = await readFile(accessRoutePath, "utf8");
    expect(source).not.toContain("__testHoldAfterLocalBoardLock");
    expect(source).not.toContain("__testFailAfterStage");
    expect(source).not.toContain("__testBypassChallengeOp");
    expect(source).toContain("claimBoardOwnership(db, {\n      token,\n      code,\n      userId: req.actor.userId");
    expect(source).toContain(
      "boardAuth.approveCliAuthChallenge(\n        id,\n        req.body.token,\n        userId,\n      )",
    );
    expect(source).toContain(
      "boardAuth.createNamedBoardApiKey({\n        userId: req.actor.userId,\n        name: req.body.name,\n        expiresAt: req.body.expiresAt === undefined ? undefined : req.body.expiresAt,\n      })",
    );
  });
});
