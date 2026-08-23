import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, like, notInArray } from "drizzle-orm";
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
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitForAllHeartbeatRunExecutionsDrain } from "../services/heartbeat.ts";
import {
  DECISION_FREEZE_ACTIVE_ERROR_CODE,
  getActiveDecisionFreeze,
} from "../services/decision-freeze.ts";
import { createApprovalDecision } from "../services/decision-leases.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * FUL-20244 replay (ADR-20260823-quiescent-coordination, PR-2b):
 *
 * (a) A blocker inside a frozen decision cone resolves → the dependent gets NO
 *     wake while the lease is active; releasing the lease delivers exactly one
 *     continuation-driven wake (no blocker-wake burst).
 * (b) A human comment on a done issue NEVER changes its status (the implicit
 *     comment-reopen path is removed); explicit `reopen: true` by a board user
 *     still works.
 * (c) An agent comment on a terminal issue produces no reopen and no wake.
 * (d) The mutation gate (R3.3): agent PATCH/comment/document/attachment/
 *     work-product on a frozen member → 422 `decision_freeze_active`; board
 *     users stay exempt; while `revising`, the anchor's assignee may comment
 *     and update documents on the anchor ONLY — sibling members stay gated.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "FUL-20244 stale blocker replay run.",
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
    `Skipping embedded Postgres FUL-20244 stale blocker replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("replay — FUL-20244 stale blocker + terminal integrity (PR-2b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-replay-ful20244-");
    db = createDb(tempDb.connectionString);
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
        await db.delete(issueDocuments);
        await db.delete(issueRelations);
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

  async function createIssueApp(actor: Express.Request["actor"]) {
    const [{ errorHandler }, { issueRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/issues.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function createApprovalApp() {
    const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/approvals.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
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

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

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
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    parentId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      parentId: input.parentId ?? null,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  async function issueStatus(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  it("(a) resolving a blocker inside a frozen cone produces no dependent wake until release, then exactly one continuation wake", async () => {
    const companyId = await seedCompany();
    const ownerAgentId = await seedAgent(companyId, "Owner");
    const depAgentId = await seedAgent(companyId, "Dependent");

    const anchorIssueId = await seedIssue({
      companyId, title: "Decision anchor", status: "in_progress", assigneeAgentId: ownerAgentId,
    });
    const blockerIssueId = await seedIssue({
      companyId, title: "Member blocker", status: "in_progress", parentId: anchorIssueId,
    });
    const dependentIssueId = await seedIssue({
      companyId, title: "Blocked dependent", status: "blocked", assigneeAgentId: depAgentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
      createdByUserId: "board-user",
    });

    const created = await createApprovalDecision(db, {
      companyId,
      type: "budget_change",
      payload: { proposal: "freeze the cone", subjectRevision: 1 },
      issueIds: [anchorIssueId],
      requestedByAgentId: ownerAgentId,
      requestedByUserId: null,
      decisionLease: {
        idempotencyKey: `decision:${anchorIssueId}:plan:1`,
        posture: { status: "in_review", comment: "Plan ready for review." },
      },
    });
    expect(created.applied).toBe(true);
    const lease = created.lease!;

    // The reverse-blocks dependent is materialized as a cone member.
    const memberIds = await db
      .select({ issueId: decisionLeaseMembers.issueId })
      .from(decisionLeaseMembers)
      .where(eq(decisionLeaseMembers.leaseId, lease.id))
      .then((rows) => rows.map((row) => row.issueId).sort());
    expect(memberIds).toEqual([anchorIssueId, blockerIssueId, dependentIssueId].sort());

    // Board resolves the blocker through the real PATCH route.
    const boardApp = await createIssueApp(boardActor(companyId));
    const patchResponse = await request(boardApp)
      .patch(`/api/issues/${blockerIssueId}`)
      .send({ status: "done" });
    expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(200);

    // The blocker-resolved wake for the frozen dependent is refused by the
    // freeze (skip-recorded), not queued. Wake scheduling is async — wait for
    // the attempt to land before asserting.
    await vi.waitFor(async () => {
      const depWakes = await db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, depAgentId));
      expect(depWakes.length).toBeGreaterThan(0);
    }, { timeout: 10_000 });

    const depWakesWhileFrozen = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, depAgentId));
    expect(depWakesWhileFrozen.every((wake) => wake.status === "skipped")).toBe(true);
    expect(depWakesWhileFrozen.some((wake) => wake.reason === DECISION_FREEZE_ACTIVE_ERROR_CODE)).toBe(true);
    expect(await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, depAgentId))).toHaveLength(0);
    expect(await issueStatus(dependentIssueId)).toBe("blocked");
    expect(await issueStatus(blockerIssueId)).toBe("done");
    expect(await getActiveDecisionFreeze(db, companyId, dependentIssueId)).not.toBeNull();

    // No continuation exists yet.
    expect(await db.select().from(decisionContinuations).where(eq(decisionContinuations.leaseId, lease.id)))
      .toHaveLength(0);

    // Board approves → release + exactly one continuation-driven wake.
    const approvalApp = await createApprovalApp();
    const approveResponse = await request(approvalApp)
      .post(`/api/approvals/${created.approval.id}/approve`)
      .send({ decisionNote: "approved" });
    expect(approveResponse.status, JSON.stringify(approveResponse.body)).toBe(200);

    const continuations = await db
      .select()
      .from(decisionContinuations)
      .where(eq(decisionContinuations.leaseId, lease.id));
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.disposition).toBe("approved");
    expect(await getActiveDecisionFreeze(db, companyId, dependentIssueId)).toBeNull();

    const continuationWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `decision:${lease.id}:approved`));
    expect(continuationWakes).toHaveLength(1);
    expect(continuationWakes[0]!.agentId).toBe(ownerAgentId);
    expect((continuationWakes[0]!.payload as Record<string, unknown>).revalidate).toBe(true);

    // No blocker-wake burst after release: the only non-skipped wakes in the
    // system are the single continuation delivery (the frozen-time attempts
    // stay terminal skip records).
    const nonSkippedBlockerWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        notInArray(agentWakeupRequests.status, ["skipped", "cancelled"]),
      ));
    expect(nonSkippedBlockerWakes).toHaveLength(0);
    const depWakesAfterRelease = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, depAgentId),
        notInArray(agentWakeupRequests.status, ["skipped", "cancelled"]),
      ));
    expect(depWakesAfterRelease).toHaveLength(0);
  }, 120_000);

  it("(b) a human comment on a done issue never changes status; explicit reopen:true by a board user still works", async () => {
    const companyId = await seedCompany();
    const assigneeAgentId = await seedAgent(companyId, "Assignee");
    const doneIssueId = await seedIssue({
      companyId, title: "Finished work", status: "done", assigneeAgentId,
    });

    const boardApp = await createIssueApp(boardActor(companyId));

    // Plain human comment: recorded, status unchanged, no reopen wake.
    const commentResponse = await request(boardApp)
      .post(`/api/issues/${doneIssueId}/comments`)
      .send({ body: "Following up on this after the fact." });
    expect(commentResponse.status, JSON.stringify(commentResponse.body)).toBe(201);
    expect(await issueStatus(doneIssueId)).toBe("done");
    // Give the async wake scheduler a beat, then confirm nothing woke.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, assigneeAgentId))).toHaveLength(0);

    // PATCH comment without explicit intent: same contract.
    const patchCommentResponse = await request(boardApp)
      .patch(`/api/issues/${doneIssueId}`)
      .send({ comment: "Still just a comment." });
    expect(patchCommentResponse.status, JSON.stringify(patchCommentResponse.body)).toBe(200);
    expect(await issueStatus(doneIssueId)).toBe("done");

    // Explicit reopen by a board user still works.
    const reopenResponse = await request(boardApp)
      .patch(`/api/issues/${doneIssueId}`)
      .send({ comment: "Please take another pass.", reopen: true });
    expect(reopenResponse.status, JSON.stringify(reopenResponse.body)).toBe(200);
    expect(await issueStatus(doneIssueId)).toBe("todo");
    await vi.waitFor(async () => {
      const reopenWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.agentId, assigneeAgentId),
          eq(agentWakeupRequests.reason, "issue_reopened_via_comment"),
        ));
      expect(reopenWakes).toHaveLength(1);
    }, { timeout: 10_000 });
  }, 120_000);

  it("(c) an agent comment on a terminal issue produces no reopen and no wake", async () => {
    const companyId = await seedCompany();
    const assigneeAgentId = await seedAgent(companyId, "Assignee");
    const doneIssueId = await seedIssue({
      companyId, title: "Closed by the agent", status: "done", assigneeAgentId,
    });

    const agentApp = await createIssueApp(agentActor(companyId, assigneeAgentId));
    const commentResponse = await request(agentApp)
      .post(`/api/issues/${doneIssueId}/comments`)
      .send({ body: "Post-completion log line." });
    expect(commentResponse.status, JSON.stringify(commentResponse.body)).toBe(201);
    expect(await issueStatus(doneIssueId)).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
  }, 120_000);

  it("(d) mutation gate: agent writes on frozen members 422; board exempt; revising anchor-owner exemption is anchor-only", async () => {
    const companyId = await seedCompany();
    const ownerAgentId = await seedAgent(companyId, "Owner");
    const siblingAgentId = await seedAgent(companyId, "Sibling");

    const anchorIssueId = await seedIssue({
      companyId, title: "Gate anchor", status: "in_progress", assigneeAgentId: ownerAgentId,
    });
    const siblingIssueId = await seedIssue({
      companyId, title: "Gated sibling member", status: "todo", assigneeAgentId: siblingAgentId, parentId: anchorIssueId,
    });

    const created = await createApprovalDecision(db, {
      companyId,
      type: "budget_change",
      payload: { proposal: "gate the cone", subjectRevision: 1 },
      issueIds: [anchorIssueId],
      requestedByAgentId: ownerAgentId,
      requestedByUserId: null,
      decisionLease: {
        idempotencyKey: `decision:${anchorIssueId}:plan:1`,
        posture: { status: "in_review", comment: "Plan ready for review." },
      },
    });
    expect(created.applied).toBe(true);
    const lease = created.lease!;

    const siblingApp = await createIssueApp(agentActor(companyId, siblingAgentId));
    const ownerApp = await createIssueApp(agentActor(companyId, ownerAgentId));
    const boardApp = await createIssueApp(boardActor(companyId));

    const expectFreezeRejected = (response: request.Response) => {
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.code).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);
      expect(response.body.details.leaseId).toBe(lease.id);
    };

    // Agent PATCH on a frozen member → 422.
    expectFreezeRejected(await request(siblingApp)
      .patch(`/api/issues/${siblingIssueId}`)
      .send({ status: "in_progress", comment: "picking this up" }));
    // Agent comment create → 422.
    expectFreezeRejected(await request(siblingApp)
      .post(`/api/issues/${siblingIssueId}/comments`)
      .send({ body: "commenting into the freeze" }));
    // Agent document PUT → 422.
    expectFreezeRejected(await request(siblingApp)
      .put(`/api/issues/${siblingIssueId}/documents/plan`)
      .send({ format: "markdown", body: "# sneaky plan" }));
    // Agent attachment create → 422.
    expectFreezeRejected(await request(siblingApp)
      .post(`/api/companies/${companyId}/issues/${siblingIssueId}/attachments`)
      .attach("file", Buffer.from("hello"), "note.txt"));
    // Agent work-product create → 422.
    expectFreezeRejected(await request(siblingApp)
      .post(`/api/issues/${siblingIssueId}/work-products`)
      .send({ type: "document", provider: "test", title: "Doc" }));
    // Agent child create under a frozen member → 422.
    expectFreezeRejected(await request(siblingApp)
      .post(`/api/issues/${siblingIssueId}/children`)
      .send({ title: "child inside the cone" }));
    expect(await issueStatus(siblingIssueId)).toBe("todo");

    // Board users remain unrestricted (they are the deciders).
    const boardPatch = await request(boardApp)
      .patch(`/api/issues/${siblingIssueId}`)
      .send({ comment: "board note during the wait" });
    expect(boardPatch.status, JSON.stringify(boardPatch.body)).toBe(200);
    const boardComment = await request(boardApp)
      .post(`/api/issues/${siblingIssueId}/comments`)
      .send({ body: "second board note" });
    expect(boardComment.status, JSON.stringify(boardComment.body)).toBe(201);

    // Request revision → lease `revising`, cone still frozen.
    const approvalApp = await createApprovalApp();
    const revisionResponse = await request(approvalApp)
      .post(`/api/approvals/${created.approval.id}/request-revision`)
      .send({ decisionNote: "tighten the plan" });
    expect(revisionResponse.status, JSON.stringify(revisionResponse.body)).toBe(200);
    const revisingLease = await db
      .select({ state: decisionLeases.state })
      .from(decisionLeases)
      .where(eq(decisionLeases.id, lease.id))
      .then((rows) => rows[0]!);
    expect(revisingLease.state).toBe("revising");

    // Anchor-owner exemption while revising: comment + document PUT on the
    // anchor only.
    const ownerComment = await request(ownerApp)
      .post(`/api/issues/${anchorIssueId}/comments`)
      .send({ body: "Revised plan incoming." });
    expect(ownerComment.status, JSON.stringify(ownerComment.body)).toBe(201);
    const ownerDocument = await request(ownerApp)
      .put(`/api/issues/${anchorIssueId}/documents/plan`)
      .send({ format: "markdown", body: "# plan v2" });
    expect([200, 201]).toContain(ownerDocument.status);
    const ownerCommentOnlyPatch = await request(ownerApp)
      .patch(`/api/issues/${anchorIssueId}`)
      .send({ comment: "Plan v2 attached." });
    expect(ownerCommentOnlyPatch.status, JSON.stringify(ownerCommentOnlyPatch.body)).toBe(200);

    // The exemption does NOT extend to non-comment PATCHes on the anchor...
    const ownerStatusPatch = await request(ownerApp)
      .patch(`/api/issues/${anchorIssueId}`)
      .send({ status: "in_progress" });
    expectFreezeRejected(ownerStatusPatch);
    // ...nor to a different agent on the anchor (either the authorization
    // boundary 403s first or the freeze gate 422s — never a success)...
    const siblingOnAnchor = await request(siblingApp)
      .post(`/api/issues/${anchorIssueId}/comments`)
      .send({ body: "not my anchor" });
    expect([403, 422], JSON.stringify(siblingOnAnchor.body)).toContain(siblingOnAnchor.status);
    // ...nor to sibling members, which stay fully gated.
    expectFreezeRejected(await request(siblingApp)
      .post(`/api/issues/${siblingIssueId}/comments`)
      .send({ body: "still frozen while revising" }));
    expectFreezeRejected(await request(siblingApp)
      .put(`/api/issues/${siblingIssueId}/documents/plan`)
      .send({ format: "markdown", body: "# still no" }));
  }, 120_000);

  it("(e) pick-work exclusion (R3.4): frozen members vanish from the assignee+status list shape and reappear on release", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, "Worker");
    const ownerAgentId = await seedAgent(companyId, "Owner");

    const anchorIssueId = await seedIssue({
      companyId, title: "Exclusion anchor", status: "in_progress", assigneeAgentId: ownerAgentId,
    });
    const frozenInProgressId = await seedIssue({
      companyId, title: "Frozen in-progress member", status: "in_progress", assigneeAgentId: workerAgentId, parentId: anchorIssueId,
    });
    const frozenBlockedId = await seedIssue({
      companyId, title: "Frozen blocked member", status: "blocked", assigneeAgentId: workerAgentId, parentId: anchorIssueId,
    });
    const unrelatedTodoId = await seedIssue({
      companyId, title: "Unrelated todo for the same agent", status: "todo", assigneeAgentId: workerAgentId,
    });

    // This is the exact list shape inbox-lite (routes/agents.ts), the assignee
    // skill fallback, and the MCP inbox (GET /agents/me/inbox-lite) all call.
    const { issueService } = await import("../services/issues.js");
    const issuesSvc = issueService(db);
    const listAssigned = async () => {
      const rows = await issuesSvc.list(companyId, {
        assigneeAgentId: workerAgentId,
        status: "todo,in_progress,blocked",
      });
      return rows.map((row: { id: string }) => row.id).sort();
    };

    expect(await listAssigned()).toEqual([frozenBlockedId, frozenInProgressId, unrelatedTodoId].sort());

    const created = await createApprovalDecision(db, {
      companyId,
      type: "budget_change",
      payload: { proposal: "hide the members", subjectRevision: 1 },
      issueIds: [anchorIssueId],
      requestedByAgentId: ownerAgentId,
      requestedByUserId: null,
      decisionLease: {
        idempotencyKey: `decision:${anchorIssueId}:plan:1`,
        posture: { status: "in_review", comment: "Plan ready for review." },
      },
    });
    expect(created.applied).toBe(true);

    // Frozen members vanish; the unrelated todo for the same agent stays.
    expect(await listAssigned()).toEqual([unrelatedTodoId]);

    // Release → members reappear.
    const approvalApp = await createApprovalApp();
    const approveResponse = await request(approvalApp)
      .post(`/api/approvals/${created.approval.id}/approve`)
      .send({ decisionNote: "approved" });
    expect(approveResponse.status, JSON.stringify(approveResponse.body)).toBe(200);
    expect(await listAssigned()).toEqual([frozenBlockedId, frozenInProgressId, unrelatedTodoId].sort());
  }, 120_000);
});
