import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DEFAULT_RUN_TELEMETRY_WINDOW_HOURS = 24;
const MAX_RUN_TELEMETRY_WINDOW_HOURS = 168;
const DEFAULT_RUN_TELEMETRY_LIMIT = 500;
const MAX_RUN_TELEMETRY_LIMIT = 1_000;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function parseRunTelemetryWindowHours(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_RUN_TELEMETRY_WINDOW_HOURS;
  const value = raw.trim().toLowerCase();
  const match = /^(\d+)(h|d)?$/.exec(value);
  if (!match) return DEFAULT_RUN_TELEMETRY_WINDOW_HOURS;
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_RUN_TELEMETRY_WINDOW_HOURS;
  const hours = match[2] === "d" ? amount * 24 : amount;
  return Math.min(hours, MAX_RUN_TELEMETRY_WINDOW_HOURS);
}

export function parseRunTelemetryLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_RUN_TELEMETRY_LIMIT;
  const amount = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_RUN_TELEMETRY_LIMIT;
  return Math.min(amount, MAX_RUN_TELEMETRY_LIMIT);
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    runTelemetry: async (
      companyId: string,
      options: { windowHours?: number; limit?: number; now?: Date } = {},
    ) => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const now = options.now ?? new Date();
      const windowHours = Math.min(
        Math.max(1, options.windowHours ?? DEFAULT_RUN_TELEMETRY_WINDOW_HOURS),
        MAX_RUN_TELEMETRY_WINDOW_HOURS,
      );
      const limit = Math.min(
        Math.max(1, options.limit ?? DEFAULT_RUN_TELEMETRY_LIMIT),
        MAX_RUN_TELEMETRY_LIMIT,
      );
      const windowEnd = now;
      const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);

      const costByRun = db
        .select({
          heartbeatRunId: costEvents.heartbeatRunId,
          modelId: sql<string | null>`max(${costEvents.model})`.as("model_id"),
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`.as("input_tokens"),
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`.as("cached_input_tokens"),
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`.as("output_tokens"),
          estimatedCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`.as("estimated_cost_cents"),
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, windowStart),
          ),
        )
        .groupBy(costEvents.heartbeatRunId)
        .as("cost_by_run");

      const rows = await db
        .select({
          runId: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          modelId: costByRun.modelId,
          adapterRoute: agents.adapterType,
          status: heartbeatRuns.status,
          errorCategory: heartbeatRuns.errorCode,
          retryCount: heartbeatRuns.retryCount,
          processLossRetryCount: heartbeatRuns.processLossRetryCount,
          scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
          fallbackFrom: heartbeatRuns.fallbackFrom,
          fallbackTo: heartbeatRuns.fallbackTo,
          fallbackSuccess: heartbeatRuns.fallbackSuccess,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          taskType: issues.workMode,
          billingCode: issues.billingCode,
          inputTokens: costByRun.inputTokens,
          cachedInputTokens: costByRun.cachedInputTokens,
          outputTokens: costByRun.outputTokens,
          estimatedCostCents: costByRun.estimatedCostCents,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .leftJoin(issues, eq(issues.executionRunId, heartbeatRuns.id))
        .leftJoin(costByRun, eq(costByRun.heartbeatRunId, heartbeatRuns.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, windowStart),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(limit);

      return {
        companyId,
        generatedAt: now.toISOString(),
        windowHours,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        limit,
        runs: rows.map((row) => {
          const inputTokens = Number(row.inputTokens ?? 0);
          const cachedInputTokens = Number(row.cachedInputTokens ?? 0);
          const outputTokens = Number(row.outputTokens ?? 0);
          const estimatedCostCents = Number(row.estimatedCostCents ?? 0);
          const retryCount =
            Number(row.retryCount ?? 0) +
            Number(row.processLossRetryCount ?? 0) +
            Number(row.scheduledRetryAttempt ?? 0);
          const fallbackActivated = Boolean(row.fallbackFrom || row.fallbackTo);

          return {
            runId: row.runId,
            agentId: row.agentId,
            agentName: row.agentName,
            modelId: row.modelId ?? null,
            adapterRoute: row.adapterRoute,
            estimatedCostCents,
            estimatedCostUsd: Number((estimatedCostCents / 100).toFixed(6)),
            inputTokens,
            cachedInputTokens,
            outputTokens,
            totalTokens: inputTokens + cachedInputTokens + outputTokens,
            status: row.status,
            success: row.status === "succeeded",
            errorCategory: row.errorCategory ?? (row.status === "succeeded" ? null : row.status),
            retryCount,
            fallbackActivated,
            fallbackPath: fallbackActivated
              ? {
                  from: row.fallbackFrom ?? null,
                  to: row.fallbackTo ?? null,
                  success: row.fallbackSuccess ?? null,
                }
              : null,
            task: {
              issueId: row.issueId ?? null,
              issueIdentifier: row.issueIdentifier ?? null,
              taskType: row.taskType ?? null,
              billingCode: row.billingCode ?? null,
            },
            startedAt: row.startedAt?.toISOString() ?? null,
            finishedAt: row.finishedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      };
    },
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
