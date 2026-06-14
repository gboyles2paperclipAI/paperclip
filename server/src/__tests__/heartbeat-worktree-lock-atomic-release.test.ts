/**
 * Tests for FUL-11176: worktree path lock must be released atomically on run terminal state.
 *
 * Validates two fixes:
 *   1. setRunStatus with { releaseIssueLock: true } clears issues.executionRunId in the
 *      same DB transaction as the terminal status write, preventing zombie locks across
 *      server restarts.
 *   2. sweepStaleIssueLocks now clears a stale executionRunId independently of
 *      checkoutRunId — previously it skipped issues where checkoutRunId was live even
 *      when executionRunId alone was terminal.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});
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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping worktree lock atomic release tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("worktree path lock atomic release (FUL-11176)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-lock-atomic-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.execute(sql.raw(`
          TRUNCATE TABLE
            "company_skills",
            "issue_comments",
            "issue_documents",
            "document_revisions",
            "documents",
            "issue_relations",
            "issue_tree_holds",
            "execution_workspaces",
            "issues",
            "projects",
            "heartbeat_run_events",
            "activity_log",
            "heartbeat_runs",
            "agent_wakeup_requests",
            "agent_runtime_state",
            "agents",
            "companies"
          RESTART IDENTITY CASCADE
        `));
        break;
      } catch (err) {
        if (attempt === 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds two issues sharing one execution workspace:
   *  - holderIssue: in_progress, holding the workspace via executionRunId → holderRun (running)
   *  - waiterIssue: in_progress, same workspace, queued run waiting for the workspace to free
   */
  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const holderIssueId = randomUUID();
    const waiterIssueId = randomUUID();
    const holderWakeId = randomUUID();
    const holderRunId = randomUUID();
    const waiterWakeId = randomUUID();
    const waiterRunId = randomUUID();
    const now = new Date("2026-06-14T10:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Help2day",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PlatformAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });

    await db.insert(projects).values({ id: projectId, companyId, name: "Deploy Project" });

    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared",
      strategyType: "git_worktree",
      name: "_deploy",
    });

    // Holder: active run holds the workspace.
    // status: "done" is intentional — prevents releaseIssueExecutionAndPromote from creating
    // a recovery run after cancelRun, so holderIssue.executionRunId is null after the atomic
    // clear, not overwritten by a new recovery run ID.
    await db.insert(agentWakeupRequests).values({
      id: holderWakeId, companyId, agentId,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: holderIssueId }, status: "claimed", runId: holderRunId, claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId, companyId, agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "running",
      wakeupRequestId: holderWakeId,
      contextSnapshot: { issueId: holderIssueId, wakeReason: "issue_assigned" },
      startedAt: now, updatedAt: now,
    });
    await db.insert(issues).values({
      id: holderIssueId, companyId,
      title: "Holder issue — holds workspace", status: "done", priority: "high",
      assigneeAgentId: agentId, projectId,
      executionWorkspaceId: workspaceId, executionRunId: holderRunId,
      issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: now,
    });

    // Waiter: queued run waiting for the workspace
    await db.insert(agentWakeupRequests).values({
      id: waiterWakeId, companyId, agentId,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: waiterIssueId }, status: "queued", runId: waiterRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: waiterRunId, companyId, agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      wakeupRequestId: waiterWakeId,
      contextSnapshot: { issueId: waiterIssueId, wakeReason: "issue_assigned" },
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: waiterIssueId, companyId,
      title: "Waiter issue — starts after holder releases", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, projectId,
      executionWorkspaceId: workspaceId, executionRunId: null,
      issueNumber: 2, identifier: `${issuePrefix}-2`, startedAt: now,
    });

    return { companyId, agentId, projectId, workspaceId, holderIssueId, holderRunId, holderWakeId, waiterIssueId, waiterRunId, waiterWakeId };
  }

  it("cancelRun releases issues.executionRunId atomically with heartbeatRuns.status", async () => {
    const { holderIssueId, holderRunId } = await seedFixture();

    await heartbeat.cancelRun(holderRunId, "Test cancellation");

    const [runRow, issueRow] = await Promise.all([
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId)).then((r) => r[0] ?? null),
      db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, holderIssueId)).then((r) => r[0] ?? null),
    ]);

    expect(runRow?.status).toBe("cancelled");
    // The cancelled run must NOT remain as executionRunId — that would be the zombie
    // lock state the atomic transaction prevents. executionRunId is either null (cleared
    // atomically) or points to a new recovery run, but never to the now-terminal holderRunId.
    expect(issueRow?.executionRunId).not.toBe(holderRunId);
  });

  it("waiter run is deferred while holder holds workspace, then starts after holder is cancelled", async () => {
    const { companyId, agentId, holderIssueId, holderRunId, waiterIssueId, waiterRunId } = await seedFixture();

    // 1. Waiter is deferred while holder run is active.
    await heartbeat.resumeQueuedRuns();
    const deferred = await waitForCondition(async () => {
      const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, waiterRunId)).then((r) => r[0] ?? null);
      return run?.status === "skipped";
    });
    expect(deferred).toBe(true);

    const deferredRun = await db
      .select({ errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, waiterRunId))
      .then((r) => r[0] ?? null);
    expect(deferredRun?.errorCode).toBe("workspace_held_deferred");

    // 2. Cancel holder — atomically releases the workspace lock.
    // The holder issue has status "done", so releaseIssueExecutionAndPromote does NOT create
    // a recovery run. executionRunId is cleared to null by the atomic transaction.
    await heartbeat.cancelRun(holderRunId, "Holder done");

    // Verify the atomic clear: executionRunId is null (no zombie, no recovery run).
    const holderIssueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, holderIssueId))
      .then((r) => r[0] ?? null);
    expect(holderIssueRow?.executionRunId).toBeNull();

    // 3. Queue a fresh run for the waiter issue (reconciler would do this in prod).
    const newRunId = randomUUID();
    const newWakeId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: newWakeId, companyId, agentId,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: waiterIssueId }, status: "queued", runId: newRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: newRunId, companyId, agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      wakeupRequestId: newWakeId,
      contextSnapshot: { issueId: waiterIssueId, wakeReason: "issue_assigned" },
      updatedAt: now,
    });

    // 4. Resume — workspace lock is released, waiter run must start.
    await heartbeat.resumeQueuedRuns();

    const started = await waitForCondition(async () => {
      const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, newRunId)).then((r) => r[0] ?? null);
      const s = run?.status;
      return s === "running" || s === "succeeded" || s === "failed" || s === "cancelled";
    });
    expect(started).toBe(true);

    const newRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, newRunId))
      .then((r) => r[0] ?? null);
    // Must NOT be deferred — the workspace lock was released atomically on cancel.
    expect(newRun?.errorCode).not.toBe("workspace_held_deferred");
    expect(newRun?.status).not.toBe("skipped");
  });

  it("sweepStaleIssueLocks clears stale executionRunId even when checkoutRunId is still live", async () => {
    const { companyId, agentId, holderIssueId, holderRunId } = await seedFixture();

    // Simulate crash: holder run reached terminal state but executionRunId was NOT cleared
    // (the gap between setRunStatus and releaseIssueExecutionAndPromote that FUL-11176 fixes).
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));

    // Stamp a LIVE checkoutRunId on the same issue to reproduce the old GC skip bug:
    // old sweep skipped issues where checkoutRunId pointed at a live run, leaving
    // the zombie executionRunId in place indefinitely.
    const liveCheckoutRunId = randomUUID();
    const liveCheckoutWakeId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: liveCheckoutWakeId, companyId, agentId,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: holderIssueId }, status: "claimed", runId: liveCheckoutRunId, claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: liveCheckoutRunId, companyId, agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "running",
      wakeupRequestId: liveCheckoutWakeId,
      contextSnapshot: { issueId: holderIssueId, wakeReason: "issue_assigned" },
      startedAt: now, updatedAt: now,
    });
    await db.update(issues).set({ checkoutRunId: liveCheckoutRunId }).where(eq(issues.id, holderIssueId));

    // Now: holderIssue has executionRunId → terminal holderRun, checkoutRunId → live run.
    // Old sweep: skips the issue. New sweep: clears executionRunId independently.
    const swept = await heartbeat.sweepStaleIssueLocks();

    expect(swept.cleared).toBeGreaterThanOrEqual(1);
    expect(swept.issueIds).toContain(holderIssueId);

    const issueRow = await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, holderIssueId))
      .then((r) => r[0] ?? null);

    expect(issueRow?.executionRunId).toBeNull();                // zombie cleared
    expect(issueRow?.checkoutRunId).toBe(liveCheckoutRunId);   // live checkout preserved
  });
});
