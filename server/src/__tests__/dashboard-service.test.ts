import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  dashboardService,
  getUtcMonthStart,
  parseRunTelemetryLimit,
  parseRunTelemetryWindowHours,
} from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describe("run telemetry query parsing", () => {
  it("accepts 24h windows and caps unbounded requests", () => {
    expect(parseRunTelemetryWindowHours("24h")).toBe(24);
    expect(parseRunTelemetryWindowHours("2d")).toBe(48);
    expect(parseRunTelemetryWindowHours("999d")).toBe(168);
    expect(parseRunTelemetryWindowHours("invalid")).toBe(24);
    expect(parseRunTelemetryLimit("25")).toBe(25);
    expect(parseRunTelemetryLimit("99999")).toBe(1000);
    expect(parseRunTelemetryLimit("invalid")).toBe(500);
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      other: 0,
      total: 105,
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      other: 1,
      total: 3,
    });
  });

  it("returns per-run model, adapter, cost, retry, fallback, and task telemetry", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-07-07T07:00:00.000Z");

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Help2day",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Backend Lead",
        role: "lead",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other Agent",
        role: "lead",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        retryCount: 1,
        processLossRetryCount: 1,
        scheduledRetryAttempt: 1,
        fallbackFrom: "claude_local",
        fallbackTo: "codex_local",
        fallbackSuccess: true,
        errorCode: "adapter_failed",
        stdoutExcerpt: "raw output should not be returned",
        stderrExcerpt: "raw error should not be returned",
        createdAt: new Date("2026-07-07T06:30:00.000Z"),
        startedAt: new Date("2026-07-07T06:30:10.000Z"),
        finishedAt: new Date("2026-07-07T06:31:00.000Z"),
      },
      {
        id: otherRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date("2026-07-07T06:45:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expose telemetry",
      status: "in_progress",
      priority: "high",
      workMode: "standard",
      billingCode: "backend",
      executionRunId: runId,
      identifier: "FUL-15554",
    });

    await db.insert(costEvents).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        issueId,
        heartbeatRunId: runId,
        provider: "openai",
        biller: "api",
        billingType: "tokens",
        model: "gpt-5-codex",
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 300,
        costCents: 42,
        occurredAt: new Date("2026-07-07T06:31:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        heartbeatRunId: otherRunId,
        provider: "anthropic",
        biller: "api",
        billingType: "tokens",
        model: "claude-sonnet",
        inputTokens: 9000,
        outputTokens: 9000,
        costCents: 999,
        occurredAt: new Date("2026-07-07T06:45:00.000Z"),
      },
    ]);

    const telemetry = await dashboardService(db).runTelemetry(companyId, {
      windowHours: 24,
      now,
    });

    expect(telemetry).toMatchObject({
      companyId,
      windowHours: 24,
      windowStart: "2026-07-06T07:00:00.000Z",
      windowEnd: "2026-07-07T07:00:00.000Z",
    });
    expect(telemetry.runs).toHaveLength(1);
    expect(telemetry.runs[0]).toMatchObject({
      runId,
      agentId,
      agentName: "Backend Lead",
      modelId: "gpt-5-codex",
      adapterRoute: "codex_local",
      estimatedCostCents: 42,
      estimatedCostUsd: 0.42,
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 300,
      totalTokens: 1500,
      status: "failed",
      success: false,
      errorCategory: "adapter_failed",
      retryCount: 3,
      fallbackActivated: true,
      fallbackPath: {
        from: "claude_local",
        to: "codex_local",
        success: true,
      },
      task: {
        issueId,
        issueIdentifier: "FUL-15554",
        taskType: "standard",
        billingCode: "backend",
      },
      startedAt: "2026-07-07T06:30:10.000Z",
      finishedAt: "2026-07-07T06:31:00.000Z",
      createdAt: "2026-07-07T06:30:00.000Z",
    });
    expect(JSON.stringify(telemetry.runs[0])).not.toContain("raw output should not be returned");
    expect(JSON.stringify(telemetry.runs[0])).not.toContain("raw error should not be returned");
  });
});
