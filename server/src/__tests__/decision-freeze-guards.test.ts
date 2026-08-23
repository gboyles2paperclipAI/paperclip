import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import {
  heartbeatService,
  shouldAutoCheckoutIssueForWake,
  waitForAllHeartbeatRunExecutionsDrain,
} from "../services/heartbeat.ts";
import {
  DECISION_FREEZE_ACTIVE_ERROR_CODE,
  DECISION_FREEZE_BYPASS_CONTEXT_KEY,
  assertNotDecisionFrozen,
  evaluateDecisionFreezeWakeBypass,
  getActiveDecisionFreeze,
} from "../services/decision-freeze.ts";
import { getAutomaticRecoverySuppressionReason } from "../services/recovery/pause-hold-guard.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { HttpError } from "../errors.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Decision freeze guard test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision freeze guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decision freeze guards", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-freeze-guards-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
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

  async function seedCompanyAgentIssue(overrides?: {
    issueStatus?: string;
    heartbeatRuntimeConfig?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: overrides?.heartbeatRuntimeConfig ?? {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Frozen cone member",
      status: overrides?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedLease(input: {
    companyId: string;
    anchorIssueId: string;
    memberIssueIds: string[];
    state?: "active" | "revising" | "released";
  }) {
    const leaseId = randomUUID();
    await db.insert(decisionLeases).values({
      id: leaseId,
      companyId: input.companyId,
      decisionKind: "approval",
      decisionId: randomUUID(),
      decisionIdempotencyKey: `decision:${input.anchorIssueId}:test:${leaseId}`,
      anchorIssueId: input.anchorIssueId,
      state: input.state ?? "active",
    });
    await db.insert(decisionLeaseMembers).values(
      input.memberIssueIds.map((issueId) => ({ leaseId, issueId })),
    );
    return leaseId;
  }

  function assignmentWake(
    agentId: string,
    issueId: string,
    contextExtras: Record<string, unknown> = {},
    wakeOpts: Partial<Parameters<typeof heartbeat.wakeup>[1]> = {},
  ) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned", ...contextExtras },
      requestedByActorType: "system",
      requestedByActorId: "test",
      ...wakeOpts,
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function seedQueuedRun(input: { companyId: string; agentId: string; issueId: string }) {
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return { runId, wakeupRequestId };
  }

  async function seedDueScheduledRetryRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      responsibleUserId: "responsible-user",
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: "transient_heartbeat_retry",
        retryReason: "transient_failure",
      },
      scheduledRetryAt: new Date(Date.now() - 1_000),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
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

  describe("empty tables (PR-1 dark proof)", () => {
    it("getActiveDecisionFreeze returns null on empty tables and for non-uuid issue ids", async () => {
      const { companyId, issueId } = await seedCompanyAgentIssue();
      expect(await getActiveDecisionFreeze(db, companyId, issueId)).toBeNull();
      expect(await getActiveDecisionFreeze(db, companyId, "ENV-13")).toBeNull();
      expect(await getAutomaticRecoverySuppressionReason(db, companyId, issueId)).toBeNull();
    });

    it("issue-bound wake, claim, and retry promotion behave exactly as today", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      // Slow the adapter down enough to observe the claim-time stamp while
      // the run is live.
      mockAdapterExecute.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Decision freeze guard test run.",
          provider: "test",
          model: "test-model",
        };
      });

      const wake = await assignmentWake(agentId, issueId);
      expect(wake).not.toBeNull();
      const latest = await latestWakeRequest(agentId);
      expect(latest?.status).not.toBe("skipped");
      expect(latest?.reason).not.toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);

      // Let the queued run claim + execute; the claim stamp transaction must
      // admit and stamp exactly as before (no freeze cancellation artifacts),
      // and the run must actually complete successfully.
      let stampedDuringRun = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const [run, issueRow] = await Promise.all([
          getRunRow(wake!.id),
          db
            .select({ executionRunId: issues.executionRunId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null),
        ]);
        if (issueRow?.executionRunId === wake!.id) stampedDuringRun = true;
        if (run && run.status !== "queued" && run.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stampedDuringRun).toBe(true);
      const settledRun = await getRunRow(wake!.id);
      expect(settledRun?.status).toBe("succeeded");
      const freezeActivity = await db
        .select({ id: activityLog.id, action: activityLog.action })
        .from(activityLog)
        .where(eq(activityLog.action, "issue.decision_freeze_run_interrupted"));
      expect(freezeActivity).toHaveLength(0);
      const freezeSkips = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.reason, DECISION_FREEZE_ACTIVE_ERROR_CODE));
      expect(freezeSkips).toHaveLength(0);
    });

    it("promotes a due scheduled retry when no lease exists", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const runId = await seedDueScheduledRetryRun({ companyId, agentId, issueId });

      const promoted = await heartbeat.promoteDueScheduledRetries();
      expect(promoted.promoted).toBe(1);
      expect(promoted.runIds).toContain(runId);

      // Nothing schedules the promoted queued run in this test; cancel it so
      // teardown does not wait on a run no scheduler will ever claim.
      await heartbeat.cancelRun(runId);
    });
  });

  describe("seeded lease + member enforcement", () => {
    it("skips an issue-bound wake into an active freeze with reason decision_freeze_active", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      const wake = await assignmentWake(agentId, issueId);
      expect(wake).toBeNull();

      const latest = await latestWakeRequest(agentId);
      expect(latest?.status).toBe("skipped");
      expect(latest?.reason).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);

      const suppressedActivity = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.action, "issue.decision_freeze_wakeup_suppressed"));
      expect(suppressedActivity).toHaveLength(1);

      const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
      expect(runs).toHaveLength(0);
    });

    it("cancels a queued run at claim time and never stamps executionRunId", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId });
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      await heartbeat.resumeQueuedRuns();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = await getRunRow(runId);
        if (run && run.status !== "queued" && run.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const run = await getRunRow(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.error).toContain("decision freeze");
      expect(run?.errorCode).toBe("issue_decision_frozen");

      const issue = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.executionRunId).toBeNull();

      const wakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("cancelled");

      const interruptActivity = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.action, "issue.decision_freeze_run_interrupted"));
      expect(interruptActivity).toHaveLength(1);
    });

    it("refuses a due scheduled retry with errorCode issue_decision_frozen", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const runId = await seedDueScheduledRetryRun({ companyId, agentId, issueId });
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      const promoted = await heartbeat.promoteDueScheduledRetries();
      expect(promoted.promoted).toBe(0);

      const run = await getRunRow(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("issue_decision_frozen");
    });

    it("auto-checkout is refused for a frozen member", () => {
      const baseInput = {
        contextSnapshot: { wakeReason: "issue_assigned" },
        issueStatus: "todo",
        issueAssigneeAgentId: "agent-1",
        isDependencyReady: true,
        agentId: "agent-1",
      };
      expect(shouldAutoCheckoutIssueForWake(baseInput)).toBe(true);
      expect(shouldAutoCheckoutIssueForWake({ ...baseInput, decisionFrozen: false })).toBe(true);
      expect(shouldAutoCheckoutIssueForWake({ ...baseInput, decisionFrozen: true })).toBe(false);
    });

    it("excludes frozen members from actionable timer work but keeps unrelated issues actionable", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue({
        heartbeatRuntimeConfig: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          skipTimerWhenNoActionableWork: true,
        },
      });
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      const timerWake = () =>
        heartbeat.wakeup(agentId, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
        });

      const skipped = await timerWake();
      expect(skipped).toBeNull();
      const latest = await latestWakeRequest(agentId);
      expect(latest?.status).toBe("skipped");
      expect(latest?.reason).toBe("heartbeat.timer.no_actionable_work");

      // An unrelated todo issue for the same agent is still actionable.
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: "Unfrozen todo",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      const admitted = await timerWake();
      expect(admitted).not.toBeNull();
    });

    it("recovery treats an active-cone member as a durable wait (no stranded recovery)", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      // A failed terminal run would normally make this in_progress issue a
      // stranded-recovery candidate.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        responsibleUserId: "responsible-user",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      expect(await getAutomaticRecoverySuppressionReason(db, companyId, issueId)).toBe("decision_freeze");

      const recoveryWake = vi.fn();
      const recovery = recoveryService(db, { enqueueWakeup: recoveryWake });
      const result = await recovery.reconcileStrandedAssignedIssues();
      expect(result.issueIds).not.toContain(issueId);
      expect(recoveryWake).not.toHaveBeenCalled();

      const recoveryRuns = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"));
      expect(recoveryRuns).toHaveLength(0);
    });
  });

  describe("bypass option (R3.1, internal only)", () => {
    it("snapshot-stuffed flags never pierce a freeze", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      // Legacy flags AND the server-side marker key stuffed straight into the
      // caller-provided snapshot must all be inert.
      const wake = await assignmentWake(agentId, issueId, {
        decisionContinuation: true,
        decisionRevisionWake: true,
        [DECISION_FREEZE_BYPASS_CONTEXT_KEY]: "continuation",
      });
      expect(wake).toBeNull();
      const latest = await latestWakeRequest(agentId);
      expect(latest?.status).toBe("skipped");
      expect(latest?.reason).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);
    });

    it("the internal continuation option passes the wake guard and stamps the server marker", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      const wake = await assignmentWake(agentId, issueId, {}, {
        decisionFreezeBypass: { kind: "continuation" },
      });
      expect(wake).not.toBeNull();
      const latest = await latestWakeRequest(agentId);
      expect(latest?.reason).not.toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);

      // The accepted kind is persisted server-side so claim-time honors it.
      const run = await getRunRow(wake!.id);
      expect(
        (run?.contextSnapshot as Record<string, unknown>)?.[DECISION_FREEZE_BYPASS_CONTEXT_KEY],
      ).toBe("continuation");
    });

    it("the internal revision option passes only while revising and only for the anchor assignee", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      // Active (non-revising) lease: revision intent does NOT bypass.
      const activeLeaseId = await seedLease({
        companyId,
        anchorIssueId: issueId,
        memberIssueIds: [issueId],
        state: "active",
      });
      const refusedWhileActive = await assignmentWake(agentId, issueId, {}, {
        decisionFreezeBypass: { kind: "revision" },
      });
      expect(refusedWhileActive).toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);

      // Revising lease: the anchor's assignee passes.
      await db
        .update(decisionLeases)
        .set({ state: "revising" })
        .where(eq(decisionLeases.id, activeLeaseId));
      const admitted = await assignmentWake(agentId, issueId, {}, {
        decisionFreezeBypass: { kind: "revision" },
      });
      expect(admitted).not.toBeNull();

      // A different agent (not the anchor assignee) stays gated even while
      // revising, even with the internal option set.
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
      const refusedOtherAgent = await assignmentWake(otherAgentId, issueId, {}, {
        decisionFreezeBypass: { kind: "revision" },
      });
      expect(refusedOtherAgent).toBeNull();
      expect((await latestWakeRequest(otherAgentId))?.reason).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);
    });

    it("evaluateDecisionFreezeWakeBypass unit semantics", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const leaseId = await seedLease({
        companyId,
        anchorIssueId: issueId,
        memberIssueIds: [issueId],
        state: "revising",
      });
      const freeze = await getActiveDecisionFreeze(db, companyId, issueId);
      expect(freeze).toEqual({ leaseId, state: "revising", anchorIssueId: issueId });

      expect(
        await evaluateDecisionFreezeWakeBypass(db, companyId, freeze!, {
          bypass: { kind: "continuation" },
          agentId: null,
        }),
      ).toBe(true);
      expect(
        await evaluateDecisionFreezeWakeBypass(db, companyId, freeze!, {
          bypass: { kind: "revision" },
          agentId,
        }),
      ).toBe(true);
      expect(
        await evaluateDecisionFreezeWakeBypass(db, companyId, freeze!, {
          bypass: { kind: "revision" },
          agentId: randomUUID(),
        }),
      ).toBe(false);
      expect(
        await evaluateDecisionFreezeWakeBypass(db, companyId, freeze!, {
          bypass: null,
          agentId,
        }),
      ).toBe(false);
      expect(
        await evaluateDecisionFreezeWakeBypass(
          db,
          companyId,
          { ...freeze!, state: "active" },
          { bypass: { kind: "revision" }, agentId },
        ),
      ).toBe(false);
    });
  });

  describe("pending idempotency unique (0173)", () => {
    it("a keyed enqueue reuses an existing pending row for the same key instead of throwing", async () => {
      const { companyId, agentId } = await seedCompanyAgentIssue();

      // A different agent already owns a pending keyed wake with a queued run.
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "KeyOwner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
      // Occupy the owner's run slot so its queued winner run cannot claim
      // (and leave the pending set) mid-test.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: otherAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        responsibleUserId: "responsible-user",
        contextSnapshot: { taskKey: "owner-busy" },
        startedAt: new Date(),
      });
      const idempotencyKey = `pending-idem-${randomUUID()}`;
      const winnerWakeupId = randomUUID();
      const winnerRunId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: winnerWakeupId,
        companyId,
        agentId: otherAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "monitor_check",
        status: "queued",
        idempotencyKey,
        runId: winnerRunId,
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: winnerRunId,
        companyId,
        agentId: otherAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: winnerWakeupId,
        responsibleUserId: "responsible-user",
        contextSnapshot: { taskKey: "winner-scope" },
      });

      // Pre-0173-recovery code did a raw INSERT here and threw 23505; the
      // enqueue must instead reuse the winning pending row's run.
      const result = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "monitor_check",
        idempotencyKey,
        contextSnapshot: { taskKey: "keyed-scope" },
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(result).not.toBeNull();
      expect(result!.id).toBe(winnerRunId);

      const pendingRows = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          ),
        );
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]!.id).toBe(winnerWakeupId);

      const liveRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]));
      for (const liveRun of liveRuns) {
        await db
          .update(heartbeatRuns)
          .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, liveRun.id));
      }
    });

    it("two concurrent keyed enqueues coalesce onto one pending row without throwing", async () => {
      const { companyId, agentId } = await seedCompanyAgentIssue();

      // Saturate the agent's single run slot so the winning keyed wake stays
      // queued (pending) instead of racing to a terminal status.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        responsibleUserId: "responsible-user",
        contextSnapshot: { taskKey: "occupied-slot" },
        startedAt: new Date(),
      });

      const idempotencyKey = `pending-idem-${randomUUID()}`;
      const keyedWake = () =>
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "monitor_check",
          idempotencyKey,
          contextSnapshot: { taskKey: "keyed-scope" },
          requestedByActorType: "system",
          requestedByActorId: "test",
        });

      // Neither call may throw (pre-0173 both inserted; the partial unique
      // must now coalesce, not 500).
      const [first, second] = await Promise.all([keyedWake(), keyedWake()]);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.id).toBe(first!.id);

      const pendingRows = await db
        .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          ),
        );
      expect(pendingRows).toHaveLength(1);

      // Cancel everything so teardown does not wait on the fake running run
      // or the parked queued run.
      const liveRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]));
      for (const liveRun of liveRuns) {
        await db
          .update(heartbeatRuns)
          .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, liveRun.id));
      }
    });
  });

  describe("assertNotDecisionFrozen (R3.3)", () => {
    it("throws 422 decision_freeze_active for agent actors only", async () => {
      const { companyId, issueId } = await seedCompanyAgentIssue();

      // Empty tables: no-op for every actor.
      await expect(assertNotDecisionFrozen(db, companyId, issueId, "agent")).resolves.toBeUndefined();

      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId] });

      await expect(assertNotDecisionFrozen(db, companyId, issueId, "user")).resolves.toBeUndefined();
      await expect(assertNotDecisionFrozen(db, companyId, issueId, "system")).resolves.toBeUndefined();
      await expect(assertNotDecisionFrozen(db, companyId, issueId, null)).resolves.toBeUndefined();

      const error = await assertNotDecisionFrozen(db, companyId, issueId, "agent").then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(422);
      expect(((error as HttpError).details as Record<string, unknown>).code).toBe(
        DECISION_FREEZE_ACTIVE_ERROR_CODE,
      );
    });

    it("released leases do not freeze", async () => {
      const { companyId, issueId } = await seedCompanyAgentIssue();
      await seedLease({ companyId, anchorIssueId: issueId, memberIssueIds: [issueId], state: "released" });
      expect(await getActiveDecisionFreeze(db, companyId, issueId)).toBeNull();
      await expect(assertNotDecisionFrozen(db, companyId, issueId, "agent")).resolves.toBeUndefined();
    });
  });
});
