/**
 * Tests for FUL-11158: worktree-held startup refusals should defer (skipped/deferred),
 * not mark the agent as error.
 *
 * Scenario (Kelly/FUL-11077 class):
 *   1. Agent A (CTO) holds an active executionRunId on a shared execution workspace.
 *   2. Agent B (Kelly-KB) has a queued run for a different issue on the same workspace.
 *   3. When claimQueuedRun fires for Agent B's run, the workspace-held guard must
 *      skip the run cleanly: run status → "skipped", agent status → idle (not error),
 *      wakeup status → "skipped", activity log records the holder run id and issue id.
 *   4. The adapter is never invoked — no agent failure occurs.
 *   5. When the holder run finishes (executionRunId cleared), a subsequent
 *      resumeQueuedRuns cycle can proceed normally.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
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
    `Skipping workspace-held startup skip tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("claimQueuedRun — workspace-held startup skip (FUL-11158)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-held-startup-");
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
   * Seeds the minimal fixture for the Kelly/FUL-11077 startup-held race:
   *   - company + single agent
   *   - project + shared executionWorkspace
   *   - holder issue with an active running heartbeat run (holds the workspace)
   *   - Kelly issue linked to the same workspace, with a queued heartbeat run
   */
  async function seedStartupHoldFixture(opts: {
    holderRunStatus?: "running" | "queued" | "scheduled_retry";
    kellyIssueHasSameWorkspace?: boolean;
    createKellyQueued?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const holderIssueId = randomUUID();
    const kellyIssueId = randomUUID();
    const holderWakeId = randomUUID();
    const holderRunId = randomUUID();
    const kellyWakeId = randomUUID();
    const kellyRunId = randomUUID();
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
      name: "Kelly-KB",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Help2day Deploy",
    });

    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared",
      strategyType: "git_worktree",
      name: "deploy-branch",
    });

    // CTO holder wakeup + run (active, holds the workspace)
    await db.insert(agentWakeupRequests).values({
      id: holderWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: holderIssueId },
      status: "claimed",
      runId: holderRunId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderRunStatus ?? "running",
      wakeupRequestId: holderWakeId,
      contextSnapshot: { issueId: holderIssueId, wakeReason: "issue_assigned" },
      startedAt: now,
      updatedAt: now,
    });

    // CTO holder issue — in_progress, executionRunId stamped to the holder run
    await db.insert(issues).values({
      id: holderIssueId,
      companyId,
      title: "CTO deploy issue — holds workspace",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      executionWorkspaceId: workspaceId,
      executionRunId: holderRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    if (opts.createKellyQueued !== false) {
      // Kelly queued wakeup + run (wants to start but workspace is held)
      await db.insert(agentWakeupRequests).values({
        id: kellyWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: kellyIssueId },
        status: "queued",
        runId: kellyRunId,
      });
      await db.insert(heartbeatRuns).values({
        id: kellyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: kellyWakeId,
        contextSnapshot: { issueId: kellyIssueId, wakeReason: "issue_assigned" },
        updatedAt: now,
      });
    }

    // Kelly issue — todo, linked to the same shared workspace, no active executionRunId
    await db.insert(issues).values({
      id: kellyIssueId,
      companyId,
      title: "Kelly content issue — startup should defer",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      projectId,
      executionWorkspaceId: opts.kellyIssueHasSameWorkspace === false ? null : workspaceId,
      executionRunId: null,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      startedAt: now,
    });

    return {
      companyId,
      agentId,
      projectId,
      workspaceId,
      holderIssueId,
      holderRunId,
      kellyIssueId,
      kellyRunId,
      kellyWakeId,
    };
  }

  it("defers and coalesces recovery-continuation wakes at enqueue while the workspace is held", async () => {
    const {
      companyId,
      agentId,
      holderIssueId,
      holderRunId,
      kellyIssueId,
      workspaceId,
    } = await seedStartupHoldFixture({
      holderRunStatus: "running",
      createKellyQueued: false,
    });

    const wakeOpts = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_continuation_needed",
      payload: { issueId: kellyIssueId },
      contextSnapshot: {
        issueId: kellyIssueId,
        taskId: kellyIssueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
      },
      requestedByActorType: "system" as const,
      requestedByActorId: "heartbeat_recovery",
    };

    await expect(heartbeat.wakeup(agentId, wakeOpts)).resolves.toBeNull();
    await expect(heartbeat.wakeup(agentId, wakeOpts)).resolves.toBeNull();

    const deferredWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${kellyIssueId}`,
        ),
      );
    expect(deferredWakes).toHaveLength(1);
    expect(deferredWakes[0]?.reason).toBe("issue_execution_workspace_held_deferred");
    expect(deferredWakes[0]?.coalescedCount).toBe(1);
    expect(deferredWakes[0]?.runId).toBeNull();
    expect(deferredWakes[0]?.payload).toMatchObject({
      issueId: kellyIssueId,
      _paperclipWakeContext: {
        workspaceHeldDeferred: true,
        heldByIssueId: holderIssueId,
        heldByRunId: holderRunId,
        heldExecutionWorkspaceId: workspaceId,
      },
    });

    const kellyRunsBeforeRelease = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${kellyIssueId}`,
        ),
      );
    expect(kellyRunsBeforeRelease).toHaveLength(0);

    await heartbeat.cancelRun(holderRunId, "holder released workspace");

    const promoted = await waitForCondition(async () => {
      const wake = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakes[0]!.id))
        .then((rows) => rows[0] ?? null);
      return Boolean(wake?.runId && wake.status !== "deferred_issue_execution");
    });
    expect(promoted).toBe(true);

    const promotedWake = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakes[0]!.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedWake?.reason).toBe("issue_execution_promoted");
    expect(promotedWake?.runId).toBeTruthy();

    const promotedRun = promotedWake?.runId
      ? await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId: kellyIssueId,
      retryReason: "issue_continuation_needed",
    });

    const settled = await waitForCondition(async () => {
      if (!promotedWake?.runId) return false;
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake.runId))
        .then((rows) => rows[0] ?? null);
      return Boolean(run && ["succeeded", "failed", "cancelled", "timed_out", "skipped"].includes(run.status));
    });
    expect(settled).toBe(true);
  });

  it("skips Kelly run when CTO holds the shared workspace (running)", async () => {
    const {
      companyId,
      agentId,
      holderIssueId,
      holderRunId,
      kellyIssueId,
      kellyRunId,
      kellyWakeId,
    } = await seedStartupHoldFixture({ holderRunStatus: "running" });

    await heartbeat.resumeQueuedRuns();

    const resolved = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "skipped";
    });
    expect(resolved).toBe(true);

    const [kellyRun, kellyWakeup, agentRow] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, kellyWakeId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    // Run must be skipped, not failed or cancelled
    expect(kellyRun?.status).toBe("skipped");
    expect(kellyRun?.errorCode).toBe("workspace_held_deferred");
    expect(kellyRun?.resultJson).toMatchObject({
      stopReason: "workspace_held_deferred",
      heldByRunId: holderRunId,
      heldByIssueId: holderIssueId,
    });

    // Wakeup must be skipped
    expect(kellyWakeup?.status).toBe("skipped");

    // Agent must remain idle — not error
    expect(agentRow?.status).toBe("idle");

    // Adapter must NOT have been called
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Activity log must record the deferral with holder metadata
    const skipActivities = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.run.workspace_held_deferred"),
          eq(activityLog.entityId, kellyRunId),
        ),
      );
    expect(skipActivities).toHaveLength(1);
    expect(skipActivities[0]?.details).toMatchObject({
      issueId: kellyIssueId,
      heldByIssueId: holderIssueId,
      heldByRunId: holderRunId,
    });

    // Holder run must NOT be killed
    const holderRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);
    expect(holderRun?.status).toBe("running");
  });

  it("skips Kelly run when holder is queued on the same workspace", async () => {
    const { kellyRunId, kellyWakeId } = await seedStartupHoldFixture({
      holderRunStatus: "queued",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "skipped";
    });

    const [kellyRun, kellyWakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, kellyWakeId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(kellyRun?.status).toBe("skipped");
    expect(kellyRun?.errorCode).toBe("workspace_held_deferred");
    expect(kellyWakeup?.status).toBe("skipped");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("skips Kelly run when holder is in scheduled_retry on the same workspace", async () => {
    const { kellyRunId } = await seedStartupHoldFixture({
      holderRunStatus: "scheduled_retry",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "skipped";
    });

    const kellyRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, kellyRunId))
      .then((rows) => rows[0] ?? null);

    expect(kellyRun?.status).toBe("skipped");
    expect(kellyRun?.errorCode).toBe("workspace_held_deferred");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does NOT skip Kelly run when Kelly issue has no executionWorkspaceId", async () => {
    const { kellyRunId } = await seedStartupHoldFixture({
      holderRunStatus: "running",
      kellyIssueHasSameWorkspace: false,
    });

    await heartbeat.resumeQueuedRuns();

    // Run should proceed normally (adapter called, run finishes as succeeded/failed — not skipped)
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, kellyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status !== "queued" && run?.status !== "running";
    });

    const kellyRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, kellyRunId))
      .then((rows) => rows[0] ?? null);

    expect(kellyRun?.status).not.toBe("skipped");
  });

  // FUL-11147 regression: issue_blockers_resolved and non-user issue_commented wakes
  // must defer at enqueueWakeup when a shared workspace is held, not queue and fail.

  it("defers issue_blockers_resolved wake at enqueue while the workspace is held (FUL-11147)", async () => {
    const {
      companyId,
      agentId,
      holderIssueId,
      holderRunId,
      kellyIssueId,
      workspaceId,
    } = await seedStartupHoldFixture({
      holderRunStatus: "running",
      createKellyQueued: false,
    });

    const wakeOpts = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_blockers_resolved",
      payload: { issueId: kellyIssueId, resolvedBlockerIssueId: holderIssueId },
      contextSnapshot: {
        issueId: kellyIssueId,
        taskId: kellyIssueId,
        wakeReason: "issue_blockers_resolved",
        source: "workspace.finalize",
        resolvedBlockerIssueId: holderIssueId,
      },
      requestedByActorType: "system" as const,
      requestedByActorId: "heartbeat_workspace_finalize",
    };

    await expect(heartbeat.wakeup(agentId, wakeOpts)).resolves.toBeNull();
    // Second call should coalesce into the same deferred entry
    await expect(heartbeat.wakeup(agentId, wakeOpts)).resolves.toBeNull();

    const deferredWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${kellyIssueId}`,
        ),
      );
    expect(deferredWakes).toHaveLength(1);
    expect(deferredWakes[0]?.reason).toBe("issue_execution_workspace_held_deferred");
    expect(deferredWakes[0]?.coalescedCount).toBe(1);
    expect(deferredWakes[0]?.runId).toBeNull();
    expect(deferredWakes[0]?.payload).toMatchObject({
      issueId: kellyIssueId,
      _paperclipWakeContext: {
        workspaceHeldDeferred: true,
        heldByIssueId: holderIssueId,
        heldByRunId: holderRunId,
        heldExecutionWorkspaceId: workspaceId,
      },
    });

    // Adapter must NOT have been invoked
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("defers non-user issue_commented wake at enqueue while the workspace is held (FUL-11147)", async () => {
    const {
      companyId,
      agentId,
      holderIssueId,
      holderRunId,
      kellyIssueId,
      workspaceId,
    } = await seedStartupHoldFixture({
      holderRunStatus: "running",
      createKellyQueued: false,
    });

    const wakeOpts = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_commented",
      payload: { issueId: kellyIssueId },
      contextSnapshot: {
        issueId: kellyIssueId,
        taskId: kellyIssueId,
        wakeReason: "issue_commented",
        source: "issue.comment",
        wakeCommentId: randomUUID(),
      },
      // System/agent-authored comment — NOT user-initiated
      requestedByActorType: "agent" as const,
      requestedByActorId: holderIssueId,
    };

    await expect(heartbeat.wakeup(agentId, wakeOpts)).resolves.toBeNull();

    const deferredWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${kellyIssueId}`,
        ),
      );
    expect(deferredWakes).toHaveLength(1);
    expect(deferredWakes[0]?.reason).toBe("issue_execution_workspace_held_deferred");
    expect(deferredWakes[0]?.payload).toMatchObject({
      issueId: kellyIssueId,
      _paperclipWakeContext: {
        workspaceHeldDeferred: true,
        heldByIssueId: holderIssueId,
        heldByRunId: holderRunId,
        heldExecutionWorkspaceId: workspaceId,
      },
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does NOT defer user-initiated issue_commented wake when workspace is held (FUL-11147)", async () => {
    const {
      companyId,
      agentId,
      kellyIssueId,
    } = await seedStartupHoldFixture({
      holderRunStatus: "running",
      createKellyQueued: false,
    });

    const userId = randomUUID();
    const wakeOpts = {
      source: "automation" as const,
      triggerDetail: "user" as const,
      reason: "issue_commented",
      payload: { issueId: kellyIssueId },
      contextSnapshot: {
        issueId: kellyIssueId,
        taskId: kellyIssueId,
        wakeReason: "issue_commented",
        source: "issue.comment",
        wakeCommentId: randomUUID(),
      },
      // User-initiated — must NOT be deferred by workspace-held guard
      requestedByActorType: "user" as const,
      requestedByActorId: userId,
    };

    await heartbeat.wakeup(agentId, wakeOpts);

    // No deferred_issue_execution entry should exist — the wake went through normally
    const deferredWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${kellyIssueId}`,
        ),
      );
    expect(deferredWakes).toHaveLength(0);
  });
});
