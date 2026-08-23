import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";

vi.hoisted(() => {
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping FUL-20279 run-only board-zero replay on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Replay of FUL-20279: internal maintenance loops filed a board-visible issue
 * per tick, drowning operator boards in routine execution noise. With
 * tracking modes (ADR-20260823-quiescent-coordination Decision on run
 * tracking + R2.18):
 *
 * - `run_only` keeps the board at ZERO issues through healthy cycles AND
 *   failures — failures belong to the routine's named external failureOwner;
 * - `issue_on_failure` keeps healthy cycles hidden and surfaces repeated
 *   failure as exactly ONE visible episode that recovery closes exactly once;
 * - a paused project produces a PAUSED-class skip, not a failure;
 * - a run whose provider/linked issue never terminalizes is never recorded
 *   successful.
 */
describeEmbeddedPostgres("replay FUL-20279: run-only routines keep the board at zero", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ful20279-run-only-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routineRevisions);
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
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
      name: "RunOnlyAgent",
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
      name: "Maintenance",
      status: "in_progress",
    });

    const svc = routineService(db, {
      runtimeEnv: {},
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
            .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
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
        title: "uw archive relief valve",
        description: "Move eligible rows to cold storage",
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

  async function boardVisibleOpenCount(fixture: Awaited<ReturnType<typeof seedFixture>>) {
    const listed = await fixture.issueSvc.list(fixture.companyId);
    return listed.length;
  }

  async function listFailureEpisodes(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_failure_episode")));
  }

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

  it("run_only healthy cycle: routine_runs row + hidden execution issue + board-visible open count 0 throughout", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");
    expect(await boardVisibleOpenCount(fixture)).toBe(0);

    const run = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    // Run history exists in routine_runs while the board stays at zero.
    const runRows = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, fixture.routine.id));
    expect(runRows).toHaveLength(1);
    const executionIssue = await getIssue(run.linkedIssueId!);
    expect(executionIssue.hiddenAt).not.toBeNull();
    expect(executionIssue.originKind).toBe("routine_execution");
    expect(await boardVisibleOpenCount(fixture)).toBe(0);

    const synced = await finishCycle(fixture, executionIssue.id, "done");
    expect(synced).toMatchObject({ status: "completed" });
    expect(await boardVisibleOpenCount(fixture)).toBe(0);
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(0);
  }, 30_000);

  it("run_only failures stay board-zero: the named failureOwner monitor owns them (R2.18)", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const run = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
      expect(run.status).toBe("issue_created");
      const synced = await finishCycle(fixture, run.linkedIssueId!, "blocked");
      expect(synced).toMatchObject({ status: "failed" });
      // No board-visible issue and no episode: failure visibility for
      // run_only loops is the external failureOwner + transition-keyed
      // notification, never board issues.
      expect(await boardVisibleOpenCount(fixture)).toBe(0);
      expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(0);
    }
  }, 30_000);

  it("issue_on_failure: repeated failure surfaces ONE visible episode, recovery closes it exactly once, next healthy run adds nothing visible", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "issue_on_failure");

    // Repeated failure -> exactly one visible episode issue.
    const firstFailing = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    await finishCycle(fixture, firstFailing.linkedIssueId!, "blocked");
    const secondFailing = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    await finishCycle(fixture, secondFailing.linkedIssueId!, "blocked");

    const episodes = await listFailureEpisodes(fixture.companyId);
    expect(episodes).toHaveLength(1);
    const episode = episodes[0]!;
    expect(episode.hiddenAt).toBeNull();
    expect(await boardVisibleOpenCount(fixture)).toBe(1);

    // Recovery closes the episode exactly once (single evidence comment),
    // and a replayed sync does not duplicate the close.
    const healthy = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    await finishCycle(fixture, healthy.linkedIssueId!, "done");
    const closed = await getIssue(episode.id);
    expect(closed.status).toBe("done");
    await fixture.svc.syncRunStatusForIssue(healthy.linkedIssueId!);
    const evidence = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, episode.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.body).toContain("Routine recovered");

    // The next healthy run adds nothing board-visible and no new episode.
    const nextHealthy = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    await finishCycle(fixture, nextHealthy.linkedIssueId!, "done");
    expect(await listFailureEpisodes(fixture.companyId)).toHaveLength(1);
    const visible = await fixture.issueSvc.list(fixture.companyId);
    expect(visible.map((row) => row.id)).toEqual([episode.id]);
  }, 30_000);

  it("a paused-project scheduled tick records a PAUSED-class skip, not a failure (kill-switch-equivalent gate)", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");
    const created = await fixture.svc.createTrigger(
      fixture.routine.id,
      { kind: "schedule", cronExpression: "*/5 * * * *", timezone: "UTC", enabled: true },
      {},
    );
    // Make the trigger due, then pause the project (the operational
    // kill-switch equivalent for this routine's dispatch gate).
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(routineTriggers.id, created.trigger.id));
    await db
      .update(projects)
      .set({ pausedAt: new Date() })
      .where(eq(projects.id, fixture.projectId));

    const ticked = await fixture.svc.tickScheduledTriggers(new Date());
    expect(ticked.triggered).toBe(0);

    const runRows = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, fixture.routine.id));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      status: "skipped",
      failureReason: "paused",
      linkedIssueId: null,
    });
    expect(runRows[0]!.status).not.toBe("failed");
    const trigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, created.trigger.id))
      .then((rows) => rows[0]!);
    // The trigger records the PAUSED-class outcome (skipped_paused rendered
    // as its display string), never a failure.
    expect(trigger.lastResult).toBe("Skipped because the project is paused");
    // PAUSED-class outcome creates nothing on the board and wakes nobody.
    expect(await boardVisibleOpenCount(fixture)).toBe(0);
    expect(fixture.wakeups).toHaveLength(0);
  }, 30_000);

  it("an unreadable provider / incomplete execution is never recorded successful", async () => {
    const fixture = await seedFixture();
    await setTrackingMode(fixture.routine.id, "run_only");

    const run = await fixture.svc.runRoutine(fixture.routine.id, { source: "manual" }, {});
    expect(run.status).toBe("issue_created");

    // The provider never reports back: the linked issue never terminalizes.
    // Syncing produces no completion and the run must stay non-completed.
    const synced = await fixture.svc.syncRunStatusForIssue(run.linkedIssueId!);
    expect(synced).toBeNull();
    const persisted = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(persisted.status).toBe("issue_created");
    expect(persisted.status).not.toBe("completed");
    expect(persisted.completedAt).toBeNull();
  }, 30_000);
});
