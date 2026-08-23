import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  approvals,
  decisionContinuations,
  decisionLeaseMembers,
  decisionLeases,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  enqueueBrokerOperationForApprovedDecision,
  getBrokerOperationRequestFromApprovalPayload,
} from "./broker-operations.js";

/**
 * Decision-lease writers (ADR-20260823-quiescent-coordination R2.5–R2.7,
 * R2.10, R2.11, R3.1, R3.2, R3.5).
 *
 * PR-1 shipped the read side (`decision-freeze.ts`: membership gate + bypass
 * option); this module owns lease creation, resolution, the continuation
 * outbox, and the integrity sweeps. Everything here takes an explicit
 * `Db`/transaction handle as its first argument so approvals and interactions
 * can compose lease writes into their own transactions (R3.2).
 */

/** Terminal dispositions write the single continuation row and release (R3.1). */
export const TERMINAL_DECISION_DISPOSITIONS = [
  "approved",
  "rejected",
  "cancelled",
  "expired",
  "superseded_by_comment",
  "stale_target",
  "dismissed",
  "operator_override",
] as const;

export type TerminalDecisionDisposition = (typeof TERMINAL_DECISION_DISPOSITIONS)[number];
/** `revision_requested` moves the lease to `revising` WITHOUT releasing (R3.1). */
export type DecisionDisposition = TerminalDecisionDisposition | "revision_requested";

export function isTerminalDecisionDisposition(value: string): value is TerminalDecisionDisposition {
  return (TERMINAL_DECISION_DISPOSITIONS as readonly string[]).includes(value);
}

export type DecisionKind = "approval" | "interaction";

export type DecisionLeaseRow = typeof decisionLeases.$inferSelect;
export type DecisionContinuationRow = typeof decisionContinuations.$inferSelect;

const FROZEN_LEASE_STATES = ["active", "revising"] as const;

/** Bounded cone (R2.8): refuse pathological graphs instead of freezing a board. */
const MAX_DECISION_CONE_MEMBERS = 2_000;

/** Dead-letter threshold for the continuation outbox (R2.7). */
export const DECISION_CONTINUATION_DEAD_LETTER_ATTEMPTS = 5;

type DbLike = Db;

/**
 * enqueueWakeup-compatible callback (heartbeatService(db).wakeup). Injected so
 * this module never imports heartbeat.ts (frozen surface) and cannot create an
 * import cycle.
 */
export type DecisionEnqueueWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
    decisionFreezeBypass?: { kind: "continuation" | "revision" } | null;
  },
) => Promise<{ id: string } | null>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Find the lease bound to a decision row. By default only frozen
 * (active/revising) leases are returned; `anyState` includes released leases,
 * which the interaction routes use to suppress the legacy direct wake for
 * decisions the outbox owns (R2.10) even after release.
 */
export async function findDecisionLeaseForDecision(
  dbOrTx: DbLike,
  input: {
    decisionKind: DecisionKind;
    decisionId: string;
    companyId?: string | null;
    anyState?: boolean;
  },
): Promise<DecisionLeaseRow | null> {
  const conditions = [
    eq(decisionLeases.decisionKind, input.decisionKind),
    eq(decisionLeases.decisionId, input.decisionId),
  ];
  if (input.companyId) conditions.push(eq(decisionLeases.companyId, input.companyId));
  if (!input.anyState) conditions.push(inArray(decisionLeases.state, [...FROZEN_LEASE_STATES]));
  return dbOrTx
    .select()
    .from(decisionLeases)
    .where(and(...conditions))
    .orderBy(asc(decisionLeases.createdAt), asc(decisionLeases.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function listDecisionLeaseMemberIds(dbOrTx: DbLike, leaseId: string): Promise<string[]> {
  const rows = await dbOrTx
    .select({ issueId: decisionLeaseMembers.issueId })
    .from(decisionLeaseMembers)
    .where(eq(decisionLeaseMembers.leaseId, leaseId))
    .orderBy(asc(decisionLeaseMembers.addedAt), asc(decisionLeaseMembers.issueId));
  return rows.map((row) => row.issueId);
}

/**
 * Decision cone (R2.3/R2.8): anchor + parentId-descendants + transitive
 * reverse-`blocks` dependents (`issue_relations` rows whose BLOCKER
 * (`issueId`) is a member pull the BLOCKED issue (`relatedIssueId`) in).
 * Fixed-point iteration over both expansions, cycle-guarded by the visited
 * set, company-scoped, bounded.
 */
export async function computeDecisionConeMemberIds(
  dbOrTx: DbLike,
  companyId: string,
  anchorIssueId: string,
): Promise<string[]> {
  const members = new Set<string>([anchorIssueId]);
  let frontier: string[] = [anchorIssueId];

  while (frontier.length > 0) {
    const childRows = await dbOrTx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, frontier)));
    const blockedRows = await dbOrTx
      .select({ id: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.issueId, frontier),
      ));

    const next: string[] = [];
    for (const row of [...childRows, ...blockedRows]) {
      if (members.has(row.id)) continue;
      members.add(row.id);
      next.push(row.id);
    }
    if (members.size > MAX_DECISION_CONE_MEMBERS) {
      throw unprocessable(
        `Decision cone exceeds the ${MAX_DECISION_CONE_MEMBERS}-member bound; refusing to freeze`,
        { anchorIssueId, memberCount: members.size },
      );
    }
    frontier = next;
  }

  return [...members];
}

/**
 * Union-only cone maintenance (R2.8 / Gemini C2): recompute the cone from the
 * anchor and ADD any newly reachable issues as members. Never removes members
 * (removal happens only at release). Returns the added issue ids.
 */
export async function recomputeConeForEdgeChange(tx: DbLike, leaseId: string): Promise<string[]> {
  const lease = await tx
    .select()
    .from(decisionLeases)
    .where(eq(decisionLeases.id, leaseId))
    .then((rows) => rows[0] ?? null);
  if (!lease || (lease.state !== "active" && lease.state !== "revising")) return [];

  const current = new Set(await listDecisionLeaseMemberIds(tx, leaseId));
  const recomputed = await computeDecisionConeMemberIds(tx, lease.companyId, lease.anchorIssueId);
  const added = recomputed.filter((issueId) => !current.has(issueId));
  if (added.length === 0) return [];
  await tx
    .insert(decisionLeaseMembers)
    .values(added.map((issueId) => ({ leaseId, issueId })))
    .onConflictDoNothing();
  return added;
}

export type CreateDecisionLeaseInput = {
  companyId: string;
  decisionKind: DecisionKind;
  decisionId: string;
  idempotencyKey: string;
  anchorIssueId: string;
  posture: { status: "in_review"; comment: string };
  requestingRunId?: string | null;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
};

export type CreateDecisionLeaseResult = {
  lease: DecisionLeaseRow;
  applied: boolean;
  memberIssueIds: string[];
  drainedWakeupIds: string[];
  /** Active (queued/running) runs bound to members, minus the requesting run.
   * The CALLER must interrupt these AFTER the transaction commits (cancelRun
   * touches adapters/processes and must not run inside a DB transaction). */
  runIdsToInterrupt: string[];
};

/**
 * Create a lease for a decision row inside the caller's transaction (R3.2):
 * posture (issue → in_review + evidence comment, server-side) THEN cone
 * members THEN lease row, plus the R2.3 drain of unclaimed member wakeups.
 * Same-key replay for the SAME decision returns the existing lease with
 * `applied: false`; same key bound to a different decision conflicts (409),
 * rolling back the enclosing transaction (zero side effects).
 */
export async function createLeaseForDecision(
  tx: DbLike,
  input: CreateDecisionLeaseInput,
): Promise<CreateDecisionLeaseResult> {
  const now = new Date();

  const anchor = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, input.anchorIssueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!anchor) throw notFound("Decision lease anchor issue not found");

  const existing = await tx
    .select()
    .from(decisionLeases)
    .where(and(
      eq(decisionLeases.companyId, input.companyId),
      eq(decisionLeases.decisionIdempotencyKey, input.idempotencyKey),
      inArray(decisionLeases.state, [...FROZEN_LEASE_STATES]),
    ))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    if (existing.decisionKind === input.decisionKind && existing.decisionId === input.decisionId) {
      return {
        lease: existing,
        applied: false,
        memberIssueIds: await listDecisionLeaseMemberIds(tx, existing.id),
        drainedWakeupIds: [],
        runIdsToInterrupt: [],
      };
    }
    throw conflict("Decision idempotency key is already bound to a different active lease", {
      idempotencyKey: input.idempotencyKey,
      leaseId: existing.id,
    });
  }

  // Posture (R3.2): waiting status + evidence comment in the SAME transaction,
  // written server-side so the owner's own freeze can never 422 it.
  if (anchor.status !== input.posture.status) {
    await tx
      .update(issues)
      .set({ status: input.posture.status, updatedAt: now })
      .where(and(eq(issues.id, input.anchorIssueId), eq(issues.companyId, input.companyId)));
  }
  await tx.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.anchorIssueId,
    authorAgentId: input.requestedByAgentId ?? null,
    authorUserId: input.requestedByUserId ?? null,
    authorType: input.requestedByAgentId ? "agent" : input.requestedByUserId ? "user" : "system",
    // Bind the evidence comment to the requesting run so comment-driven
    // supersede logic (which ignores run-authored comments) never treats it
    // as a board reply.
    createdByRunId: input.requestingRunId ?? null,
    body: input.posture.comment,
  });

  const memberIssueIds = await computeDecisionConeMemberIds(tx, input.companyId, input.anchorIssueId);

  // Lease row. `onConflictDoNothing` (instead of a raw insert) keeps a
  // concurrent same-key insert from aborting the enclosing transaction; the
  // partial unique on (company_id, decision_idempotency_key) WHERE
  // active/revising is the arbiter.
  const [lease] = await tx
    .insert(decisionLeases)
    .values({
      companyId: input.companyId,
      decisionKind: input.decisionKind,
      decisionId: input.decisionId,
      decisionIdempotencyKey: input.idempotencyKey,
      anchorIssueId: input.anchorIssueId,
      state: "active",
    })
    .onConflictDoNothing()
    .returning();
  if (!lease) {
    const winner = await tx
      .select()
      .from(decisionLeases)
      .where(and(
        eq(decisionLeases.companyId, input.companyId),
        eq(decisionLeases.decisionIdempotencyKey, input.idempotencyKey),
        inArray(decisionLeases.state, [...FROZEN_LEASE_STATES]),
      ))
      .then((rows) => rows[0] ?? null);
    if (winner && winner.decisionKind === input.decisionKind && winner.decisionId === input.decisionId) {
      return {
        lease: winner,
        applied: false,
        memberIssueIds: await listDecisionLeaseMemberIds(tx, winner.id),
        drainedWakeupIds: [],
        runIdsToInterrupt: [],
      };
    }
    throw conflict("Decision idempotency key is already bound to a different active lease", {
      idempotencyKey: input.idempotencyKey,
    });
  }

  await tx
    .insert(decisionLeaseMembers)
    .values(memberIssueIds.map((issueId) => ({ leaseId: lease.id, issueId })))
    .onConflictDoNothing();

  // Drain (R2.3): cancel unclaimed queued/deferred wakeups whose payload issue
  // is a member (generalizes cancelUnclaimedWakeupsForTree over the cone).
  const drained = await tx
    .update(agentWakeupRequests)
    .set({
      status: "cancelled",
      finishedAt: now,
      error: "Cancelled because a decision freeze was created for this issue",
      updatedAt: now,
    })
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
      isNull(agentWakeupRequests.runId),
      inArray(sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`, memberIssueIds),
    ))
    .returning({ id: agentWakeupRequests.id });

  // Interrupt set (R2.3): active runs bound to members EXCEPT the requesting
  // run (the owner is mid-run creating this decision). Mirrors the tree-hold
  // activeRunsForTree derivation: context issueId OR the member's stamped
  // executionRunId.
  const executionRunIds = await tx
    .select({ executionRunId: issues.executionRunId })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, memberIssueIds)))
    .then((rows) => rows
      .map((row) => row.executionRunId)
      .filter((value): value is string => typeof value === "string" && value.length > 0));
  const contextIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const activeRunRows = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, ["queued", "running"]),
      executionRunIds.length > 0
        ? or(inArray(contextIssueId, memberIssueIds), inArray(heartbeatRuns.id, executionRunIds))
        : inArray(contextIssueId, memberIssueIds),
    ));
  const runIdsToInterrupt = [...new Set(activeRunRows.map((row) => row.id))]
    .filter((runId) => runId !== (input.requestingRunId ?? null));

  return {
    lease,
    applied: true,
    memberIssueIds,
    drainedWakeupIds: drained.map((row) => row.id),
    runIdsToInterrupt,
  };
}

/**
 * Post-commit run interruption for a freshly created lease (R2.3). Reuses the
 * tree-hold pattern: cancel each run, log an activity row per interrupt, and
 * never let one failure hide the others.
 */
export async function interruptRunsForDecisionLease(
  db: DbLike,
  deps: { cancelRun: (runId: string, reason?: string) => Promise<unknown> },
  input: {
    companyId: string;
    leaseId: string;
    anchorIssueId: string;
    runIds: string[];
    actorType: "agent" | "user" | "system";
    actorId: string;
  },
): Promise<{ interrupted: string[]; failed: string[] }> {
  const interrupted: string[] = [];
  const failed: string[] = [];
  for (const runId of input.runIds) {
    try {
      await deps.cancelRun(runId, "Interrupted because a decision freeze was created for this issue");
      interrupted.push(runId);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "issue.decision_freeze_run_interrupted",
        entityType: "heartbeat_run",
        entityId: runId,
        details: { leaseId: input.leaseId, anchorIssueId: input.anchorIssueId, reason: "decision_freeze_created" },
      }).catch(() => {});
    } catch (error) {
      failed.push(runId);
      logger.warn({ err: error, runId, leaseId: input.leaseId }, "failed to interrupt run for decision freeze");
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "issue.decision_freeze_run_interrupt_failed",
        entityType: "heartbeat_run",
        entityId: runId,
        details: {
          leaseId: input.leaseId,
          anchorIssueId: input.anchorIssueId,
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
    }
  }
  return { interrupted, failed };
}

function mapDispositionToApprovalStatus(disposition: DecisionDisposition): string {
  if (disposition === "approved") return "approved";
  if (disposition === "rejected") return "rejected";
  return disposition;
}

/**
 * Build the continuation payload for a lease from its decision row. The
 * payload carries the wake target (`wakeAgentId`) plus the identifiers the
 * requester needs to revalidate; the dispatcher adds `revalidate: true` and
 * strips internal routing fields before delivery.
 */
export async function buildContinuationPayloadForLease(
  dbOrTx: DbLike,
  lease: DecisionLeaseRow,
  disposition: DecisionDisposition,
): Promise<Record<string, unknown>> {
  if (lease.decisionKind === "approval") {
    const approval = await dbOrTx
      .select()
      .from(approvals)
      .where(eq(approvals.id, lease.decisionId))
      .then((rows) => rows[0] ?? null);
    const linkedIssueIds = approval
      ? await dbOrTx
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .where(eq(issueApprovals.approvalId, approval.id))
        .orderBy(asc(issueApprovals.createdAt))
        .then((rows) => rows.map((row) => row.issueId))
      : [];
    // Broker-executed operations (R2.16): the continuation explicitly
    // instructs the woken owner that the broker performs the mutation — the
    // owner verifies only.
    const brokerBlock = approval
      ? getBrokerOperationRequestFromApprovalPayload(approval.payload)
      : null;
    return {
      wakeAgentId: approval?.requestedByAgentId ?? null,
      approvalId: lease.decisionId,
      approvalStatus: mapDispositionToApprovalStatus(disposition),
      issueId: linkedIssueIds[0] ?? lease.anchorIssueId,
      issueIds: linkedIssueIds.length > 0 ? linkedIssueIds : [lease.anchorIssueId],
      ...(brokerBlock
        ? {
          brokerOperation: {
            name: brokerBlock.request.name,
            executionModel: "broker_executes",
            ownerAction: "verify_only",
          },
        }
        : {}),
    };
  }

  const interaction = await dbOrTx
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
      status: issueThreadInteractions.status,
      createdByAgentId: issueThreadInteractions.createdByAgentId,
    })
    .from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.id, lease.decisionId))
    .then((rows) => rows[0] ?? null);
  const anchor = await dbOrTx
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, lease.anchorIssueId))
    .then((rows) => rows[0] ?? null);
  return {
    wakeAgentId: anchor?.assigneeAgentId ?? interaction?.createdByAgentId ?? null,
    issueId: lease.anchorIssueId,
    issueIds: [lease.anchorIssueId],
    interactionId: lease.decisionId,
    interactionKind: interaction?.kind ?? null,
    interactionStatus: interaction?.status ?? null,
  };
}

export type ResolveDecisionLeaseOutcome = {
  /** True when THIS call wrote the continuation (or the revising transition). */
  applied: boolean;
  /** The winning disposition — on a lost race this is the winner's, so callers
   * can surface e.g. "already expired" (R2.5). */
  disposition: string;
  lease: DecisionLeaseRow;
  continuationId: string | null;
};

/**
 * Resolve a lease (R2.5/R3.1).
 *
 * Terminal dispositions insert the single continuation row (unique on
 * lease_id — first writer wins, the loser gets `applied: false`, the winning
 * disposition, and ZERO side effects) and release the lease atomically.
 * `revision_requested` moves the lease to `revising` only: no continuation,
 * no release. The bounded revision wake is the CALLER's post-commit step
 * (see `sendDecisionRevisionWake`) because the `revising` state must be
 * committed before the freeze-bypass gate can validate the wake.
 */
export async function resolveLease(
  dbOrTx: DbLike,
  leaseId: string,
  disposition: DecisionDisposition,
  opts: { payload?: Record<string, unknown> | null } = {},
): Promise<ResolveDecisionLeaseOutcome> {
  return dbOrTx.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbLike;
    const lease = await tx
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, leaseId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!lease) throw notFound("Decision lease not found");

    if (lease.state === "released") {
      const winner = await tx
        .select()
        .from(decisionContinuations)
        .where(eq(decisionContinuations.leaseId, leaseId))
        .then((rows) => rows[0] ?? null);
      return {
        applied: false,
        disposition: lease.disposition ?? winner?.disposition ?? disposition,
        lease,
        continuationId: winner?.id ?? null,
      };
    }

    if (disposition === "revision_requested") {
      const [updated] = await tx
        .update(decisionLeases)
        .set({ state: "revising" })
        .where(and(eq(decisionLeases.id, leaseId), inArray(decisionLeases.state, [...FROZEN_LEASE_STATES])))
        .returning();
      return {
        applied: Boolean(updated),
        disposition,
        lease: updated ?? lease,
        continuationId: null,
      };
    }

    const [continuation] = await tx
      .insert(decisionContinuations)
      .values({
        leaseId,
        disposition,
        payload: {
          ...asRecord(opts.payload),
          leaseId,
          decisionKind: lease.decisionKind,
          decisionId: lease.decisionId,
          decisionIdempotencyKey: lease.decisionIdempotencyKey,
          anchorIssueId: lease.anchorIssueId,
          disposition,
        },
      })
      .onConflictDoNothing()
      .returning();
    if (!continuation) {
      const winner = await tx
        .select()
        .from(decisionContinuations)
        .where(eq(decisionContinuations.leaseId, leaseId))
        .then((rows) => rows[0] ?? null);
      return {
        applied: false,
        disposition: winner?.disposition ?? lease.disposition ?? disposition,
        lease,
        continuationId: winner?.id ?? null,
      };
    }

    const [released] = await tx
      .update(decisionLeases)
      .set({ state: "released", disposition, releasedAt: new Date() })
      .where(eq(decisionLeases.id, leaseId))
      .returning();
    return {
      applied: true,
      disposition,
      lease: released ?? lease,
      continuationId: continuation.id,
    };
  });
}

/**
 * Bounded revision wake (R3.1): key
 * `decision:{leaseId}:revision:{revisionEventId}` (repeats only per distinct
 * revision request), delivered to the anchor issue's assignee agent with the
 * internal `revision` bypass so it can pierce the (still frozen) cone. Must be
 * called AFTER the `revising` state committed.
 */
export async function sendDecisionRevisionWake(
  db: DbLike,
  deps: { enqueueWakeup: DecisionEnqueueWakeup },
  input: {
    lease: DecisionLeaseRow;
    revisionEventId: string;
    requestedByActorId: string;
    decisionNote?: string | null;
  },
): Promise<{ id: string } | null> {
  const anchor = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, input.lease.anchorIssueId))
    .then((rows) => rows[0] ?? null);
  const agentId = anchor?.assigneeAgentId ?? null;
  if (!agentId) {
    logger.warn(
      { leaseId: input.lease.id, anchorIssueId: input.lease.anchorIssueId },
      "decision revision requested but the anchor issue has no assignee agent to wake",
    );
    return null;
  }
  const payload: Record<string, unknown> = {
    leaseId: input.lease.id,
    decisionKind: input.lease.decisionKind,
    issueId: input.lease.anchorIssueId,
    revisionRequested: true,
    ...(input.lease.decisionKind === "approval" ? { approvalId: input.lease.decisionId } : { interactionId: input.lease.decisionId }),
    ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
  };
  return deps.enqueueWakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "decision_revision_requested",
    idempotencyKey: `decision:${input.lease.id}:revision:${input.revisionEventId}`,
    payload,
    requestedByActorType: "user",
    requestedByActorId: input.requestedByActorId,
    contextSnapshot: {
      ...payload,
      taskId: input.lease.anchorIssueId,
      wakeReason: "decision_revision_requested",
      source: "decision.revision",
    },
    decisionFreezeBypass: { kind: "revision" },
  });
}

function continuationWakeReason(decisionKind: string, disposition: string): string {
  if (decisionKind === "approval") {
    return disposition === "approved" ? "approval_approved" : `approval_${disposition}`;
  }
  return "decision_resolved";
}

/**
 * Continuation outbox dispatcher (R2.7/R2.10): deliver unconsumed
 * continuations as freeze-bypassing wakes with idempotency key
 * `decision:{leaseId}:{disposition}` and `revalidate: true`, CAS-consume on
 * success, increment delivery_attempts on failure, dead-letter after
 * DECISION_CONTINUATION_DEAD_LETTER_ATTEMPTS with ONE loud activity entry.
 * Strictly per-row: one poisoned continuation never blocks the others.
 */
export async function dispatchDecisionContinuations(
  db: DbLike,
  deps: { enqueueWakeup: DecisionEnqueueWakeup },
  opts: { leaseId?: string | null; limit?: number } = {},
): Promise<{ scanned: number; delivered: number; failed: number; deadLettered: number }> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const conditions = [
    isNull(decisionContinuations.consumedAt),
    isNull(decisionContinuations.deadLetteredAt),
  ];
  if (opts.leaseId) conditions.push(eq(decisionContinuations.leaseId, opts.leaseId));
  const rows = await db
    .select({
      continuation: decisionContinuations,
      companyId: decisionLeases.companyId,
      decisionKind: decisionLeases.decisionKind,
      decisionId: decisionLeases.decisionId,
      anchorIssueId: decisionLeases.anchorIssueId,
    })
    .from(decisionContinuations)
    .innerJoin(decisionLeases, eq(decisionLeases.id, decisionContinuations.leaseId))
    .where(and(...conditions))
    .orderBy(asc(decisionContinuations.createdAt), asc(decisionContinuations.id))
    .limit(limit);

  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of rows) {
    const continuation = row.continuation;
    try {
      const payload = asRecord(continuation.payload);
      const { wakeAgentId: rawWakeAgentId, ...deliverable } = payload;
      const wakeAgentId = typeof rawWakeAgentId === "string" && rawWakeAgentId.length > 0
        ? rawWakeAgentId
        : null;

      // Approved-action broker hook (R2.16/PR-5): an ACCEPTED approval that
      // carries a broker-operation request enqueues its broker_operations row
      // here, exactly once, BEFORE the continuation is consumed. Enqueue is
      // idempotent (unique on (company_id, idempotency_key)), so a crash
      // between enqueue and consume replays safely; a transient enqueue error
      // propagates so this delivery is retried rather than lost. Typed
      // refusals (no broker block, decision not approved) are non-events.
      let brokerOperationId: string | null = null;
      if (row.decisionKind === "approval" && continuation.disposition === "approved") {
        const enqueueOutcome = await enqueueBrokerOperationForApprovedDecision(db, {
          approvalId: row.decisionId,
        });
        if (enqueueOutcome.outcome === "enqueued") {
          brokerOperationId = enqueueOutcome.operation.id;
        }
      }

      if (wakeAgentId) {
        const reason = continuationWakeReason(row.decisionKind, continuation.disposition);
        const wakePayload = {
          ...deliverable,
          revalidate: true,
          ...(brokerOperationId ? { brokerOperationId } : {}),
        };
        await deps.enqueueWakeup(wakeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason,
          idempotencyKey: `decision:${continuation.leaseId}:${continuation.disposition}`,
          payload: wakePayload,
          requestedByActorType: "system",
          requestedByActorId: "decision_outbox",
          contextSnapshot: {
            ...wakePayload,
            taskId: typeof deliverable.issueId === "string" ? deliverable.issueId : row.anchorIssueId,
            wakeReason: reason,
            source: "decision.continuation",
          },
          decisionFreezeBypass: { kind: "continuation" },
        });
      } else {
        logger.warn(
          { continuationId: continuation.id, leaseId: continuation.leaseId },
          "decision continuation has no wake target; consuming without a wake",
        );
      }
      const consumed = await db
        .update(decisionContinuations)
        .set({ consumedAt: new Date() })
        .where(and(eq(decisionContinuations.id, continuation.id), isNull(decisionContinuations.consumedAt)))
        .returning({ id: decisionContinuations.id });
      if (consumed.length > 0) delivered += 1;
    } catch (error) {
      const [updated] = await db
        .update(decisionContinuations)
        .set({ deliveryAttempts: sql`${decisionContinuations.deliveryAttempts} + 1` })
        .where(and(
          eq(decisionContinuations.id, continuation.id),
          isNull(decisionContinuations.consumedAt),
          isNull(decisionContinuations.deadLetteredAt),
        ))
        .returning({ deliveryAttempts: decisionContinuations.deliveryAttempts })
        .catch(() => [] as Array<{ deliveryAttempts: number }>);
      failed += 1;
      logger.warn(
        { err: error, continuationId: continuation.id, leaseId: continuation.leaseId },
        "decision continuation delivery failed",
      );
      if (updated && updated.deliveryAttempts >= DECISION_CONTINUATION_DEAD_LETTER_ATTEMPTS) {
        const dead = await db
          .update(decisionContinuations)
          .set({ deadLetteredAt: new Date() })
          .where(and(
            eq(decisionContinuations.id, continuation.id),
            isNull(decisionContinuations.consumedAt),
            isNull(decisionContinuations.deadLetteredAt),
          ))
          .returning({ id: decisionContinuations.id })
          .catch(() => [] as Array<{ id: string }>);
        if (dead.length > 0) {
          deadLettered += 1;
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "decision_outbox",
            action: "decision_lease.continuation_dead_lettered",
            entityType: "decision_lease",
            entityId: continuation.leaseId,
            details: {
              continuationId: continuation.id,
              disposition: continuation.disposition,
              deliveryAttempts: updated.deliveryAttempts,
              anchorIssueId: row.anchorIssueId,
              error: error instanceof Error ? error.message : String(error),
            },
          }).catch(() => {});
        }
      }
    }
  }

  return { scanned: rows.length, delivered, failed, deadLettered };
}

function mapTerminalInteractionDisposition(row: {
  status: string;
  result: unknown;
}): TerminalDecisionDisposition | null {
  const result = asRecord(row.result);
  const outcome = typeof result.outcome === "string" ? result.outcome : null;
  const expirationReason = typeof result.expirationReason === "string" ? result.expirationReason : null;
  switch (row.status) {
    case "accepted":
    case "answered":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "expired":
      if (outcome === "superseded_by_comment" || expirationReason === "superseded_by_comment") {
        return "superseded_by_comment";
      }
      if (outcome === "stale_target") return "stale_target";
      return "expired";
    default:
      return null;
  }
}

/**
 * Orphaned-lease sweep (R2.7): an active/revising lease whose decision row is
 * terminal with no continuation gets resolved with the decision's actual
 * state; a lease whose decision row is GONE is indeterminate and resolves as
 * operator_override with one loud activity entry. Continuation delivery is the
 * dispatcher's job — this sweep only writes the missing continuation rows.
 */
export async function sweepOrphanedDecisionLeases(
  db: DbLike,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; resolved: number }> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
  const leases = await db
    .select()
    .from(decisionLeases)
    .where(inArray(decisionLeases.state, [...FROZEN_LEASE_STATES]))
    .orderBy(asc(decisionLeases.createdAt), asc(decisionLeases.id))
    .limit(limit);

  let resolved = 0;
  for (const lease of leases) {
    try {
      let disposition: TerminalDecisionDisposition | null = null;
      let decisionMissing = false;

      if (lease.decisionKind === "approval") {
        const approval = await db
          .select({ status: approvals.status })
          .from(approvals)
          .where(eq(approvals.id, lease.decisionId))
          .then((rows) => rows[0] ?? null);
        if (!approval) {
          decisionMissing = true;
        } else if (approval.status === "approved") {
          disposition = "approved";
        } else if (approval.status === "rejected") {
          disposition = "rejected";
        }
      } else {
        const interaction = await db
          .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, lease.decisionId))
          .then((rows) => rows[0] ?? null);
        if (!interaction) {
          decisionMissing = true;
        } else {
          disposition = mapTerminalInteractionDisposition(interaction);
        }
      }

      if (decisionMissing) {
        const payload = await buildContinuationPayloadForLease(db, lease, "operator_override");
        const outcome = await resolveLease(db, lease.id, "operator_override", { payload });
        if (outcome.applied) {
          resolved += 1;
          await logActivity(db, {
            companyId: lease.companyId,
            actorType: "system",
            actorId: "decision_lease_sweeper",
            action: "decision_lease.orphan_resolved",
            entityType: "decision_lease",
            entityId: lease.id,
            details: {
              reason: "decision_row_missing",
              decisionKind: lease.decisionKind,
              decisionId: lease.decisionId,
              disposition: "operator_override",
              anchorIssueId: lease.anchorIssueId,
            },
          }).catch(() => {});
        }
        continue;
      }

      if (!disposition) continue;
      const payload = await buildContinuationPayloadForLease(db, lease, disposition);
      const outcome = await resolveLease(db, lease.id, disposition, { payload });
      if (outcome.applied) {
        resolved += 1;
        await logActivity(db, {
          companyId: lease.companyId,
          actorType: "system",
          actorId: "decision_lease_sweeper",
          action: "decision_lease.orphan_resolved",
          entityType: "decision_lease",
          entityId: lease.id,
          details: {
            reason: "terminal_decision_without_continuation",
            decisionKind: lease.decisionKind,
            decisionId: lease.decisionId,
            disposition,
            anchorIssueId: lease.anchorIssueId,
          },
        }).catch(() => {});
      }
    } catch (error) {
      logger.warn({ err: error, leaseId: lease.id }, "orphaned decision lease sweep failed for lease");
    }
  }

  return { scanned: leases.length, resolved };
}

/**
 * Kill-switch startup rule (R3.5): the switch resolves, never abandons.
 * `PAPERCLIP_DECISION_FREEZE_DISABLED=1` with any active/revising lease
 * refuses startup with a clear message unless
 * `PAPERCLIP_DECISION_FREEZE_DISABLED_RESOLVE_ALL=1` is also set, in which
 * case every lease is resolved as operator_override (continuation + one loud
 * activity each) before the server continues.
 */
export async function enforceDecisionFreezeKillSwitch(
  db: DbLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ state: "inactive" | "clear" | "bulk_resolved"; resolvedLeaseIds: string[] }> {
  if (env.PAPERCLIP_DECISION_FREEZE_DISABLED !== "1") {
    return { state: "inactive", resolvedLeaseIds: [] };
  }
  const leases = await db
    .select()
    .from(decisionLeases)
    .where(inArray(decisionLeases.state, [...FROZEN_LEASE_STATES]))
    .orderBy(asc(decisionLeases.createdAt), asc(decisionLeases.id));
  if (leases.length === 0) {
    return { state: "clear", resolvedLeaseIds: [] };
  }
  if (env.PAPERCLIP_DECISION_FREEZE_DISABLED_RESOLVE_ALL !== "1") {
    throw new Error(
      `Refusing to start: PAPERCLIP_DECISION_FREEZE_DISABLED=1 but ${leases.length} decision lease(s) are `
      + "active/revising. Disabling the freeze while leases are live would re-wake already-frozen work without "
      + "resolving the decisions. Either unset PAPERCLIP_DECISION_FREEZE_DISABLED, release the leases via "
      + "POST /api/decision-leases/:id/release, or also set PAPERCLIP_DECISION_FREEZE_DISABLED_RESOLVE_ALL=1 "
      + "to bulk-resolve every lease as operator_override at startup.",
    );
  }
  const resolvedLeaseIds: string[] = [];
  for (const lease of leases) {
    const payload = await buildContinuationPayloadForLease(db, lease, "operator_override");
    const outcome = await resolveLease(db, lease.id, "operator_override", { payload });
    if (!outcome.applied) continue;
    resolvedLeaseIds.push(lease.id);
    await logActivity(db, {
      companyId: lease.companyId,
      actorType: "system",
      actorId: "decision_freeze_kill_switch",
      action: "decision_lease.operator_override_released",
      entityType: "decision_lease",
      entityId: lease.id,
      details: {
        reason: "kill_switch_bulk_resolve",
        decisionKind: lease.decisionKind,
        decisionId: lease.decisionId,
        anchorIssueId: lease.anchorIssueId,
        disposition: "operator_override",
      },
    }).catch(() => {});
  }
  return { state: "bulk_resolved", resolvedLeaseIds };
}

function isEquivalentApprovalCreate(
  existing: typeof approvals.$inferSelect,
  input: {
    type: string;
    payload: Record<string, unknown>;
    requestedByAgentId: string | null;
    requestedByUserId: string | null;
  },
): boolean {
  return (
    existing.type === input.type
    && (existing.requestedByAgentId ?? null) === (input.requestedByAgentId ?? null)
    && (existing.requestedByUserId ?? null) === (input.requestedByUserId ?? null)
    && isDeepStrictEqual(existing.payload ?? {}, input.payload ?? {})
  );
}

export type CreateApprovalDecisionInput = {
  companyId: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
  issueIds: string[];
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  requestingRunId?: string | null;
  decisionLease?: {
    idempotencyKey: string;
    posture: { status: "in_review"; comment: string };
  } | null;
};

export type CreateApprovalDecisionResult = {
  approval: typeof approvals.$inferSelect;
  lease: DecisionLeaseRow | null;
  applied: boolean;
  linkedIssueIds: string[];
  runIdsToInterrupt: string[];
};

async function findOpenApprovalByKey(dbOrTx: DbLike, companyId: string, idempotencyKey: string) {
  return dbOrTx
    .select()
    .from(approvals)
    .where(and(
      eq(approvals.companyId, companyId),
      eq(approvals.idempotencyKey, idempotencyKey),
      inArray(approvals.status, ["pending", "revision_requested"]),
    ))
    .then((rows) => rows[0] ?? null);
}

async function buildApprovalReplayResult(
  dbOrTx: DbLike,
  existing: typeof approvals.$inferSelect,
  input: CreateApprovalDecisionInput,
): Promise<CreateApprovalDecisionResult> {
  if (!isEquivalentApprovalCreate(existing, {
    type: input.type,
    payload: input.payload,
    requestedByAgentId: input.requestedByAgentId,
    requestedByUserId: input.requestedByUserId,
  })) {
    throw conflict("Approval idempotency key already exists for a different request", {
      idempotencyKey: existing.idempotencyKey,
      approvalId: existing.id,
    });
  }
  const lease = await findDecisionLeaseForDecision(dbOrTx, {
    decisionKind: "approval",
    decisionId: existing.id,
    companyId: existing.companyId,
    anyState: true,
  });
  const linkedIssueIds = await dbOrTx
    .select({ issueId: issueApprovals.issueId })
    .from(issueApprovals)
    .where(eq(issueApprovals.approvalId, existing.id))
    .orderBy(asc(issueApprovals.createdAt))
    .then((rows) => rows.map((row) => row.issueId));
  return { approval: existing, lease, applied: false, linkedIssueIds, runIdsToInterrupt: [] };
}

/**
 * Decision-create in ONE transaction (R3.2): approval row (idempotent), issue
 * links, waiting posture, cone members, lease + drain. Ten concurrent
 * identical requests yield one approval + one lease; the nine losers get the
 * equivalent-replay result (`applied: false`) with zero side effects; a
 * same-key different-payload request conflicts (409).
 */
export async function createApprovalDecision(
  db: DbLike,
  input: CreateApprovalDecisionInput,
): Promise<CreateApprovalDecisionResult> {
  const uniqueIssueIds = [...new Set(input.issueIds)];
  const approvalIdempotencyKey = input.decisionLease?.idempotencyKey ?? input.idempotencyKey ?? null;
  if (input.decisionLease && uniqueIssueIds.length === 0) {
    throw unprocessable("decisionLease requires at least one linked issue (the first is the lease anchor)");
  }

  if (approvalIdempotencyKey) {
    const existing = await findOpenApprovalByKey(db, input.companyId, approvalIdempotencyKey);
    if (existing) return buildApprovalReplayResult(db, existing, input);
  }

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbLike;
    const now = new Date();
    const [inserted] = await tx
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: input.type,
        payload: input.payload,
        status: "pending",
        idempotencyKey: approvalIdempotencyKey,
        requestedByAgentId: input.requestedByAgentId,
        requestedByUserId: input.requestedByUserId,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      // A concurrent identical create won the partial unique; replay against
      // the winner (blocks until its transaction settles, then reads it).
      const winner = approvalIdempotencyKey
        ? await findOpenApprovalByKey(tx, input.companyId, approvalIdempotencyKey)
        : null;
      if (!winner) {
        throw conflict("Approval idempotency key already exists for a different request", {
          idempotencyKey: approvalIdempotencyKey,
        });
      }
      return buildApprovalReplayResult(tx, winner, input);
    }

    if (uniqueIssueIds.length > 0) {
      const rows = await tx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(inArray(issues.id, uniqueIssueIds));
      if (rows.length !== uniqueIssueIds.length) {
        throw notFound("One or more issues not found");
      }
      for (const row of rows) {
        if (row.companyId !== input.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
      }
      await tx
        .insert(issueApprovals)
        .values(uniqueIssueIds.map((issueId) => ({
          companyId: input.companyId,
          issueId,
          approvalId: inserted.id,
          linkedByAgentId: input.requestedByAgentId,
          linkedByUserId: input.requestedByUserId,
        })))
        .onConflictDoNothing();
    }

    let lease: DecisionLeaseRow | null = null;
    let runIdsToInterrupt: string[] = [];
    if (input.decisionLease) {
      const leaseResult = await createLeaseForDecision(tx, {
        companyId: input.companyId,
        decisionKind: "approval",
        decisionId: inserted.id,
        idempotencyKey: input.decisionLease.idempotencyKey,
        anchorIssueId: uniqueIssueIds[0]!,
        posture: input.decisionLease.posture,
        requestingRunId: input.requestingRunId ?? null,
        requestedByAgentId: input.requestedByAgentId,
        requestedByUserId: input.requestedByUserId,
      });
      lease = leaseResult.lease;
      runIdsToInterrupt = leaseResult.runIdsToInterrupt;
    }

    return {
      approval: inserted,
      lease,
      applied: true,
      linkedIssueIds: uniqueIssueIds,
      runIdsToInterrupt,
    };
  });
}

/**
 * Shared approvals-side lease resolution (routes/approvals.ts + the Slack
 * decision path — R2.10). Returns null when the approval has no frozen lease
 * (non-lease approvals keep their existing wake behavior, documented PR-2a
 * deviation from full R2.10 unification). For terminal dispositions the
 * continuation is written and, best-effort, immediately dispatched through
 * the outbox (the scheduler sweep is the guaranteed path). For
 * `revision_requested` the bounded revision wake is sent post-commit.
 */
export async function resolveApprovalDecisionLease(
  db: DbLike,
  input: {
    approval: { id: string; companyId: string };
    disposition: DecisionDisposition;
    actorUserId: string;
    enqueueWakeup?: DecisionEnqueueWakeup | null;
    revisionEventId?: string | null;
    decisionNote?: string | null;
  },
): Promise<ResolveDecisionLeaseOutcome | null> {
  const lease = await findDecisionLeaseForDecision(db, {
    decisionKind: "approval",
    decisionId: input.approval.id,
    companyId: input.approval.companyId,
  });
  if (!lease) return null;

  const payload = await buildContinuationPayloadForLease(db, lease, input.disposition);
  const outcome = await resolveLease(db, lease.id, input.disposition, { payload });

  await logActivity(db, {
    companyId: input.approval.companyId,
    actorType: "user",
    actorId: input.actorUserId,
    action: "decision_lease.resolved",
    entityType: "decision_lease",
    entityId: lease.id,
    details: {
      approvalId: input.approval.id,
      requestedDisposition: input.disposition,
      disposition: outcome.disposition,
      applied: outcome.applied,
      anchorIssueId: lease.anchorIssueId,
    },
  }).catch(() => {});

  if (!outcome.applied) return outcome;

  if (input.disposition === "revision_requested") {
    if (input.enqueueWakeup) {
      await sendDecisionRevisionWake(db, { enqueueWakeup: input.enqueueWakeup }, {
        lease: outcome.lease,
        revisionEventId: input.revisionEventId ?? String(Date.now()),
        requestedByActorId: input.actorUserId,
        decisionNote: input.decisionNote ?? null,
      }).catch((err) => {
        logger.warn({ err, leaseId: lease.id }, "failed to enqueue decision revision wake");
      });
    }
    return outcome;
  }

  if (input.enqueueWakeup) {
    // Best-effort immediate delivery; the scheduler outbox sweep is the
    // guaranteed exactly-once path (CAS-consume makes both safe).
    await dispatchDecisionContinuations(db, { enqueueWakeup: input.enqueueWakeup }, { leaseId: lease.id })
      .catch((err) => {
        logger.warn({ err, leaseId: lease.id }, "immediate decision continuation dispatch failed; sweep will retry");
      });
  }
  return outcome;
}

/**
 * Interactions-side lease resolution: resolve the frozen lease bound to an
 * interaction with the mapped disposition (accepted→approved,
 * answered→approved, rejected→rejected, cancelled→cancelled,
 * expired→expired, dismissed→dismissed, stale_target→stale_target,
 * superseded→superseded_by_comment). Safe to call from inside the
 * interaction's own resolution transaction. No wake here — the outbox
 * dispatcher delivers.
 */
export async function resolveInteractionDecisionLease(
  dbOrTx: DbLike,
  input: {
    interactionId: string;
    companyId: string;
    disposition: TerminalDecisionDisposition;
  },
): Promise<ResolveDecisionLeaseOutcome | null> {
  const lease = await findDecisionLeaseForDecision(dbOrTx, {
    decisionKind: "interaction",
    decisionId: input.interactionId,
    companyId: input.companyId,
  });
  if (!lease) return null;
  const payload = await buildContinuationPayloadForLease(dbOrTx, lease, input.disposition);
  return resolveLease(dbOrTx, lease.id, input.disposition, { payload });
}

/**
 * Observability listing for GET /companies/:companyId/decision-leases.
 */
export async function listDecisionLeases(
  db: DbLike,
  companyId: string,
  opts: { state?: string | null; limit?: number } = {},
): Promise<Array<DecisionLeaseRow & { memberCount: number }>> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
  const conditions = [eq(decisionLeases.companyId, companyId)];
  if (opts.state) conditions.push(eq(decisionLeases.state, opts.state));
  const rows = await db
    .select({
      lease: decisionLeases,
      memberCount: sql<number>`(
        select count(*)::int from ${decisionLeaseMembers}
        where ${decisionLeaseMembers.leaseId} = ${decisionLeases.id}
      )`,
    })
    .from(decisionLeases)
    .where(and(...conditions))
    .orderBy(asc(decisionLeases.createdAt), asc(decisionLeases.id))
    .limit(limit);
  return rows.map((row) => ({ ...row.lease, memberCount: row.memberCount }));
}
