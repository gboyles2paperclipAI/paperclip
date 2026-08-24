import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns } from "@paperclipai/db";

/**
 * Usage-derived cost estimates for subscription-billed runs.
 *
 * The billing ledger (`cost_events.cost_cents`) records ACTUAL billed dollars,
 * and `subscription_included` usage bills zero marginal dollars by design
 * (doc/plans/2026-03-14-billing-ledger-and-reporting.md). On a fleet that runs
 * entirely on subscription auth this makes every budget surface — dashboard
 * month spend, per-agent/company `spentMonthlyCents`, and budget policy
 * enforcement — permanently zero while real usage happens, so budget guards
 * are vacuous.
 *
 * Adapters still report a usage-derived cost estimate for those runs
 * (`heartbeat_runs.usage_json.costUsd`). These helpers roll that estimate up
 * so budget surfaces can report effective spend = billed cents + estimated
 * subscription cents, without changing the ledger's billed-dollar semantics.
 *
 * Scope rules that keep billed and estimated cents disjoint (no double
 * counting):
 * - only `billing_type = 'subscription_included'` events are estimated; every
 *   other billing type already writes real billed cents to the ledger, and
 *   `subscription_overage` bills its overage dollars directly.
 * - only events whose ledger `cost_cents` is 0 are estimated, so an event
 *   that somehow carries billed cents is never counted twice.
 *
 * The estimate value comes from the linked run's `usage_json`, accepting the
 * key spellings adapters have historically used (`costUsd`, `cost_usd`,
 * `total_cost_usd`) and only when the value is a JSON number.
 */

const runEstimatedCostCentsCase = sql<number>`
  case
    when jsonb_typeof(coalesce(
      ${heartbeatRuns.usageJson} -> 'costUsd',
      ${heartbeatRuns.usageJson} -> 'cost_usd',
      ${heartbeatRuns.usageJson} -> 'total_cost_usd'
    )) = 'number'
    then round((coalesce(
      ${heartbeatRuns.usageJson} ->> 'costUsd',
      ${heartbeatRuns.usageJson} ->> 'cost_usd',
      ${heartbeatRuns.usageJson} ->> 'total_cost_usd'
    ))::numeric * 100)
    else 0
  end
`;

export const SUBSCRIPTION_ESTIMATED_BILLING_TYPES = ["subscription_included"] as const;

function subscriptionEstimateConditions(filters: {
  companyId?: string;
  companyIds?: string[];
  agentId?: string | null;
  agentIds?: string[];
  projectId?: string | null;
  from?: Date;
  to?: Date;
}): SQL[] {
  const conditions: SQL[] = [
    inArray(costEvents.billingType, [...SUBSCRIPTION_ESTIMATED_BILLING_TYPES]),
    eq(costEvents.costCents, 0),
  ];
  if (filters.companyId) conditions.push(eq(costEvents.companyId, filters.companyId));
  if (filters.companyIds) conditions.push(inArray(costEvents.companyId, filters.companyIds));
  if (filters.agentId) conditions.push(eq(costEvents.agentId, filters.agentId));
  if (filters.agentIds) conditions.push(inArray(costEvents.agentId, filters.agentIds));
  if (filters.projectId) conditions.push(eq(costEvents.projectId, filters.projectId));
  if (filters.from) conditions.push(gte(costEvents.occurredAt, filters.from));
  if (filters.to) conditions.push(lt(costEvents.occurredAt, filters.to));
  return conditions;
}

const estimatedCentsSum = sql<number>`coalesce(sum(${runEstimatedCostCentsCase}), 0)::double precision`;

/**
 * Total estimated subscription cents for one scope (company, optionally
 * narrowed to an agent or project) inside an optional [from, to) window.
 */
export async function sumEstimatedSubscriptionCents(
  db: Pick<Db, "select">,
  filters: {
    companyId: string;
    agentId?: string | null;
    projectId?: string | null;
    from?: Date;
    to?: Date;
  },
): Promise<number> {
  const [row] = await db
    .select({ estimated: estimatedCentsSum })
    .from(costEvents)
    .innerJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
    .where(and(...subscriptionEstimateConditions(filters)));
  return Number(row?.estimated ?? 0);
}

/** Per-agent estimated subscription cents inside an optional [from, to) window. */
export async function sumEstimatedSubscriptionCentsByAgent(
  db: Pick<Db, "select">,
  filters: { companyId: string; agentIds: string[]; from?: Date; to?: Date },
): Promise<Map<string, number>> {
  if (filters.agentIds.length === 0) return new Map();
  const rows = await db
    .select({
      agentId: costEvents.agentId,
      estimated: estimatedCentsSum,
    })
    .from(costEvents)
    .innerJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
    .where(
      and(
        ...subscriptionEstimateConditions({
          companyId: filters.companyId,
          agentIds: filters.agentIds,
          from: filters.from,
          to: filters.to,
        }),
      ),
    )
    .groupBy(costEvents.agentId);
  return new Map(rows.map((row) => [row.agentId, Number(row.estimated ?? 0)]));
}

/** Per-company estimated subscription cents inside an optional [from, to) window. */
export async function sumEstimatedSubscriptionCentsByCompany(
  db: Pick<Db, "select">,
  filters: { companyIds: string[]; from?: Date; to?: Date },
): Promise<Map<string, number>> {
  if (filters.companyIds.length === 0) return new Map();
  const rows = await db
    .select({
      companyId: costEvents.companyId,
      estimated: estimatedCentsSum,
    })
    .from(costEvents)
    .innerJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
    .where(
      and(
        ...subscriptionEstimateConditions({
          companyIds: filters.companyIds,
          from: filters.from,
          to: filters.to,
        }),
      ),
    )
    .groupBy(costEvents.companyId);
  return new Map(rows.map((row) => [row.companyId, Number(row.estimated ?? 0)]));
}
