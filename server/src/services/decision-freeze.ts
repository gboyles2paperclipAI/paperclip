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
 *
 * Pass `companyIdExpr` to scope the lease lookup to one company, matching
 * `getActiveDecisionFreeze` exactly. Callers that pair this fragment with the
 * company-scoped lookup MUST pass it, otherwise a lease in another company
 * can make the fragment and the lookup disagree (an exclusion "miss" that the
 * lookup reports as no-freeze). Omitting it keeps the historical unscoped
 * behavior for global scans.
 */
export function decisionFreezeExclusionSql(
  issueIdExpr: SQLWrapper,
  companyIdExpr?: SQLWrapper,
): SQL {
  const companyScope = companyIdExpr
    ? sql` and ${decisionLeases.companyId} = ${companyIdExpr}`
    : sql``;
  return sql`not exists (
    select 1
    from ${decisionLeaseMembers}
    inner join ${decisionLeases} on ${decisionLeases.id} = ${decisionLeaseMembers.leaseId}
    where ${decisionLeaseMembers.issueId} = ${issueIdExpr}
      and ${decisionLeases.state} in ('active', 'revising')${companyScope}
  )`;
}

/**
 * Internal freeze-bypass intent (R3.1). This is an explicit server-side option
 * on `enqueueWakeup` — it is NEVER read from a caller-supplied
 * `contextSnapshot`, so snapshot-stuffed JSON (routes, plugins, copied
 * payloads) cannot pierce a freeze:
 * - `kind: "continuation"` — outbox continuation delivery, always passes.
 * - `kind: "revision"` — passes only while the lease state is `revising` AND
 *   the wake target is the anchor issue's assignee agent.
 */
export type DecisionFreezeWakeBypass = {
  kind: "continuation" | "revision";
};

/**
 * Context key under which enqueueWakeup persists an ACCEPTED bypass kind so
 * claim-time / promotion-time re-checks can honor it. enqueueWakeup strips
 * this key from every caller-provided snapshot before stamping it, so its
 * presence in a run's contextSnapshot always means the server validated the
 * internal option — it can never originate from external JSON.
 */
export const DECISION_FREEZE_BYPASS_CONTEXT_KEY = "decisionFreezeBypassAccepted";

/** Parse the server-stamped bypass marker from a run/deferred context snapshot. */
export function readAcceptedDecisionFreezeBypass(
  contextSnapshot: Record<string, unknown> | null | undefined,
): DecisionFreezeWakeBypass | null {
  const value = contextSnapshot?.[DECISION_FREEZE_BYPASS_CONTEXT_KEY];
  if (value === "continuation" || value === "revision") return { kind: value };
  return null;
}

export async function evaluateDecisionFreezeWakeBypass(
  dbOrTx: DbOrTx,
  companyId: string,
  freeze: ActiveDecisionFreeze,
  input: {
    bypass: DecisionFreezeWakeBypass | null | undefined;
    agentId?: string | null;
  },
): Promise<boolean> {
  const kind = input.bypass?.kind;
  if (kind === "continuation") return true;
  if (kind !== "revision") return false;
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

/** One frozen membership row (an issue can be held by several leases — R2.8). */
export type ActiveDecisionFreezeMembership = ActiveDecisionFreeze & { issueId: string };

/**
 * All frozen (active/revising) lease memberships for a set of issues,
 * company-scoped (PR-2b: route mutation gate + edge-expansion/recompute hooks
 * in services/issues.ts). Empty tables / empty input return an empty array.
 * Deliberately two flat `select().from().where()` queries (membership rows,
 * then lease rows, ordered client-side) rather than a join, so the helper
 * stays compatible with every thin Db facade while behaving identically on
 * real Postgres.
 */
export async function listActiveDecisionFreezesForIssues(
  dbOrTx: DbOrTx,
  companyId: string,
  issueIds: readonly string[],
): Promise<ActiveDecisionFreezeMembership[]> {
  const candidates = [...new Set(issueIds)].filter((issueId) => isUuidLike(issueId));
  if (candidates.length === 0) return [];
  const memberRows = await dbOrTx
    .select({
      leaseId: decisionLeaseMembers.leaseId,
      issueId: decisionLeaseMembers.issueId,
    })
    .from(decisionLeaseMembers)
    .where(inArray(decisionLeaseMembers.issueId, candidates));
  if (memberRows.length === 0) return [];

  const leaseIds = [...new Set(memberRows.map((row) => row.leaseId))];
  const leaseRows = await dbOrTx
    .select({
      id: decisionLeases.id,
      state: decisionLeases.state,
      anchorIssueId: decisionLeases.anchorIssueId,
      createdAt: decisionLeases.createdAt,
    })
    .from(decisionLeases)
    .where(
      and(
        inArray(decisionLeases.id, leaseIds),
        eq(decisionLeases.companyId, companyId),
        inArray(decisionLeases.state, [...FROZEN_DECISION_LEASE_STATES]),
      ),
    );
  if (leaseRows.length === 0) return [];
  const leasesById = new Map(leaseRows.map((row) => [row.id, row]));

  return memberRows
    .filter((row) => leasesById.has(row.leaseId))
    .map((row) => {
      const lease = leasesById.get(row.leaseId)!;
      return {
        leaseId: lease.id,
        issueId: row.issueId,
        state: lease.state === "revising" ? "revising" as const : "active" as const,
        anchorIssueId: lease.anchorIssueId,
        createdAt: lease.createdAt,
      };
    })
    .sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime()
      || a.leaseId.localeCompare(b.leaseId)
      || a.issueId.localeCompare(b.issueId))
    .map(({ createdAt: _createdAt, ...membership }) => membership);
}

/**
 * Operations the anchor's assignee agent may perform ON THE ANCHOR ONLY while
 * the lease is in the `revising` substate (R3.1): comment, document PUT, and
 * resubmitting the same decision. All other members stay fully gated.
 */
export type DecisionFreezeRevisingOwnerOperation = "comment" | "document_put" | "resubmit";

/**
 * Route-facing mutation gate (R2.2/R3.1/R3.3). Same contract as
 * `assertNotDecisionFrozen` (agent actors 422 `decision_freeze_active`;
 * board/user/system exempt), plus the revising-owner exemption: when
 * `revisingOwnerOperation` is passed, the write is allowed if EVERY frozen
 * lease holding the issue is in state `revising`, anchored on this exact
 * issue, and the acting agent is the anchor's assignee. Overlapping leases
 * (R2.8) therefore keep the issue gated unless each one grants the exemption.
 */
export async function assertDecisionFreezeMutationAllowed(
  tx: DbOrTx,
  companyId: string,
  issueId: string,
  actor: { type: string | null | undefined; agentId?: string | null },
  opts: { revisingOwnerOperation?: DecisionFreezeRevisingOwnerOperation | null } = {},
): Promise<void> {
  if (actor.type !== "agent") return;
  const freezes = await listActiveDecisionFreezesForIssues(tx, companyId, [issueId]);
  if (freezes.length === 0) return;

  const agentId = typeof actor.agentId === "string" && actor.agentId.length > 0 ? actor.agentId : null;
  if (
    opts.revisingOwnerOperation
    && agentId
    && freezes.every((freeze) => freeze.state === "revising" && freeze.anchorIssueId === issueId)
  ) {
    const anchor = await tx
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (anchor?.assigneeAgentId === agentId) return;
  }

  const blocking = freezes[0]!;
  throw unprocessable("Issue is inside an active decision freeze", {
    code: DECISION_FREEZE_ACTIVE_ERROR_CODE,
    issueId,
    leaseId: blocking.leaseId,
    anchorIssueId: blocking.anchorIssueId,
    leaseState: blocking.state,
  });
}
