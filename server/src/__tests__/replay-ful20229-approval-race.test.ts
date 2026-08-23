import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companySkills,
  createDb,
  decisionContinuations,
  decisionLeaseMembers,
  decisionLeases,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  waitForAllHeartbeatRunExecutionsDrain,
} from "../services/heartbeat.ts";
import {
  DECISION_FREEZE_ACTIVE_ERROR_CODE,
  getActiveDecisionFreeze,
} from "../services/decision-freeze.ts";
import {
  buildContinuationPayloadForLease,
  createApprovalDecision,
  dispatchDecisionContinuations,
  resolveLease,
} from "../services/decision-leases.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * FUL-20229 replay (ADR-20260823-quiescent-coordination): a decision wait must
 * be quiescent. The historical failure was a pending approval whose issue kept
 * spawning runs and children off board comments, plus duplicate approvals from
 * request replays and lost/raced requester wakes. This fixture proves, against
 * the real embedded-PG writers:
 *   (a) lease-bound approval + comment storm → zero runs, zero child issues;
 *   (b) 10 concurrent identical decision creates → 1 approval + 1 lease;
 *   (c) approve → exactly 1 continuation + 1 revalidating wake; reject on a
 *       fresh lease → exactly 1 continuation with disposition rejected;
 *   (d) approve-vs-expire race → one winner, loser applied:false, no side
 *       effects;
 *   (e) crash between resolve and dispatch → the restarted sweeper delivers
 *       exactly once.
 *
 * NOTE (PR-2a scope): comment-route mutation gating is PR-2b, so the storm in
 * (a) inserts comment rows directly (they are recorded — that is expected) and
 * asserts quiescence via the wake-guard skip path: no runs, no children.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "FUL-20229 replay test run.",
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
    `Skipping embedded Postgres FUL-20229 replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("replay FUL-20229 — quiescent approval waits", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-replay-ful20229-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

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
        await db.delete(decisionContinuations);
        await db.delete(decisionLeaseMembers);
        await db.delete(decisionLeases);
        await db.delete(issueApprovals);
        await db.delete(approvals);
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

  async function seedCompanyAgentAnchorChild() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const anchorIssueId = randomUUID();
    const childIssueId = randomUUID();

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
      name: "Requester",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: anchorIssueId,
      companyId,
      title: "FUL-20229 anchor",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "FUL-20229 child",
      status: "todo",
      priority: "medium",
      parentId: anchorIssueId,
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, anchorIssueId, childIssueId };
  }

  function decisionCreateInput(seed: {
    companyId: string;
    agentId: string;
    anchorIssueId: string;
    childIssueId: string;
  }, idempotencyKey: string) {
    return {
      companyId: seed.companyId,
      type: "budget_change",
      payload: { proposal: "ship it", subjectRevision: 1 },
      issueIds: [seed.anchorIssueId, seed.childIssueId],
      requestedByAgentId: seed.agentId,
      requestedByUserId: null,
      decisionLease: {
        idempotencyKey,
        posture: {
          status: "in_review" as const,
          comment: "## Decision requested\nEvidence: plan v1 attached.",
        },
      },
    };
  }

  async function createBoardApp() {
    const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/approvals.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        companyIds: [],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function continuationsForLease(leaseId: string) {
    return db
      .select()
      .from(decisionContinuations)
      .where(eq(decisionContinuations.leaseId, leaseId));
  }

  async function wakesWithKey(idempotencyKey: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
  }

  it("(a) a pending lease-bound decision plus a 100-comment storm stays quiescent: zero runs, zero new child issues", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const created = await createApprovalDecision(db, decisionCreateInput(seed, `decision:${seed.anchorIssueId}:budget:1`));
    expect(created.applied).toBe(true);
    expect(created.lease).not.toBeNull();

    // R3.2 posture: one create call yields in_review + evidence comment +
    // active member rows for the whole cone.
    const anchor = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seed.anchorIssueId))
      .then((rows) => rows[0]!);
    expect(anchor.status).toBe("in_review");
    const evidence = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, seed.anchorIssueId));
    expect(evidence).toHaveLength(1);
    const memberRows = await db
      .select({ issueId: decisionLeaseMembers.issueId })
      .from(decisionLeaseMembers)
      .where(eq(decisionLeaseMembers.leaseId, created.lease!.id));
    expect(new Set(memberRows.map((row) => row.issueId))).toEqual(
      new Set([seed.anchorIssueId, seed.childIssueId]),
    );
    expect(await getActiveDecisionFreeze(db, seed.companyId, seed.childIssueId)).not.toBeNull();

    const issuesBefore = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, seed.companyId));

    // The storm: 100 board/agent comments recorded directly (comment-route
    // gating is PR-2b) with the comment-wake attempt each one would fire.
    for (let index = 0; index < 100; index += 1) {
      const userComment = index % 2 === 0;
      await db.insert(issueComments).values({
        companyId: seed.companyId,
        issueId: seed.anchorIssueId,
        authorUserId: userComment ? "board-user" : null,
        authorAgentId: userComment ? null : seed.agentId,
        authorType: userComment ? "user" : "agent",
        body: `storm comment ${index}`,
      });
      const wake = await heartbeat.wakeup(seed.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: seed.anchorIssueId, mutation: "comment" },
        contextSnapshot: { issueId: seed.anchorIssueId, wakeReason: "issue_commented" },
        requestedByActorType: userComment ? "user" : "agent",
        requestedByActorId: userComment ? "board-user" : seed.agentId,
      });
      expect(wake).toBeNull();
    }

    // Quiescent: zero heartbeat runs, zero new child issues, comments intact.
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(0);
    const issuesAfter = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, seed.companyId));
    expect(issuesAfter).toHaveLength(issuesBefore.length);
    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, seed.anchorIssueId));
    expect(comments).toHaveLength(101); // evidence + 100 storm comments
    const freezeSkips = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.status, "skipped"),
        eq(agentWakeupRequests.reason, DECISION_FREEZE_ACTIVE_ERROR_CODE),
      ));
    expect(freezeSkips.length).toBe(100);
  }, 120_000);

  it("(b) ten concurrent identical decision creates yield exactly one approval and one lease", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const idempotencyKey = `decision:${seed.anchorIssueId}:budget:1`;
    const input = decisionCreateInput(seed, idempotencyKey);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => createApprovalDecision(db, input)),
    );

    const appliedResults = results.filter((result) => result.applied);
    expect(appliedResults).toHaveLength(1);
    const approvalIds = new Set(results.map((result) => result.approval.id));
    expect(approvalIds.size).toBe(1);
    for (const result of results.filter((result) => !result.applied)) {
      expect(result.lease?.id).toBe(appliedResults[0]!.lease!.id);
      expect(result.runIdsToInterrupt).toHaveLength(0);
    }

    const approvalRows = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.companyId, seed.companyId), eq(approvals.idempotencyKey, idempotencyKey)));
    expect(approvalRows).toHaveLength(1);
    const leaseRows = await db
      .select({ id: decisionLeases.id })
      .from(decisionLeases)
      .where(and(
        eq(decisionLeases.companyId, seed.companyId),
        eq(decisionLeases.decisionIdempotencyKey, idempotencyKey),
      ));
    expect(leaseRows).toHaveLength(1);
    // The evidence comment was written exactly once (loser transactions had
    // zero side effects).
    const evidence = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, seed.anchorIssueId));
    expect(evidence).toHaveLength(1);

    // Same key, different payload → 409 conflict, no extra rows.
    await expect(createApprovalDecision(db, {
      ...input,
      payload: { proposal: "something else entirely" },
    })).rejects.toMatchObject({ status: 409 });
  }, 60_000);

  it("(c) approve delivers exactly one continuation and one revalidating wake; reject resolves with disposition rejected and wakes too", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const created = await createApprovalDecision(db, decisionCreateInput(seed, `decision:${seed.anchorIssueId}:budget:1`));
    const lease = created.lease!;
    const app = await createBoardApp();

    const approveResponse = await request(app)
      .post(`/api/approvals/${created.approval.id}/approve`)
      .send({ decisionNote: "LGTM" });
    expect(approveResponse.status).toBe(200);

    const continuations = await continuationsForLease(lease.id);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.disposition).toBe("approved");
    expect(continuations[0]!.consumedAt).not.toBeNull();

    const releasedLease = await db
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, lease.id))
      .then((rows) => rows[0]!);
    expect(releasedLease.state).toBe("released");
    expect(releasedLease.disposition).toBe("approved");
    expect(await getActiveDecisionFreeze(db, seed.companyId, seed.childIssueId)).toBeNull();

    const wakes = await wakesWithKey(`decision:${lease.id}:approved`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(seed.agentId);
    const wakePayload = wakes[0]!.payload as Record<string, unknown>;
    expect(wakePayload.revalidate).toBe(true);
    expect(wakePayload.approvalId).toBe(created.approval.id);
    expect(wakePayload.approvalStatus).toBe("approved");
    // The legacy immediate requester wake did NOT also fire (R2.10): every
    // wake for this approval carries the outbox idempotency key.
    const approvalWakes = await db
      .select({ id: agentWakeupRequests.id, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, seed.companyId),
        eq(agentWakeupRequests.agentId, seed.agentId),
        inArray(agentWakeupRequests.reason, ["approval_approved"]),
      ));
    expect(approvalWakes.every((row) => row.idempotencyKey === `decision:${lease.id}:approved`)).toBe(true);

    // Fresh lease, rejected: reject is a resolving disposition and now wakes.
    const seed2 = await seedCompanyAgentAnchorChild();
    const created2 = await createApprovalDecision(db, decisionCreateInput(seed2, `decision:${seed2.anchorIssueId}:budget:1`));
    const rejectResponse = await request(app)
      .post(`/api/approvals/${created2.approval.id}/reject`)
      .send({ decisionNote: "not now" });
    expect(rejectResponse.status).toBe(200);

    const rejectedContinuations = await continuationsForLease(created2.lease!.id);
    expect(rejectedContinuations).toHaveLength(1);
    expect(rejectedContinuations[0]!.disposition).toBe("rejected");
    const rejectWakes = await wakesWithKey(`decision:${created2.lease!.id}:rejected`);
    expect(rejectWakes).toHaveLength(1);
    expect((rejectWakes[0]!.payload as Record<string, unknown>).approvalStatus).toBe("rejected");
  }, 60_000);

  it("(d) approve-vs-expire race: the continuation unique is the arbiter — one winner, the loser applied:false with zero side effects", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const created = await createApprovalDecision(db, decisionCreateInput(seed, `decision:${seed.anchorIssueId}:budget:1`));
    const lease = created.lease!;

    const approvedPayload = await buildContinuationPayloadForLease(db, lease, "approved");
    const expiredPayload = await buildContinuationPayloadForLease(db, lease, "expired");
    const [approveOutcome, expireOutcome] = await Promise.all([
      resolveLease(db, lease.id, "approved", { payload: approvedPayload }),
      resolveLease(db, lease.id, "expired", { payload: expiredPayload }),
    ]);

    const outcomes = [approveOutcome, expireOutcome];
    const winners = outcomes.filter((outcome) => outcome.applied);
    const losers = outcomes.filter((outcome) => !outcome.applied);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser surfaces the WINNING disposition (R2.5).
    expect(losers[0]!.disposition).toBe(winners[0]!.disposition);

    const continuations = await continuationsForLease(lease.id);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.disposition).toBe(winners[0]!.disposition);
    expect(losers[0]!.continuationId).toBe(continuations[0]!.id);

    const releasedLease = await db
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, lease.id))
      .then((rows) => rows[0]!);
    expect(releasedLease.state).toBe("released");
    expect(releasedLease.disposition).toBe(winners[0]!.disposition);
  }, 60_000);

  it("(e) crash between resolve and dispatch: the restarted sweeper delivers exactly once", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const created = await createApprovalDecision(db, decisionCreateInput(seed, `decision:${seed.anchorIssueId}:budget:1`));
    const lease = created.lease!;

    // The resolving transaction commits the continuation…
    const payload = await buildContinuationPayloadForLease(db, lease, "approved");
    const outcome = await resolveLease(db, lease.id, "approved", { payload });
    expect(outcome.applied).toBe(true);
    // …and then the process "crashes" before the dispatcher runs: no wake yet.
    expect(await wakesWithKey(`decision:${lease.id}:approved`)).toHaveLength(0);

    // Restart: re-instantiate the services and run the sweep.
    const restartedHeartbeat = heartbeatService(db);
    const firstSweep = await dispatchDecisionContinuations(db, { enqueueWakeup: restartedHeartbeat.wakeup });
    expect(firstSweep.delivered).toBe(1);
    expect(await wakesWithKey(`decision:${lease.id}:approved`)).toHaveLength(1);

    // A second sweep (and a third service instance) delivers nothing more.
    const secondSweep = await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeatService(db).wakeup });
    expect(secondSweep.scanned).toBe(0);
    expect(secondSweep.delivered).toBe(0);
    expect(await wakesWithKey(`decision:${lease.id}:approved`)).toHaveLength(1);

    const wakeStatuses = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(like(agentWakeupRequests.idempotencyKey, `decision:${lease.id}:%`));
    expect(wakeStatuses).toHaveLength(1);
  }, 60_000);
});
