import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { approvals, brokerOperations, issueApprovals, issues } from "@paperclipai/db";
import {
  activateRuntimeCandidateArgsSchema,
  brokerOperationRequestSchema,
  quarantineExactFileArgsSchema,
  type ActivateRuntimeCandidateArgs,
  type BrokerOperationName,
  type BrokerOperationRequest,
  type QuarantineExactFileArgs,
  type SubmitBrokerOperationReceipt,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  assertCompletionReceiptShape,
  getCompletionReceiptAcceptance,
  normalizeCompletionContractOnAttach,
  validateCompletionReceipt,
  type CompletionContractType,
} from "./completion-contracts.js";

/**
 * Approved-action broker, server side (ADR-20260823-quiescent-coordination
 * R2.16, R3.6, R3.7 — PR-5).
 *
 * The flow, end to end:
 *  1. REQUEST — a typed `brokerOperation` block rides an approval create next
 *     to `decisionLease`; the full request + content hashes are bound into the
 *     approval payload. NO `broker_operations` row exists yet.
 *  2. ENQUEUE — on approval acceptance the decision-continuation consumer
 *     calls `enqueueBrokerOperationForApprovedDecision`, which inserts the row
 *     in state `enqueued` exactly once (the (company_id, idempotency_key)
 *     unique makes replays no-ops) and attaches the PR-3 completion contract
 *     to EVERY issue linked to the approval (R3.7).
 *  3. CLAIM — the host broker (a loopback board actor) claims with a
 *     generation-fenced CAS (R3.6); reclaim needs an expired claim heartbeat
 *     AND bumps the generation, so a stale claimer's later writes fail.
 *  4. RECEIPT — the claimer submits a typed receipt; success forwards it into
 *     each linked issue's `completionReceipt` through the PR-3 fail-closed
 *     validator, so `done` becomes reachable; failure records preflight /
 *     rollback evidence with ZERO issue mutations.
 */

export const BROKER_EXECUTOR_IDENTITY = "broker";

/** Reclaim window (R3.6): configurable, default 10 minutes. */
export const BROKER_CLAIM_HEARTBEAT_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;

export function brokerClaimHeartbeatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.PAPERCLIP_BROKER_CLAIM_HEARTBEAT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : BROKER_CLAIM_HEARTBEAT_TIMEOUT_MS_DEFAULT;
}

export type BrokerOperationRow = typeof brokerOperations.$inferSelect;

type DbLike = Db;

type BrokerOperationDefinition = {
  /** Declared inverse rollback operation (R2.16): pre-declared, bound to the
   * same approval's rollback authorization, executed at most once per
   * generation. */
  rollbackOperation: string;
  contractType: CompletionContractType;
  argsSchema: z.ZodTypeAny;
  buildContractPreimage: (args: Record<string, unknown>) => Record<string, unknown>;
};

export const BROKER_OPERATION_REGISTRY: Record<BrokerOperationName, BrokerOperationDefinition> = {
  activate_runtime_candidate: {
    rollbackOperation: "restore_previous_runtime",
    contractType: "packaged_runtime_activation",
    argsSchema: activateRuntimeCandidateArgsSchema,
    buildContractPreimage: (args) => {
      const typed = args as ActivateRuntimeCandidateArgs;
      return {
        candidateRootPath: typed.candidateRootPath,
        artifactSha256s: typed.artifactSha256s,
        expectedVersion: typed.expectedVersion,
        expectedBuildCommit: typed.expectedBuildCommit,
        installerIdentity: BROKER_EXECUTOR_IDENTITY,
        rollbackArchiveRequired: true,
      };
    },
  },
  quarantine_exact_file: {
    rollbackOperation: "restore_quarantined_exact_file",
    contractType: "exact_file_quarantine",
    argsSchema: quarantineExactFileArgsSchema,
    buildContractPreimage: (args) => {
      const typed = args as QuarantineExactFileArgs;
      return {
        sourcePath: typed.sourcePath,
        sourceContentSha256: typed.sourceContentSha256,
        quarantineTargetPath: typed.quarantineTargetPath,
        sourceDirEntryBaselineCount: typed.sourceDirEntryBaselineCount,
        executorIdentity: BROKER_EXECUTOR_IDENTITY,
        reviewerRequired: true,
        rollbackArchiveRequired: true,
      };
    },
  },
};

/** The form stored inside `approval.payload.brokerOperation`. Deterministic —
 * no timestamps — so equivalent create replays stay payload-equal (R2.11). */
const storedBrokerOperationBlockSchema = z.object({
  request: brokerOperationRequestSchema,
  rollbackOperation: z.string().min(1).max(128),
}).strict();
export type StoredBrokerOperationBlock = z.infer<typeof storedBrokerOperationBlockSchema>;

/**
 * Bind a validated broker-operation request into the approval payload at
 * create time. Insert NOTHING into `broker_operations` here — the row is
 * created only on approval acceptance.
 */
export function bindBrokerOperationRequestToApprovalPayload(
  payload: Record<string, unknown>,
  requestValue: unknown,
): Record<string, unknown> {
  const parsed = brokerOperationRequestSchema.safeParse(requestValue);
  if (!parsed.success) {
    throw unprocessable("brokerOperation is not a valid named broker operation request", {
      validation: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const request = parsed.data;
  const block: StoredBrokerOperationBlock = {
    request,
    rollbackOperation: BROKER_OPERATION_REGISTRY[request.name].rollbackOperation,
  };
  return { ...payload, brokerOperation: block };
}

/** Parse the stored broker block from an approval payload, or null. */
export function getBrokerOperationRequestFromApprovalPayload(
  payload: unknown,
): StoredBrokerOperationBlock | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).brokerOperation;
  if (raw == null) return null;
  const parsed = storedBrokerOperationBlockSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Build + preimage-bind the completion contract for a broker request. */
export function buildCompletionContractForBrokerRequest(
  request: BrokerOperationRequest,
): Record<string, unknown> {
  const definition = BROKER_OPERATION_REGISTRY[request.name];
  return normalizeCompletionContractOnAttach(
    {
      contractType: definition.contractType,
      version: 1,
      contractRevision: 1,
      preimage: definition.buildContractPreimage(request.args),
    },
    { attachedBy: "broker_enqueue" },
  );
}

export type BrokerEnqueueRefusalReason =
  | "approval_missing"
  | "approval_not_approved"
  | "no_broker_operation_request"
  | "broker_operation_request_invalid"
  | "no_linked_issues"
  | "wrong_target_company";

export type BrokerEnqueueOutcome =
  | {
    outcome: "enqueued";
    /** True when THIS call created the row; false on an idempotent replay. */
    applied: boolean;
    operation: BrokerOperationRow;
    contractAttachedIssueIds: string[];
  }
  | { outcome: "refused"; reason: BrokerEnqueueRefusalReason };

function brokerOperationIdempotencyKey(approvalId: string, name: string): string {
  return `broker:${approvalId}:${name}`;
}

/**
 * Enqueue the broker operation bound to an ACCEPTED approval, exactly once
 * (step 2 above). Refusals are quiet, typed non-events (a missing block just
 * means this approval carries no broker operation); only unexpected errors
 * throw, so the continuation consumer's retry loop owns transient failures.
 *
 * Contract attachment (R3.7) happens here, in the same transaction as the
 * enqueue insert, for EVERY issue linked to the approval: after approval,
 * `done` on any linked issue requires an accepted receipt whose execution
 * identity is the broker.
 */
export async function enqueueBrokerOperationForApprovedDecision(
  db: DbLike,
  input: { approvalId: string },
): Promise<BrokerEnqueueOutcome> {
  const approval = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, input.approvalId))
    .then((rows) => rows[0] ?? null);
  if (!approval) return { outcome: "refused", reason: "approval_missing" };
  if (approval.status !== "approved") {
    return { outcome: "refused", reason: "approval_not_approved" };
  }

  const payload = approval.payload as Record<string, unknown> | null;
  const rawBlock = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.brokerOperation
    : null;
  if (rawBlock == null) return { outcome: "refused", reason: "no_broker_operation_request" };

  const parsedBlock = storedBrokerOperationBlockSchema.safeParse(rawBlock);
  if (!parsedBlock.success) {
    logger.warn(
      { approvalId: approval.id, validation: parsedBlock.error.issues },
      "approved broker operation request does not parse; refusing enqueue",
    );
    return { outcome: "refused", reason: "broker_operation_request_invalid" };
  }
  const request = parsedBlock.data.request;

  const linkedIssues = await db
    .select({ id: issues.id, companyId: issues.companyId, completionContract: issues.completionContract })
    .from(issueApprovals)
    .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
    .where(eq(issueApprovals.approvalId, approval.id))
    .orderBy(asc(issueApprovals.createdAt));
  if (linkedIssues.length === 0) {
    logger.warn({ approvalId: approval.id }, "approved broker operation has no linked issues; refusing enqueue");
    return { outcome: "refused", reason: "no_linked_issues" };
  }
  if (linkedIssues.some((issue) => issue.companyId !== approval.companyId)) {
    logger.warn({ approvalId: approval.id }, "approved broker operation targets issues outside the approval company; refusing enqueue");
    return { outcome: "refused", reason: "wrong_target_company" };
  }

  const idempotencyKey = brokerOperationIdempotencyKey(approval.id, request.name);
  const contract = buildCompletionContractForBrokerRequest(request);
  const contractPreimageSha256 = contract.preimageSha256 as string;

  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbLike;
    const now = new Date();
    const [inserted] = await tx
      .insert(brokerOperations)
      .values({
        companyId: approval.companyId,
        name: request.name,
        args: {
          ...request.args,
          rollbackOperation: parsedBlock.data.rollbackOperation,
        },
        approvalId: approval.id,
        idempotencyKey,
        state: "enqueued",
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) return { inserted: null as BrokerOperationRow | null, attached: [] as string[] };

    const attached: string[] = [];
    for (const issue of linkedIssues) {
      if (issue.completionContract == null) {
        await tx
          .update(issues)
          .set({ completionContract: contract, updatedAt: now })
          .where(eq(issues.id, issue.id));
        attached.push(issue.id);
        continue;
      }
      const existingSha = (issue.completionContract as Record<string, unknown>).preimageSha256;
      if (existingSha === contractPreimageSha256) continue; // already carries this contract
      logger.warn(
        { approvalId: approval.id, issueId: issue.id },
        "linked issue already carries a different completion contract; leaving it in place",
      );
    }
    return { inserted, attached };
  });

  if (!result.inserted) {
    // Already-consumed replay: the unique made this a no-op; return the row.
    const existing = await db
      .select()
      .from(brokerOperations)
      .where(and(
        eq(brokerOperations.companyId, approval.companyId),
        eq(brokerOperations.idempotencyKey, idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) {
      throw conflict("Broker operation enqueue lost a race and the winner is not visible yet", {
        approvalId: approval.id,
      });
    }
    return { outcome: "enqueued", applied: false, operation: existing, contractAttachedIssueIds: [] };
  }

  await logActivity(db, {
    companyId: approval.companyId,
    actorType: "system",
    actorId: "broker_enqueue",
    action: "broker_operation.enqueued",
    entityType: "broker_operation",
    entityId: result.inserted.id,
    details: {
      approvalId: approval.id,
      name: request.name,
      rollbackOperation: parsedBlock.data.rollbackOperation,
      linkedIssueCount: linkedIssues.length,
      contractAttachedIssueIds: result.attached,
      contractPreimageSha256,
    },
  }).catch(() => {});

  return {
    outcome: "enqueued",
    applied: true,
    operation: result.inserted,
    contractAttachedIssueIds: result.attached,
  };
}

export type ClaimBrokerOperationResult = {
  operation: BrokerOperationRow;
  /** True when this claim displaced an expired previous claimer. */
  reclaimed: boolean;
};

/**
 * Generation-fenced claim (R3.6). The authoritative fence is the
 * `(operation_id, claim_generation)` CAS: the UPDATE both matches the expected
 * generation in its WHERE clause and bumps it, so of N concurrent claimers
 * exactly one wins and every loser gets 409. Reclaim of a `claimed` row
 * additionally requires the claim heartbeat to be expired, and emits one loud
 * transition activity (R2.16).
 */
export async function claimBrokerOperation(
  db: DbLike,
  input: {
    operationId: string;
    claimedBy: string;
    expectedGeneration: number;
    heartbeatTimeoutMs?: number;
  },
): Promise<ClaimBrokerOperationResult> {
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? brokerClaimHeartbeatTimeoutMs();
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbLike;
    const now = new Date();
    const row = await tx
      .select()
      .from(brokerOperations)
      .where(eq(brokerOperations.id, input.operationId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Broker operation not found");

    if (row.claimGeneration !== input.expectedGeneration) {
      throw conflict("Broker operation claim generation is stale", {
        code: "stale_claim_generation",
        expectedGeneration: input.expectedGeneration,
        currentGeneration: row.claimGeneration,
        state: row.state,
      });
    }

    if (row.state !== "enqueued" && row.state !== "claimed") {
      throw conflict(`Broker operation is not claimable from state "${row.state}"`, {
        code: "not_claimable",
        state: row.state,
      });
    }

    let reclaimedFrom: string | null = null;
    if (row.state === "claimed") {
      const lastHeartbeatMs = row.claimHeartbeatAt?.getTime() ?? 0;
      if (now.getTime() - lastHeartbeatMs < heartbeatTimeoutMs) {
        throw conflict("Broker operation is claimed and its heartbeat is live", {
          code: "claim_live",
          claimedBy: row.claimedBy,
          claimGeneration: row.claimGeneration,
          claimHeartbeatAt: row.claimHeartbeatAt?.toISOString() ?? null,
        });
      }
      reclaimedFrom = row.claimedBy;
    }

    const [updated] = await tx
      .update(brokerOperations)
      .set({
        state: "claimed",
        claimedBy: input.claimedBy,
        claimGeneration: input.expectedGeneration + 1,
        claimHeartbeatAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(brokerOperations.id, input.operationId),
        eq(brokerOperations.claimGeneration, input.expectedGeneration),
        inArray(brokerOperations.state, ["enqueued", "claimed"]),
      ))
      .returning();
    if (!updated) {
      throw conflict("Broker operation claim lost the compare-and-set race", {
        code: "stale_claim_generation",
      });
    }
    return { operation: updated, reclaimedFrom };
  });

  if (outcome.reclaimedFrom !== null) {
    await logActivity(db, {
      companyId: outcome.operation.companyId,
      actorType: "system",
      actorId: input.claimedBy,
      action: "broker_operation.reclaimed",
      entityType: "broker_operation",
      entityId: outcome.operation.id,
      details: {
        previousClaimedBy: outcome.reclaimedFrom,
        newClaimedBy: input.claimedBy,
        claimGeneration: outcome.operation.claimGeneration,
        heartbeatTimeoutMs,
      },
    }).catch(() => {});
  }

  return { operation: outcome.operation, reclaimed: outcome.reclaimedFrom !== null };
}

/** Refresh the claim heartbeat; identity + generation fenced. */
export async function heartbeatBrokerOperation(
  db: DbLike,
  input: { operationId: string; claimedBy: string; claimGeneration: number },
): Promise<BrokerOperationRow> {
  const now = new Date();
  const [updated] = await db
    .update(brokerOperations)
    .set({ claimHeartbeatAt: now, updatedAt: now })
    .where(and(
      eq(brokerOperations.id, input.operationId),
      eq(brokerOperations.state, "claimed"),
      eq(brokerOperations.claimedBy, input.claimedBy),
      eq(brokerOperations.claimGeneration, input.claimGeneration),
    ))
    .returning();
  if (updated) return updated;

  const row = await db
    .select()
    .from(brokerOperations)
    .where(eq(brokerOperations.id, input.operationId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Broker operation not found");
  throw conflict("Broker operation heartbeat rejected", {
    code: row.claimedBy === input.claimedBy ? "stale_claim_generation" : "not_claim_holder",
    state: row.state,
    claimedBy: row.claimedBy,
    claimGeneration: row.claimGeneration,
  });
}

const TERMINALISH_BROKER_STATES = ["succeeded", "failed", "rolled_back", "dead"] as const;

export type SubmitBrokerOperationReceiptResult = {
  operation: BrokerOperationRow;
  /** False on an idempotent replay of an already-recorded receipt. */
  applied: boolean;
  /** Linked issues whose completionReceipt now carries the accepted receipt. */
  forwardedIssueIds: string[];
};

/**
 * Receipt submission (step 4). Fenced on executor identity == claimed_by AND
 * claim generation; a stale claimer displaced by a reclaim fails both.
 *
 * succeeded → the typed completion receipt is validated fail-closed against
 * the contract attached to EVERY linked issue and forwarded into each issue's
 * `completionReceipt` (so `done` becomes reachable, R3.7); any rejection
 * aborts with 422 and zero state change.
 *
 * failed → ZERO issue mutations; preflight evidence is recorded on the row;
 * with rollback evidence the state becomes `rolled_back` (the pre-declared
 * inverse ran) — deliberately NOT a quiet terminal state: it emits exactly one
 * loud activity and the decision itself remains unresolved for revision.
 */
export async function submitBrokerOperationReceipt(
  db: DbLike,
  input: { operationId: string; submission: SubmitBrokerOperationReceipt },
): Promise<SubmitBrokerOperationReceiptResult> {
  const { submission } = input;
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbLike;
    const now = new Date();
    const row = await tx
      .select()
      .from(brokerOperations)
      .where(eq(brokerOperations.id, input.operationId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Broker operation not found");

    if ((TERMINALISH_BROKER_STATES as readonly string[]).includes(row.state)) {
      if (row.claimedBy === submission.claimedBy && row.claimGeneration === submission.claimGeneration) {
        // Idempotent replay of the recorded receipt: no-op success.
        return { operation: row, applied: false, forwardedIssueIds: [] as string[], activity: null };
      }
      throw conflict("Broker operation already carries a receipt from a different claim", {
        code: "already_resolved",
        state: row.state,
        claimGeneration: row.claimGeneration,
      });
    }
    if (row.state !== "claimed") {
      throw conflict("Broker operation is not claimed", { code: "not_claimed", state: row.state });
    }
    if (row.claimedBy !== submission.claimedBy) {
      throw conflict("Receipt executor identity does not match the claim holder", {
        code: "not_claim_holder",
        claimedBy: row.claimedBy,
      });
    }
    if (row.claimGeneration !== submission.claimGeneration) {
      throw conflict("Receipt claim generation is stale", {
        code: "stale_claim_generation",
        currentGeneration: row.claimGeneration,
      });
    }

    if (submission.outcome === "succeeded") {
      const receiptValue = submission.completionReceipt as Record<string, unknown>;
      assertCompletionReceiptShape(receiptValue);
      if (receiptValue.executionRunId !== row.id) {
        throw unprocessable("Completion receipt executionRunId must be the broker operation id", {
          reasons: ["wrong_execution_id"],
          operationId: row.id,
        });
      }

      const linkedIssues = await tx
        .select({ id: issues.id, completionContract: issues.completionContract, completionReceipt: issues.completionReceipt })
        .from(issueApprovals)
        .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
        .where(eq(issueApprovals.approvalId, row.approvalId))
        .orderBy(asc(issueApprovals.createdAt));

      const forwardedIssueIds: string[] = [];
      for (const issue of linkedIssues) {
        if (issue.completionContract == null) {
          throw unprocessable("Linked issue is missing its completion contract; refusing the receipt", {
            issueId: issue.id,
            reasons: ["linked_issue_contract_missing"],
          });
        }
        const verdict = validateCompletionReceipt(issue.completionContract, receiptValue, {
          issueId: issue.id,
          expectedExecutionRunId: row.id,
          submitterIdentity: submission.claimedBy,
          previouslyAcceptedReceipt: getCompletionReceiptAcceptance(issue.completionReceipt)
            ? issue.completionReceipt
            : null,
        });
        if (verdict.outcome === "rejected") {
          throw unprocessable("Broker receipt rejected by the linked issue's completion contract", {
            issueId: issue.id,
            reasons: verdict.reasons,
          });
        }
        if (verdict.outcome === "accepted") {
          await tx
            .update(issues)
            .set({ completionReceipt: verdict.acceptedReceipt, updatedAt: now })
            .where(eq(issues.id, issue.id));
        }
        forwardedIssueIds.push(issue.id);
      }

      const [updated] = await tx
        .update(brokerOperations)
        .set({
          state: "succeeded",
          receipt: {
            outcome: "succeeded",
            submittedBy: submission.claimedBy,
            claimGeneration: submission.claimGeneration,
            completionReceipt: receiptValue,
            ...(submission.note ? { note: submission.note } : {}),
          },
          ...(submission.preflight ? { preflight: submission.preflight } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(brokerOperations.id, row.id),
          eq(brokerOperations.state, "claimed"),
          eq(brokerOperations.claimGeneration, submission.claimGeneration),
        ))
        .returning();
      if (!updated) throw conflict("Broker operation receipt lost the compare-and-set race");
      return {
        operation: updated,
        applied: true,
        forwardedIssueIds,
        activity: { action: "broker_operation.succeeded", details: { forwardedIssueIds } },
      };
    }

    // failed: zero issue mutations, evidence only.
    const rollback = submission.rollbackEvidence ?? null;
    const nextState = rollback ? "rolled_back" : "failed";
    const [updated] = await tx
      .update(brokerOperations)
      .set({
        state: nextState,
        receipt: {
          outcome: "failed",
          submittedBy: submission.claimedBy,
          claimGeneration: submission.claimGeneration,
          ...(submission.note ? { note: submission.note } : {}),
        },
        ...(submission.preflight ? { preflight: submission.preflight } : {}),
        ...(rollback
          ? {
            rollbackState: {
              rollbackOperation: (row.args as Record<string, unknown>).rollbackOperation ?? null,
              evidence: rollback,
              executedBy: submission.claimedBy,
              claimGeneration: submission.claimGeneration,
              /** rolled_back is nonterminal: the decision still needs revision. */
              terminal: false,
            },
          }
          : {}),
        updatedAt: now,
      })
      .where(and(
        eq(brokerOperations.id, row.id),
        eq(brokerOperations.state, "claimed"),
        eq(brokerOperations.claimGeneration, submission.claimGeneration),
      ))
      .returning();
    if (!updated) throw conflict("Broker operation receipt lost the compare-and-set race");
    return {
      operation: updated,
      applied: true,
      forwardedIssueIds: [] as string[],
      activity: {
        action: rollback ? "broker_operation.rolled_back" : "broker_operation.failed",
        details: rollback
          ? { rollbackArchiveSha256: rollback.archiveSha256, nonterminal: true }
          : { preflightHashesVerified: submission.preflight?.hashesVerified ?? null },
      },
    };
  });

  if (outcome.applied && outcome.activity) {
    await logActivity(db, {
      companyId: outcome.operation.companyId,
      actorType: "system",
      actorId: submission.claimedBy,
      action: outcome.activity.action,
      entityType: "broker_operation",
      entityId: outcome.operation.id,
      details: {
        approvalId: outcome.operation.approvalId,
        name: outcome.operation.name,
        claimGeneration: outcome.operation.claimGeneration,
        ...outcome.activity.details,
      },
    }).catch(() => {});
  }

  return {
    operation: outcome.operation,
    applied: outcome.applied,
    forwardedIssueIds: outcome.forwardedIssueIds,
  };
}

export async function getBrokerOperation(db: DbLike, id: string): Promise<BrokerOperationRow | null> {
  return db
    .select()
    .from(brokerOperations)
    .where(eq(brokerOperations.id, id))
    .then((rows) => rows[0] ?? null);
}

export async function listBrokerOperations(
  db: DbLike,
  companyId: string,
  opts: { state?: string | null; limit?: number } = {},
): Promise<BrokerOperationRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
  const conditions = [eq(brokerOperations.companyId, companyId)];
  if (opts.state) conditions.push(eq(brokerOperations.state, opts.state));
  return db
    .select()
    .from(brokerOperations)
    .where(and(...conditions))
    .orderBy(desc(brokerOperations.createdAt), desc(brokerOperations.id))
    .limit(limit);
}
