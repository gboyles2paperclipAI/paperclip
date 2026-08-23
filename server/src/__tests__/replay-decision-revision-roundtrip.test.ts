import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { desc, eq, like } from "drizzle-orm";
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
import { createApprovalDecision } from "../services/decision-leases.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * R3.1 replay: revision is a NON-releasing lease substate. request-revision
 * moves the lease to `revising` while the cone stays fully frozen; the owner
 * gets exactly one bounded revision wake (keyed per distinct revision
 * request); resubmitting the SAME decision idempotency key revises the same
 * decision (no second lease); and the eventual board approval writes exactly
 * one continuation with disposition `approved`.
 *
 * (PR-2a scope note: the owner-exemption mutation-gate assertions — document
 * PUT/comment by the anchor assignee during `revising`, sibling member 422 —
 * are PR-2b, which wires `assertNotDecisionFrozen` into the write routes. The
 * wake-layer freeze on sibling members IS asserted here.)
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Decision revision round-trip test run.",
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
    `Skipping embedded Postgres decision revision round-trip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("replay — decision revision round-trip (R3.1)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-replay-decision-revision-");
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

  it("request-revision keeps the cone frozen, resubmit reuses the same decision, board approve writes exactly one approved continuation", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const siblingAgentId = randomUUID();
    const anchorIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [agentId, name] of [[ownerAgentId, "Owner"], [siblingAgentId, "Sibling"]] as const) {
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
    }
    await db.insert(issues).values({
      id: anchorIssueId,
      companyId,
      title: "Revision anchor",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId,
      title: "Frozen sibling member",
      status: "todo",
      priority: "medium",
      parentId: anchorIssueId,
      assigneeAgentId: siblingAgentId,
      responsibleUserId: "responsible-user",
    });

    const decisionKey = `decision:${anchorIssueId}:plan:1`;
    const created = await createApprovalDecision(db, {
      companyId,
      type: "budget_change",
      payload: { proposal: "plan v1", subjectRevision: 1 },
      issueIds: [anchorIssueId, siblingIssueId],
      requestedByAgentId: ownerAgentId,
      requestedByUserId: null,
      decisionLease: {
        idempotencyKey: decisionKey,
        posture: { status: "in_review", comment: "Plan v1 ready for review." },
      },
    });
    expect(created.applied).toBe(true);
    const lease = created.lease!;
    const app = await createBoardApp();

    // Board requests a revision.
    const revisionResponse = await request(app)
      .post(`/api/approvals/${created.approval.id}/request-revision`)
      .send({ decisionNote: "tighten the rollout plan" });
    expect(revisionResponse.status).toBe(200);

    // R3.1: the lease is `revising`, NOT released; no continuation exists.
    const revisingLease = await db
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, lease.id))
      .then((rows) => rows[0]!);
    expect(revisingLease.state).toBe("revising");
    expect(revisingLease.releasedAt).toBeNull();
    expect(await db.select().from(decisionContinuations).where(eq(decisionContinuations.leaseId, lease.id)))
      .toHaveLength(0);

    // The cone is still frozen — anchor AND sibling member.
    const anchorFreeze = await getActiveDecisionFreeze(db, companyId, anchorIssueId);
    expect(anchorFreeze).toEqual({ leaseId: lease.id, state: "revising", anchorIssueId });
    expect(await getActiveDecisionFreeze(db, companyId, siblingIssueId)).not.toBeNull();

    // Exactly one bounded revision wake reached the OWNER (the revision
    // bypass admits only the anchor assignee while revising).
    const revisionWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(like(agentWakeupRequests.idempotencyKey, `decision:${lease.id}:revision:%`));
    expect(revisionWakes).toHaveLength(1);
    expect(revisionWakes[0]!.agentId).toBe(ownerAgentId);
    expect(revisionWakes[0]!.status).not.toBe("skipped");

    // A sibling-member wake attempt is still refused by the freeze.
    const siblingWake = await heartbeat.wakeup(siblingAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: siblingIssueId },
      contextSnapshot: { issueId: siblingIssueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(siblingWake).toBeNull();
    const latestSiblingWake = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, siblingAgentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    expect(latestSiblingWake?.status).toBe("skipped");
    expect(latestSiblingWake?.reason).toBe(DECISION_FREEZE_ACTIVE_ERROR_CODE);

    // Owner resubmits the SAME decision (same idempotency key → same lease,
    // no second lease row).
    const resubmitResponse = await request(app)
      .post(`/api/approvals/${created.approval.id}/resubmit`)
      .send({ payload: { proposal: "plan v2 (tightened rollout)", subjectRevision: 1 } });
    expect(resubmitResponse.status).toBe(200);
    expect(resubmitResponse.body.status).toBe("pending");

    const leasesForKey = await db
      .select({ id: decisionLeases.id, state: decisionLeases.state })
      .from(decisionLeases)
      .where(eq(decisionLeases.decisionIdempotencyKey, decisionKey));
    expect(leasesForKey).toHaveLength(1);
    expect(leasesForKey[0]!.id).toBe(lease.id);
    expect(leasesForKey[0]!.state).toBe("revising");
    expect(await getActiveDecisionFreeze(db, companyId, siblingIssueId)).not.toBeNull();

    // Board approves the resubmission → exactly ONE continuation, approved.
    const approveResponse = await request(app)
      .post(`/api/approvals/${created.approval.id}/approve`)
      .send({ decisionNote: "v2 approved" });
    expect(approveResponse.status).toBe(200);

    const continuations = await db
      .select()
      .from(decisionContinuations)
      .where(eq(decisionContinuations.leaseId, lease.id));
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.disposition).toBe("approved");

    const releasedLease = await db
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, lease.id))
      .then((rows) => rows[0]!);
    expect(releasedLease.state).toBe("released");
    expect(releasedLease.disposition).toBe("approved");
    expect(await getActiveDecisionFreeze(db, companyId, anchorIssueId)).toBeNull();
    expect(await getActiveDecisionFreeze(db, companyId, siblingIssueId)).toBeNull();

    // Exactly one outbox wake with the approved key reached the owner.
    const approvedWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `decision:${lease.id}:approved`));
    expect(approvedWakes).toHaveLength(1);
    expect(approvedWakes[0]!.agentId).toBe(ownerAgentId);
    expect((approvedWakes[0]!.payload as Record<string, unknown>).revalidate).toBe(true);
  }, 120_000);
});
