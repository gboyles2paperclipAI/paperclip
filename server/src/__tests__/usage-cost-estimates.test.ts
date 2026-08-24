import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  sumEstimatedSubscriptionCents,
  sumEstimatedSubscriptionCentsByAgent,
} from "../services/usage-cost-estimates.ts";
import { costService } from "../services/costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres usage cost estimate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("usage-derived subscription cost estimates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-cost-estimates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(overrides: { budgetMonthlyCents?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: overrides.budgetMonthlyCents ?? 50_000,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    usageJson: Record<string, unknown> | null,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      usageJson,
    });
    return runId;
  }

  function subscriptionEvent(input: {
    companyId: string;
    agentId: string;
    heartbeatRunId: string | null;
    costCents?: number;
    billingType?: string;
    occurredAt?: Date;
  }) {
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      heartbeatRunId: input.heartbeatRunId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: input.billingType ?? "subscription_included",
      model: "claude-test",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costCents: input.costCents ?? 0,
      occurredAt: input.occurredAt ?? new Date(),
    };
  }

  it("estimates only zero-billed subscription events from their run's reported costUsd", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    const subscriptionRun = await seedRun(companyId, agentId, {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 12.34,
      billingType: "subscription_included",
    });
    // Metered run: the ledger already bills these dollars, so the estimate
    // must not count them again.
    const meteredRun = await seedRun(companyId, agentId, {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 5,
      billingType: "metered_api",
    });
    // Malformed usage: a string costUsd must be ignored, not crash the sum.
    const malformedRun = await seedRun(companyId, agentId, {
      costUsd: "not-a-number",
      billingType: "subscription_included",
    });
    // Legacy key spelling still counts.
    const legacyKeyRun = await seedRun(companyId, agentId, {
      total_cost_usd: 0.66,
      billingType: "subscription_included",
    });

    await db.insert(costEvents).values([
      subscriptionEvent({ companyId, agentId, heartbeatRunId: subscriptionRun }),
      subscriptionEvent({
        companyId,
        agentId,
        heartbeatRunId: meteredRun,
        billingType: "metered_api",
        costCents: 500,
      }),
      subscriptionEvent({ companyId, agentId, heartbeatRunId: malformedRun }),
      subscriptionEvent({ companyId, agentId, heartbeatRunId: legacyKeyRun }),
      // A subscription event that somehow carries billed cents must not be
      // double counted through the estimate path.
      subscriptionEvent({
        companyId,
        agentId,
        heartbeatRunId: subscriptionRun,
        costCents: 42,
      }),
      // No linked run means no usage to estimate from.
      subscriptionEvent({ companyId, agentId, heartbeatRunId: null }),
    ]);

    const estimated = await sumEstimatedSubscriptionCents(db, { companyId });
    expect(estimated).toBe(1234 + 66);

    const byAgent = await sumEstimatedSubscriptionCentsByAgent(db, {
      companyId,
      agentIds: [agentId],
    });
    expect(byAgent.get(agentId)).toBe(1234 + 66);
  });

  it("respects the [from, to) window on the event's occurredAt", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, {
      costUsd: 10,
      billingType: "subscription_included",
    });
    const lastMonthRun = await seedRun(companyId, agentId, {
      costUsd: 99,
      billingType: "subscription_included",
    });

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const beforeWindow = new Date(monthStart.getTime() - 24 * 60 * 60 * 1000);

    await db.insert(costEvents).values([
      subscriptionEvent({ companyId, agentId, heartbeatRunId: runId, occurredAt: now }),
      subscriptionEvent({
        companyId,
        agentId,
        heartbeatRunId: lastMonthRun,
        occurredAt: beforeWindow,
      }),
    ]);

    const estimated = await sumEstimatedSubscriptionCents(db, {
      companyId,
      from: monthStart,
    });
    expect(estimated).toBe(1000);
  });

  it("persists estimate-inclusive month spend to the agent and company columns on createEvent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 12.34,
      billingType: "subscription_included",
    });

    const costs = costService(db);
    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-test",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costCents: 0,
      occurredAt: new Date(),
    });

    const agentRow = await db
      .select({ spentMonthlyCents: agents.spentMonthlyCents })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    const companyRow = await db
      .select({ spentMonthlyCents: companies.spentMonthlyCents })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]);

    expect(agentRow?.spentMonthlyCents).toBe(1234);
    expect(companyRow?.spentMonthlyCents).toBe(1234);
  });

  it("budget hard stop triggers on estimated subscription spend and stamps the pause", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 12.34,
      billingType: "subscription_included",
    });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      notifyEnabled: true,
      hardStopEnabled: true,
      isActive: true,
    });

    const costs = costService(db);
    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-test",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costCents: 0,
      occurredAt: new Date(),
    });

    const agentRow = await db
      .select({
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);

    expect(agentRow?.status).toBe("paused");
    expect(agentRow?.pauseReason).toBe("budget");
    expect(agentRow?.pausedAt).toBeInstanceOf(Date);

    const incidents = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(incidents.some((incident) => incident.thresholdType === "hard")).toBe(true);
  });
});
