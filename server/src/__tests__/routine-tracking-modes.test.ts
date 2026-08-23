import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  decisionLeaseMembers,
  decisionLeases,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projects,
  routineDocuments,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine tracking mode tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine tracking modes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-tracking-modes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisionLeaseMembers);
    await db.delete(decisionLeases);
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{ agentId: string; issueId: string | null }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TrackingModeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          wakeups.push({ agentId: wakeupAgentId, issueId });
          if (!issueId) return null;
          const issue = await db
            .select({ responsibleUserId: issues.responsibleUserId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null);
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            responsibleUserId: issue?.responsibleUserId ?? defaultResponsibleUserId,
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, defaultResponsibleUserId, issueSvc, projectId, routine, svc, wakeups };
  }

  async function setTrackingMode(routineId: string, trackingMode: string) {
    await db.update(routines).set({ trackingMode }).where(eq(routines.id, routineId));
  }

  async function getIssue(issueId: string) {
    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(row).not.toBeNull();
    return row!;
  }

  async function listFailureEpisodes(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_failure_episode")));
  }

  // Drives one execution cycle to a terminal status the way the routes do:
  // terminalize the queued heartbeat run, move the linked issue, then sync.
  async function finishCycle(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    issueId: string,
    terminalStatus: "done" | "blocked" | "cancelled",
  ) {
    const issue = await getIssue(issueId);
    if (issue.executionRunId) {
      await db
        .update(heartbeatRuns)
        .set({ status: terminalStatus === "done" ? "completed" : "failed" })
        .where(eq(heartbeatRuns.id, issue.executionRunId));
    }
    await fixture.issueSvc.update(issueId, { status: terminalStatus });
    return fixture.svc.syncRunStatusForIssue(issueId);
  }

  it("issue_always default keeps a visible execution issue and never opens a failure episode", async () => {
    const fixture = await seedFixture();
    expect(fixture.routine.trackingMode).toBe("issue_always");

    const run = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const executionIssue = await getIssue(run.linkedIssueId!);
    expect(executionIssue.hiddenAt).toBeNull();
    expect(executionIssue.originKind).toBe("routine_execution");
    const listed = await fixture.issueSvc.list(fixture.companyId);
    expect(listed.map((row) => row.id)).toContain(executionIssue.id);

    // A failing issue_always cycle finalizes the run as failed exactly as
    // before and does NOT open a failure episode (byte parity).
    const synced = await finishCycle(fixture, executionIssue.id, "blocked");
    expect(synced).toMatchObject({ status: "failed", failureReason: "Execution issue moved to blocked" });
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(0);
  });

  it("run_only healthy cycle keeps the board-visible list empty throughout", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");

    const run = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const executionIssue = await getIssue(run.linkedIssueId!);
    expect(executionIssue.hiddenAt).not.toBeNull();
    expect(executionIssue.originKind).toBe("routine_execution");
    // The hidden issue still reached agent pickup: the assignment wake fired
    // with the issue id and the (mocked) heartbeat stamped executionRunId.
    expect(fixture.wakeups).toEqual([{ agentId: fixture.agentId, issueId: executionIssue.id }]);
    expect(executionIssue.executionRunId).toBeTruthy();

    expect(await fixture.issueSvc.list(fixture.companyId)).toHaveLength(0);

    const synced = await finishCycle(fixture, executionIssue.id, "done");
    expect(synced).toMatchObject({ status: "completed" });

    expect(await fixture.issueSvc.list(fixture.companyId)).toHaveLength(0);
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(0);
  });

  it("run_only coalesces a second tick into the live hidden execution issue", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");

    const first = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(first.status).toBe("issue_created");

    const second = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(second.status).toBe("coalesced");
    expect(second.linkedIssueId).toBe(first.linkedIssueId);

    const executionIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "routine_execution")));
    expect(executionIssues).toHaveLength(1);
  });

  it("two concurrent first ticks of a run_only routine produce exactly one hidden execution issue", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");

    const [first, second] = await Promise.all([
      fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {}),
      fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {}),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    const created = first.status === "issue_created" ? first : second;
    const coalesced = first.status === "issue_created" ? second : first;
    expect(coalesced.linkedIssueId).toBe(created.linkedIssueId);

    const executionIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, fixture.companyId), eq(issues.originKind, "routine_execution")));
    expect(executionIssues).toHaveLength(1);
    expect(executionIssues[0]!.hiddenAt).not.toBeNull();
  });

  it("hidden open execution issues are backstopped by issues_open_routine_execution_hidden_uq", async () => {
    const fixture = await seedFixture();
    const seedRun = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        responsibleUserId: fixture.defaultResponsibleUserId,
        contextSnapshot: {},
      });
      return runId;
    };
    const insertHiddenExecutionIssue = async () =>
      db.insert(issues).values({
        id: randomUUID(),
        companyId: fixture.companyId,
        title: "hidden execution",
        status: "todo",
        priority: "medium",
        assigneeAgentId: fixture.agentId,
        originKind: "routine_execution",
        originId: fixture.routine.id,
        originFingerprint: "default",
        originRunId: randomUUID(),
        executionRunId: await seedRun(),
        hiddenAt: new Date(),
        responsibleUserId: fixture.defaultResponsibleUserId,
      });

    await insertHiddenExecutionIssue();
    const error = await insertHiddenExecutionIssue().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).not.toBeNull();
    expect(JSON.stringify(error) + String((error as Error).message)).toContain(
      "issues_open_routine_execution_hidden_uq",
    );
    // Cancel the seeded runs so teardown does not treat them as live work.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.status, "running"));
  });

  it("skip_if_active stays unaffected for issue_always routines", async () => {
    const fixture = await seedFixture();
    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, fixture.routine.id));

    const first = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(first.status).toBe("issue_created");

    const second = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(second.status).toBe("skipped");
    expect(second.failureReason).toBeNull();
    expect(second.linkedIssueId).toBe(first.linkedIssueId);
  });

  it("issue_on_failure reuses one visible episode across failing ticks and recovery closes it exactly once", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "issue_on_failure");

    // Failing tick 1 opens the episode.
    const firstRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(firstRun.status).toBe("issue_created");
    const firstIssue = await getIssue(firstRun.linkedIssueId!);
    expect(firstIssue.hiddenAt).not.toBeNull();
    await finishCycle(fixture, firstIssue.id, "blocked");

    const episodesAfterFirstFailure = await listFailureEpisodes(fixture.companyId);
    expect(episodesAfterFirstFailure).toHaveLength(1);
    const episode = episodesAfterFirstFailure[0]!;
    expect(episode.hiddenAt).toBeNull();
    expect(episode.status).toBe("todo");
    expect(episode.originId).toBe(fixture.routine.id);
    const listed = await fixture.issueSvc.list(fixture.companyId);
    expect(listed.map((row) => row.id)).toContain(episode.id);

    // Failing tick 2 reuses the same open episode — no duplicate.
    const secondRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(secondRun.status).toBe("issue_created");
    expect(secondRun.linkedIssueId).not.toBe(firstRun.linkedIssueId);
    await finishCycle(fixture, secondRun.linkedIssueId!, "blocked");

    const episodesAfterSecondFailure = await listFailureEpisodes(fixture.companyId);
    expect(episodesAfterSecondFailure).toHaveLength(1);
    expect(episodesAfterSecondFailure[0]!.id).toBe(episode.id);
    expect(episodesAfterSecondFailure[0]!.status).toBe("todo");

    // A healthy cycle terminalizes the episode exactly once with evidence.
    const healthyRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(healthyRun.status).toBe("issue_created");
    const healthySync = await finishCycle(fixture, healthyRun.linkedIssueId!, "done");
    expect(healthySync).toMatchObject({ status: "completed" });

    const closedEpisode = await getIssue(episode.id);
    expect(closedEpisode.status).toBe("done");
    const episodeComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, episode.id));
    expect(episodeComments).toHaveLength(1);
    expect(episodeComments[0]!.body).toContain("Routine recovered");

    // Replaying the healthy sync does not re-terminalize or duplicate evidence.
    await fixture.svc.syncRunStatusForIssue(healthyRun.linkedIssueId!);
    expect(
      await db.select().from(issueComments).where(eq(issueComments.issueId, episode.id)),
    ).toHaveLength(1);

    // The next healthy run creates nothing visible and no new episode.
    const nextHealthyRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(nextHealthyRun.status).toBe("issue_created");
    await finishCycle(fixture, nextHealthyRun.linkedIssueId!, "done");
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(1);
    const visibleAfterRecovery = await fixture.issueSvc.list(fixture.companyId);
    expect(visibleAfterRecovery.map((row) => row.id)).toEqual([episode.id]);
  });

  it("a healthy-cycle resolve waits for an in-flight episode open instead of missing it", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "issue_on_failure");

    // Failing cycle: terminalize manually WITHOUT syncing, so no episode
    // exists yet.
    const failingRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(failingRun.status).toBe("issue_created");
    const failingIssue = await getIssue(failingRun.linkedIssueId!);
    if (failingIssue.executionRunId) {
      await db
        .update(heartbeatRuns)
        .set({ status: "failed" })
        .where(eq(heartbeatRuns.id, failingIssue.executionRunId));
    }
    await fixture.issueSvc.update(failingIssue.id, { status: "blocked" });

    // Healthy cycle: dispatch + terminalize, also without syncing yet.
    const healthyRun = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(healthyRun.status).toBe("issue_created");
    const healthyIssue = await getIssue(healthyRun.linkedIssueId!);
    if (healthyIssue.executionRunId) {
      await db
        .update(heartbeatRuns)
        .set({ status: "completed" })
        .where(eq(heartbeatRuns.id, healthyIssue.executionRunId));
    }
    await fixture.issueSvc.update(healthyIssue.id, { status: "done" });

    // Simulate an in-flight episode open: hold the routine-row lock in a
    // transaction, insert the episode issue inside it, and keep the
    // transaction uncommitted while the healthy resolve runs. Without the
    // routine-row serialization in maybeResolveRoutineFailureEpisode the
    // resolve would read "no open episode" and return, orphaning it open.
    const episodeId = randomUUID();
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from routines where id = ${fixture.routine.id} for update`);
      await tx.insert(issues).values({
        id: episodeId,
        companyId: fixture.companyId,
        title: "Routine failing: ascii frog",
        status: "todo",
        priority: "medium",
        assigneeAgentId: fixture.agentId,
        identifier: `EPI${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        originKind: "routine_failure_episode",
        originId: fixture.routine.id,
        originRunId: failingRun.id,
        responsibleUserId: fixture.defaultResponsibleUserId,
      });
      signalHeld();
      await lockGate;
    });
    await lockHeld;

    const resolvePromise = fixture.svc.syncRunStatusForIssue(healthyIssue.id);
    // Give the resolve time to reach (and block on) the routine-row lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseLock();
    await holder;
    await resolvePromise;

    const episode = await getIssue(episodeId);
    expect(episode.status).toBe("done");
    const episodeComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, episodeId));
    expect(episodeComments).toHaveLength(1);
    expect(episodeComments[0]!.body).toContain("Routine recovered");
  });

  it("a freeze-membership tick suppresses dispatch quietly with no issue and no failure spam", async () => {
    const fixture = await seedFixture();
    const anchorIssueId = randomUUID();
    await db.insert(issues).values({
      id: anchorIssueId,
      companyId: fixture.companyId,
      title: "Decision anchor",
      status: "in_review",
      assigneeAgentId: fixture.agentId,
      priority: "medium",
    });
    const frozenRoutine = await fixture.svc.create(
      fixture.companyId,
      {
        projectId: fixture.projectId,
        goalId: null,
        parentIssueId: anchorIssueId,
        title: "frozen frog",
        description: "Runs under a decision anchor",
        assigneeAgentId: fixture.agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    await setTrackingMode(frozenRoutine.id, "issue_on_failure");
    const leaseId = randomUUID();
    await db.insert(decisionLeases).values({
      id: leaseId,
      companyId: fixture.companyId,
      decisionKind: "approval",
      decisionId: randomUUID(),
      decisionIdempotencyKey: `decision-${leaseId}`,
      anchorIssueId,
      state: "active",
    });
    await db.insert(decisionLeaseMembers).values({ leaseId, issueId: anchorIssueId });

    const suppressed = await fixture.svc.runRoutine(frozenRoutine.id, { source: "manual" }, {});
    expect(suppressed.status).toBe("skipped");
    expect(suppressed.failureReason).toBe("decision_freeze");
    expect(suppressed.linkedIssueId).toBeNull();
    expect(suppressed.triggerPayload).toMatchObject({
      decisionFreeze: { leaseId, state: "active", anchorIssueId },
    });
    // No execution issue (visible or hidden), no episode, no wake.
    const companyIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    expect(companyIssues.map((row) => row.id)).toEqual([anchorIssueId]);
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(0);
    expect(fixture.wakeups).toHaveLength(0);

    // Releasing the lease lets the next tick dispatch normally.
    await db.update(decisionLeases).set({ state: "released" }).where(eq(decisionLeases.id, leaseId));
    const released = await fixture.svc.runRoutine(frozenRoutine.id, { source: "manual" }, {});
    expect(released.status).toBe("issue_created");
    expect(released.linkedIssueId).toBeTruthy();
  });
});
