import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  decisionLeaseMembers,
  decisionLeases,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Claim-time zero-row freeze cancel must re-check that the run was the
 * legitimate stamper (verify round 2, Finding 11).
 *
 * The race under test: the claim transaction's freeze pre-check (membership
 * SELECT) sees no lease, a lease commits in the SELECT-to-UPDATE window, and
 * the stamp UPDATE returns zero rows. The window is between two statements of
 * one transaction, so the test reproduces it deterministically by suppressing
 * exactly one `getActiveDecisionFreeze` call — the claim pre-check — while a
 * real lease is already committed. Every other call passes through to the
 * real implementation.
 */
const freezePreCheckSuppression = vi.hoisted(() => ({
  target: null as { companyId: string; issueId: string } | null,
  consumed: 0,
}));

vi.mock("../services/decision-freeze.js", async () => {
  const actual = await vi.importActual<typeof import("../services/decision-freeze.js")>(
    "../services/decision-freeze.js",
  );
  const suppressibleGetActiveDecisionFreeze: typeof actual.getActiveDecisionFreeze = async (
    dbOrTx,
    companyId,
    issueId,
  ) => {
    const target = freezePreCheckSuppression.target;
    if (target && target.companyId === companyId && target.issueId === issueId) {
      freezePreCheckSuppression.target = null;
      freezePreCheckSuppression.consumed += 1;
      return null;
    }
    return actual.getActiveDecisionFreeze(dbOrTx, companyId, issueId);
  };
  return {
    ...actual,
    getActiveDecisionFreeze: suppressibleGetActiveDecisionFreeze,
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Claim lock-holder re-check test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const { heartbeatService, waitForAllHeartbeatRunExecutionsDrain } = await import(
  "../services/heartbeat.ts"
);
const { runningProcesses } = await import("../adapters/index.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres claim lock-holder tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("claim-time late-freeze lock-holder re-check", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claim-lock-holder-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    freezePreCheckSuppression.target = null;
    freezePreCheckSuppression.consumed = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await waitForAllHeartbeatRunExecutionsDrain({ timeoutMs: 15_000 });
    runningProcesses.clear();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(decisionLeaseMembers);
        await db.delete(decisionLeases);
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const assigneeAgentId = await seedAgent(companyId, "AssigneeAgent");
    const mentionAgentId = await seedAgent(companyId, "MentionAgent");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Frozen cone member",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, assigneeAgentId, mentionAgentId, issueId };
  }

  async function seedActiveLease(companyId: string, issueId: string) {
    const leaseId = randomUUID();
    await db.insert(decisionLeases).values({
      id: leaseId,
      companyId,
      decisionKind: "approval",
      decisionId: randomUUID(),
      decisionIdempotencyKey: `decision:${issueId}:test:${leaseId}`,
      anchorIssueId: issueId,
      state: "active",
    });
    await db.insert(decisionLeaseMembers).values([{ leaseId, issueId }]);
    return leaseId;
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
    reason: string;
  }) {
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.contextSnapshot.issueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      responsibleUserId: "responsible-user",
      contextSnapshot: input.contextSnapshot,
    });
    return runId;
  }

  async function getRunRow(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function waitForTerminalRun(runId: string) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const run = await getRunRow(runId);
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return getRunRow(runId);
  }

  async function claimFreezeInterruptActivities() {
    const rows = await db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.decision_freeze_run_interrupted"));
    return rows.filter(
      (row) => (row.details as Record<string, unknown> | null)?.source === "heartbeat.claim_queued_run",
    );
  }

  it("a non-assignee mention run hitting zero rows during a late freeze is NOT cancelled as frozen", async () => {
    const { companyId, mentionAgentId, issueId } = await seedFixture();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "responsible-user",
      authorType: "user",
      body: "@MentionAgent please take a look",
    });
    const runId = await seedQueuedRun({
      companyId,
      agentId: mentionAgentId,
      reason: "issue_comment_mentioned",
      contextSnapshot: {
        issueId,
        wakeReason: "issue_comment_mentioned",
        commentId,
        wakeCommentId: commentId,
      },
    });
    await seedActiveLease(companyId, issueId);

    // Hide the committed lease from exactly one lookup — the claim pre-check —
    // so the claim reaches the stamp UPDATE believing no freeze exists, then
    // reads zero rows with the (real) late freeze visible.
    freezePreCheckSuppression.target = { companyId, issueId };

    await heartbeat.resumeQueuedRuns();
    const run = await waitForTerminalRun(runId);

    // The suppressed lookup was consumed by the claim pre-check, so the
    // zero-row + late-freeze window was really exercised.
    expect(freezePreCheckSuppression.consumed).toBe(1);

    // Pre-fix code cancelled this run as issue_decision_frozen. The mention
    // run was never the legitimate stamper (assignee differs), so the freeze
    // blocked nothing it was entitled to do: the run proceeds and completes.
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(await claimFreezeInterruptActivities()).toHaveLength(0);

    // The execution lock is untouched — a mention run never stamps it.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBeNull();
  });

  it("the legitimate stamper (assignee, lock free) is still cancelled when the freeze lands late", async () => {
    const { companyId, assigneeAgentId, issueId } = await seedFixture();
    const runId = await seedQueuedRun({
      companyId,
      agentId: assigneeAgentId,
      reason: "issue_assigned",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await seedActiveLease(companyId, issueId);

    freezePreCheckSuppression.target = { companyId, issueId };

    await heartbeat.resumeQueuedRuns();
    const run = await waitForTerminalRun(runId);

    expect(freezePreCheckSuppression.consumed).toBe(1);

    // Assignee matches and the lock was free, so only the freeze can explain
    // the zero-row stamp: the cancel path must still fire.
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_decision_frozen");
    expect(await claimFreezeInterruptActivities()).toHaveLength(1);

    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBeNull();
  });
});
