import { and, asc, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisionLeaseMembers, decisionLeases, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/**
 * Decision-freeze guard (ADR-20260823-quiescent-coordination R2.1, R3.1, R3.8, R3.9).
 *
 * The gate is a MEMBERSHIP LOOKUP against `decision_lease_members` joined to
 * `decision_leases`, never the pause-hold ancestor walk
 * (`getActivePauseHoldGate`), and the pause-hold comment escape hatch
 * (`isVerifiedIssueTreeControlInteractionWake`) does not apply here (R2.1).
 * With empty tables every helper is a no-op: `getActiveDecisionFreeze` returns
 * null and can never 500 unrelated work (R3.8).
 */

/** Lease states that keep a decision cone frozen (R3.1: `revising` does NOT release). */
const FROZEN_DECISION_LEASE_STATES = ["active", "revising"] as const;

export type FrozenDecisionLeaseState = (typeof FROZEN_DECISION_LEASE_STATES)[number];

/** Error code for agent-actor writes and wake skips inside an active cone (R2.2/R3.3). */
export const DECISION_FREEZE_ACTIVE_ERROR_CODE = "decision_freeze_active";

/** Error code used by run scheduling/retry gates when the target issue is frozen. */
export const ISSUE_DECISION_FROZEN_ERROR_CODE = "issue_decision_frozen";

/**
 * Distinct result type from `ActiveIssueTreePauseHoldGate` (R2.1) — the two
 * guards are separate booleans and must never be merged into one check.
 */
export type ActiveDecisionFreeze = {
  leaseId: string;
  state: FrozenDecisionLeaseState;
  anchorIssueId: string;
};

type DbOrTx = Pick<Db, "select">;

/**
 * One indexed lookup: is this issue a member of any lease in a frozen state?
 * Empty tables return null (the PR-1 "dark" invariant, R3.8). A non-UUID
 * issue id can never be a member row, so it short-circuits to null instead of
 * failing the surrounding query with a cast error.
 */
export async function getActiveDecisionFreeze(
  dbOrTx: DbOrTx,
  companyId: string,
  issueId: string,
): Promise<ActiveDecisionFreeze | null> {
  if (!isUuidLike(issueId)) return null;
  const row = await dbOrTx
    .select({
      leaseId: decisionLeases.id,
      state: decisionLeases.state,
      anchorIssueId: decisionLeases.anchorIssueId,
    })
    .from(decisionLeaseMembers)
    .innerJoin(decisionLeases, eq(decisionLeases.id, decisionLeaseMembers.leaseId))
    .where(
      and(
        eq(decisionLeaseMembers.issueId, issueId),
        eq(decisionLeases.companyId, companyId),
        inArray(decisionLeases.state, [...FROZEN_DECISION_LEASE_STATES]),
      ),
    )
    .orderBy(asc(decisionLeases.createdAt), asc(decisionLeases.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  return {
    leaseId: row.leaseId,
    state: row.state === "revising" ? "revising" : "active",
    anchorIssueId: row.anchorIssueId,
  };
}

/**
 * Reusable `NOT EXISTS` fragment excluding active-cone members from pick-work
 * queries (R3.4). PR-1 wires it into `hasActionableTimerWork` only (dark);
 * inbox-lite/assignee-list/MCP-inbox sites follow in PR-2.
 */
export function decisionFreezeExclusionSql(issueIdExpr: SQLWrapper): SQL {
  return sql`not exists (
    select 1
    from ${decisionLeaseMembers}
    inner join ${decisionLeases} on ${decisionLeases.id} = ${decisionLeaseMembers.leaseId}
    where ${decisionLeaseMembers.issueId} = ${issueIdExpr}
      and ${decisionLeases.state} in ('active', 'revising')
  )`;
}

/**
 * Context bypass flags recognized by the wake guard (R3.1):
 * - `decisionContinuation: true` — outbox continuation delivery, always passes.
 * - `decisionRevisionWake: true` — passes only while the lease state is
 *   `revising` AND the wake target is the anchor issue's assignee agent.
 */
export async function evaluateDecisionFreezeWakeBypass(
  dbOrTx: DbOrTx,
  companyId: string,
  freeze: ActiveDecisionFreeze,
  input: {
    contextSnapshot: Record<string, unknown> | null | undefined;
    agentId?: string | null;
  },
): Promise<boolean> {
  const contextSnapshot = input.contextSnapshot ?? {};
  if (contextSnapshot.decisionContinuation === true) return true;
  if (contextSnapshot.decisionRevisionWake !== true) return false;
  if (freeze.state !== "revising") return false;
  const agentId = typeof input.agentId === "string" && input.agentId.length > 0 ? input.agentId : null;
  if (!agentId) return false;
  const anchor = await dbOrTx
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, freeze.anchorIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return Boolean(anchor?.assigneeAgentId && anchor.assigneeAgentId === agentId);
}

/**
 * Shared mutation-gate helper (R3.3): agent actors writing to a member of an
 * active cone get a 422 `decision_freeze_active`; board/user/system actors are
 * exempt (they are the deciders). The membership SELECT must run inside the
 * same transaction as the write it protects, so pass the transaction handle.
 * Defined and unit-tested in PR-1; wired into routes in PR-2.
 */
export async function assertNotDecisionFrozen(
  tx: DbOrTx,
  companyId: string,
  issueId: string,
  actorType: string | null | undefined,
): Promise<void> {
  if (actorType !== "agent") return;
  const freeze = await getActiveDecisionFreeze(tx, companyId, issueId);
  if (!freeze) return;
  throw unprocessable("Issue is inside an active decision freeze", {
    code: DECISION_FREEZE_ACTIVE_ERROR_CODE,
    issueId,
    leaseId: freeze.leaseId,
    anchorIssueId: freeze.anchorIssueId,
    leaseState: freeze.state,
  });
}
