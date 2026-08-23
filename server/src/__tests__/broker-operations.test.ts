import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  approvals,
  brokerOperations,
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
  instanceSettings,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, waitForAllHeartbeatRunExecutionsDrain } from "../services/heartbeat.ts";
import { dispatchDecisionContinuations } from "../services/decision-leases.ts";
import {
  claimBrokerOperation,
  enqueueBrokerOperationForApprovedDecision,
  heartbeatBrokerOperation,
  submitBrokerOperationReceipt,
} from "../services/broker-operations.ts";
import { computeCompletionContractPreimageSha256 } from "../services/completion-contracts.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * PR-5 — approved-action broker (ADR-20260823-quiescent-coordination R2.16,
 * R3.6, R3.7). Against the real embedded-PG writers this suite proves:
 *   (1) request time inserts NOTHING; missing/rejected/pending/tampered
 *       approvals refuse enqueue; replays are no-ops;
 *   (2) approval acceptance enqueues EXACTLY ONCE through the continuation
 *       consumer (replayed twice) and attaches the completion contract to
 *       EVERY linked issue (R3.7);
 *   (3) concurrent duplicate claims have one winner via the generation CAS
 *       (loser 409); agents cannot claim (403);
 *   (4) stale-heartbeat reclaim bumps the generation and the old claimer's
 *       receipt is rejected;
 *   (5) a preflight-failure receipt records evidence with ZERO issue mutation;
 *   (6) a succeeded receipt is forwarded into every linked issue's
 *       completionReceipt and the issue can then go done (PR-3 integration);
 *   (7) rollback evidence lands in rollback_state, state rolled_back, exactly
 *       one loud activity (nonterminal);
 *   (8) evidence hygiene: free-text beyond the bounded note is zod-rejected.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "PR-5 broker test run.",
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
    `Skipping embedded Postgres broker-operation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SOURCE_SHA = createHash("sha256").update("broker-quarantine-source-bytes").digest("hex");
const SOURCE_PATH = "/var/tmp/uw-archive/entry-000141.json";
const TARGET_PATH = "/backups/uw-quarantine/entry-000141.json";
const BASELINE_COUNT = 42;

const QUARANTINE_REQUEST = {
  name: "quarantine_exact_file" as const,
  args: {
    sourcePath: SOURCE_PATH,
    sourceContentSha256: SOURCE_SHA,
    quarantineTargetPath: TARGET_PATH,
    sourceDirEntryBaselineCount: BASELINE_COUNT,
  },
};

const QUARANTINE_PREIMAGE_SHA = computeCompletionContractPreimageSha256({
  contractType: "exact_file_quarantine",
  version: 1,
  preimage: {
    sourcePath: SOURCE_PATH,
    sourceContentSha256: SOURCE_SHA,
    quarantineTargetPath: TARGET_PATH,
    sourceDirEntryBaselineCount: BASELINE_COUNT,
    executorIdentity: "broker",
    reviewerRequired: true,
    rollbackArchiveRequired: true,
  },
});

const ARTIFACT_SHA = createHash("sha256").update("candidate-runtime-tarball-bytes").digest("hex");
const PREVIOUS_RUNTIME_SHA = createHash("sha256").update("previous-runtime-archive-bytes").digest("hex");

const ACTIVATION_REQUEST = {
  name: "activate_runtime_candidate" as const,
  args: {
    candidateRootPath: "/home/paperclipadmin/ful-candidate/prefix",
    artifactSha256s: [ARTIFACT_SHA],
    expectedVersion: "0.3.2-help2day.1",
    expectedBuildCommit: null,
  },
};

const ACTIVATION_PREIMAGE_SHA = computeCompletionContractPreimageSha256({
  contractType: "packaged_runtime_activation",
  version: 1,
  preimage: {
    candidateRootPath: ACTIVATION_REQUEST.args.candidateRootPath,
    artifactSha256s: ACTIVATION_REQUEST.args.artifactSha256s,
    expectedVersion: ACTIVATION_REQUEST.args.expectedVersion,
    expectedBuildCommit: null,
    installerIdentity: "broker",
    rollbackArchiveRequired: true,
  },
});

function buildQuarantineReceipt(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    contractType: "exact_file_quarantine",
    version: 1,
    contractRevision: 1,
    preimageSha256: QUARANTINE_PREIMAGE_SHA,
    executionRunId: operationId,
    executorIdentity: "broker",
    reviewerIdentity: "reviewer-agent",
    rollbackEvidence: { archivePath: TARGET_PATH, archiveSha256: SOURCE_SHA },
    assertions: {
      sourceAbsentFromSourceDir: true,
      targetPresentWithMatchingHash: true,
      observedTargetContentSha256: SOURCE_SHA,
      observedSourceDirEntryCount: BASELINE_COUNT - 1,
      movedEntryPaths: [SOURCE_PATH],
    },
    ...overrides,
  };
}

function buildActivationReceipt(operationId: string) {
  return {
    contractType: "packaged_runtime_activation",
    version: 1,
    contractRevision: 1,
    preimageSha256: ACTIVATION_PREIMAGE_SHA,
    executionRunId: operationId,
    executorIdentity: "broker",
    rollbackEvidence: {
      archivePath: "/backups/runtime-rollback/paperclipai-previous.tgz",
      archiveSha256: PREVIOUS_RUNTIME_SHA,
    },
    assertions: {
      activatedVersion: ACTIVATION_REQUEST.args.expectedVersion,
      activatedBuildCommit: null,
      verifiedArtifactSha256s: [ARTIFACT_SHA],
      healthVerified: true,
    },
  };
}

describeEmbeddedPostgres("broker operations — approved-action broker (PR-5)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-broker-operations-");
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
        await db.delete(brokerOperations);
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
        await db.delete(instanceSettings);
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
      title: "Broker anchor",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Broker child",
      status: "todo",
      priority: "medium",
      parentId: anchorIssueId,
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, anchorIssueId, childIssueId };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    } as Express.Request["actor"];
  }

  async function createApp(actor: Express.Request["actor"]) {
    const [{ errorHandler }, { approvalRoutes }, { brokerOperationRoutes }, { issueRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/approvals.js"),
      import("../routes/broker-operations.js"),
      import("../routes/issues.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", approvalRoutes(db));
    app.use("/api", brokerOperationRoutes(db));
    // The status PATCH path never touches storage; a stub suffices (same
    // pattern as replay-ful20271).
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function createBoardApp(companyId: string) {
    return createApp(boardActor(companyId));
  }

  async function createAgentApp(companyId: string, agentId: string) {
    return createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    } as Express.Request["actor"]);
  }

  function approvalCreateBody(
    seed: { agentId: string; anchorIssueId: string; childIssueId: string },
    brokerRequest: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    return {
      type: "request_board_approval",
      requestedByAgentId: seed.agentId,
      issueIds: [seed.anchorIssueId, seed.childIssueId],
      payload: { title: "Approve broker-executed operation", subjectRevision: 1 },
      decisionLease: {
        idempotencyKey,
        posture: {
          status: "in_review" as const,
          comment: "## Decision requested\nBroker operation evidence attached.",
        },
      },
      brokerOperation: brokerRequest,
    };
  }

  async function createBrokerApproval(
    app: express.Express,
    seed: { companyId: string; agentId: string; anchorIssueId: string; childIssueId: string },
    brokerRequest: Record<string, unknown> = QUARANTINE_REQUEST,
  ) {
    const res = await request(app)
      .post(`/api/companies/${seed.companyId}/approvals`)
      .send(approvalCreateBody(seed, brokerRequest, `decision:${seed.anchorIssueId}:broker:1`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function approveViaRoute(app: express.Express, approvalId: string) {
    const res = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .send({ decisionNote: "GO" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function brokerRowsForApproval(approvalId: string) {
    return db.select().from(brokerOperations).where(eq(brokerOperations.approvalId, approvalId));
  }

  async function approveAndGetOperation(seed: Awaited<ReturnType<typeof seedCompanyAgentAnchorChild>>, brokerRequest: Record<string, unknown> = QUARANTINE_REQUEST) {
    const app = await createBoardApp(seed.companyId);
    const approval = await createBrokerApproval(app, seed, brokerRequest);
    await approveViaRoute(app, approval.id);
    const rows = await brokerRowsForApproval(approval.id);
    expect(rows).toHaveLength(1);
    return { app, approvalId: approval.id, operation: rows[0]! };
  }

  it("(1) request time inserts nothing; missing/pending/rejected/tampered approvals refuse enqueue; replays are no-ops", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const app = await createBoardApp(seed.companyId);

    // brokerOperation without a decisionLease is refused at create.
    const noLease = await request(app)
      .post(`/api/companies/${seed.companyId}/approvals`)
      .send({
        type: "request_board_approval",
        issueIds: [seed.anchorIssueId],
        payload: { title: "no lease" },
        brokerOperation: QUARANTINE_REQUEST,
      });
    expect(noLease.status).toBe(422);

    // Malformed args (free text where a hash belongs) are zod-rejected.
    const badArgs = await request(app)
      .post(`/api/companies/${seed.companyId}/approvals`)
      .send(approvalCreateBody(seed, {
        name: "quarantine_exact_file",
        args: { ...QUARANTINE_REQUEST.args, sourceContentSha256: "not-a-hash" },
      }, `decision:${seed.anchorIssueId}:broker:bad`));
    expect(badArgs.status).toBe(400);

    // A valid create binds the request + hashes into the payload and inserts
    // NO broker_operations row.
    const approval = await createBrokerApproval(app, seed);
    const storedApproval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect((storedApproval.payload as Record<string, any>).brokerOperation).toMatchObject({
      request: QUARANTINE_REQUEST,
      rollbackOperation: "restore_quarantined_exact_file",
    });
    expect(await db.select().from(brokerOperations)).toHaveLength(0);

    // Pending (not yet approved) refuses.
    expect(await enqueueBrokerOperationForApprovedDecision(db, { approvalId: approval.id }))
      .toEqual({ outcome: "refused", reason: "approval_not_approved" });
    // Missing refuses.
    expect(await enqueueBrokerOperationForApprovedDecision(db, { approvalId: randomUUID() }))
      .toEqual({ outcome: "refused", reason: "approval_missing" });

    // Rejected: the continuation consumer runs (disposition rejected) and
    // never enqueues; a direct call also refuses.
    const rejectRes = await request(app)
      .post(`/api/approvals/${approval.id}/reject`)
      .send({ decisionNote: "not now" });
    expect(rejectRes.status).toBe(200);
    expect(await db.select().from(brokerOperations)).toHaveLength(0);
    expect(await enqueueBrokerOperationForApprovedDecision(db, { approvalId: approval.id }))
      .toEqual({ outcome: "refused", reason: "approval_not_approved" });

    // Tampered/wrong-target payload: approved, but the stored broker block no
    // longer parses → refuse loudly, zero rows, continuation still consumed.
    const seed2 = await seedCompanyAgentAnchorChild();
    const app2 = await createBoardApp(seed2.companyId);
    const approval2 = await createBrokerApproval(app2, seed2);
    await db
      .update(approvals)
      .set({
        payload: {
          title: "tampered",
          brokerOperation: { request: { name: "quarantine_exact_file", args: { sourcePath: "relative/path" } } },
        },
      })
      .where(eq(approvals.id, approval2.id));
    await approveViaRoute(app2, approval2.id);
    expect(await db.select().from(brokerOperations)).toHaveLength(0);
    const continuations = await db.select().from(decisionContinuations);
    expect(continuations.every((row) => row.consumedAt !== null)).toBe(true);
  }, 120_000);

  it("(2) approval acceptance enqueues exactly once through the continuation consumer, replayed twice, and attaches the contract to every linked issue", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { approvalId, operation } = await approveAndGetOperation(seed);

    expect(operation.state).toBe("enqueued");
    expect(operation.claimGeneration).toBe(0);
    expect(operation.name).toBe("quarantine_exact_file");
    expect(operation.idempotencyKey).toBe(`broker:${approvalId}:quarantine_exact_file`);
    expect((operation.args as Record<string, unknown>).rollbackOperation)
      .toBe("restore_quarantined_exact_file");

    // R3.7: EVERY linked issue carries the preimage-bound contract.
    for (const issueId of [seed.anchorIssueId, seed.childIssueId]) {
      const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      const contract = row.completionContract as Record<string, any>;
      expect(contract, issueId).not.toBeNull();
      expect(contract.contractType).toBe("exact_file_quarantine");
      expect(contract.preimageSha256).toBe(QUARANTINE_PREIMAGE_SHA);
      expect(contract.preimage.executorIdentity).toBe("broker");
    }

    // Replay the continuation consumer twice: nothing new is scanned and no
    // second row appears; a direct enqueue replay is applied:false.
    const sweep1 = await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeat.wakeup });
    const sweep2 = await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeat.wakeup });
    expect(sweep1.scanned + sweep2.scanned).toBe(0);
    const replay = await enqueueBrokerOperationForApprovedDecision(db, { approvalId });
    expect(replay.outcome).toBe("enqueued");
    if (replay.outcome === "enqueued") {
      expect(replay.applied).toBe(false);
      expect(replay.operation.id).toBe(operation.id);
    }
    expect(await brokerRowsForApproval(approvalId)).toHaveLength(1);

    // Exactly one enqueue activity.
    const enqueueActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "broker_operation.enqueued"), eq(activityLog.entityId, operation.id)));
    expect(enqueueActivities).toHaveLength(1);

    // The continuation wake instructs the owner that the broker executes.
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `decision:${(await db.select().from(decisionLeases).then((rows) => rows[0]!)).id}:approved`));
    expect(wakes).toHaveLength(1);
    const wakePayload = wakes[0]!.payload as Record<string, any>;
    expect(wakePayload.brokerOperationId).toBe(operation.id);
    expect(wakePayload.brokerOperation).toMatchObject({
      name: "quarantine_exact_file",
      executionModel: "broker_executes",
      ownerAction: "verify_only",
    });
  }, 120_000);

  it("(2b) a crash between enqueue and consume replays safely: the restarted consumer keeps one row and delivers once", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const app = await createBoardApp(seed.companyId);
    const approval = await createBrokerApproval(app, seed);

    // Approve WITHOUT the route's immediate dispatch: flip the approval and
    // resolve the lease directly, then "crash" before the dispatcher runs.
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval.id));
    const { buildContinuationPayloadForLease, resolveLease } = await import("../services/decision-leases.ts");
    const lease = await db.select().from(decisionLeases).then((rows) => rows[0]!);
    const payload = await buildContinuationPayloadForLease(db, lease, "approved");
    expect((await resolveLease(db, lease.id, "approved", { payload })).applied).toBe(true);

    // First consumer attempt enqueues; pretend it crashed AFTER enqueue but
    // BEFORE consume by calling the enqueue hook directly first.
    const first = await enqueueBrokerOperationForApprovedDecision(db, { approvalId: approval.id });
    expect(first.outcome).toBe("enqueued");
    // The restarted consumer replays: enqueue is a no-op, wake delivered once.
    const sweep = await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeat.wakeup });
    expect(sweep.delivered).toBe(1);
    expect(await brokerRowsForApproval(approval.id)).toHaveLength(1);
    const secondSweep = await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeat.wakeup });
    expect(secondSweep.scanned).toBe(0);
  }, 120_000);

  it("(3) concurrent duplicate claims: one winner via the generation CAS, the loser gets 409; agents cannot claim", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);

    const settled = await Promise.allSettled([
      claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 }),
      claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-b", expectedGeneration: 0 }),
    ]);
    const wins = settled.filter((entry) => entry.status === "fulfilled");
    const losses = settled.filter((entry) => entry.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const row = await db.select().from(brokerOperations).where(eq(brokerOperations.id, operation.id)).then((rows) => rows[0]!);
    expect(row.state).toBe("claimed");
    expect(row.claimGeneration).toBe(1);
    expect(row.claimHeartbeatAt).not.toBeNull();
    expect(["host-broker-a", "host-broker-b"]).toContain(row.claimedBy);

    // A second claim with the stale generation is refused over the route too.
    const staleClaim = await request(app)
      .post(`/api/broker-operations/${operation.id}/claim`)
      .send({ claimedBy: "host-broker-c", expectedGeneration: 0 });
    expect(staleClaim.status).toBe(409);

    // Agents can never claim/heartbeat/receipt (board/system-only surface).
    const agentApp = await createAgentApp(seed.companyId, seed.agentId);
    for (const [path, body] of [
      ["claim", { claimedBy: "host-broker-a", expectedGeneration: 1 }],
      ["heartbeat", { claimedBy: row.claimedBy, claimGeneration: 1 }],
      ["receipt", { claimedBy: row.claimedBy, claimGeneration: 1, outcome: "failed" }],
    ] as const) {
      const res = await request(agentApp)
        .post(`/api/broker-operations/${operation.id}/${path}`)
        .send(body);
      expect(res.status, path).toBe(403);
    }
  }, 120_000);

  it("(4) stale-heartbeat reclaim bumps the generation, alerts once, and the old claimer's receipt is rejected", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);

    const claimed = await request(app)
      .post(`/api/broker-operations/${operation.id}/claim`)
      .send({ claimedBy: "host-broker-a", expectedGeneration: 0 });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.claimGeneration).toBe(1);
    expect(claimed.body.reclaimed).toBe(false);

    // Heartbeat: holder refreshes; a non-holder is refused.
    const beat = await request(app)
      .post(`/api/broker-operations/${operation.id}/heartbeat`)
      .send({ claimedBy: "host-broker-a", claimGeneration: 1 });
    expect(beat.status).toBe(200);
    const wrongBeat = await request(app)
      .post(`/api/broker-operations/${operation.id}/heartbeat`)
      .send({ claimedBy: "host-broker-b", claimGeneration: 1 });
    expect(wrongBeat.status).toBe(409);

    // Reclaim while the heartbeat is live is refused.
    await expect(claimBrokerOperation(db, {
      operationId: operation.id,
      claimedBy: "host-broker-b",
      expectedGeneration: 1,
    })).rejects.toMatchObject({ status: 409 });

    // Age the heartbeat past the (default 10 min) expiry and reclaim.
    await db
      .update(brokerOperations)
      .set({ claimHeartbeatAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(brokerOperations.id, operation.id));
    const reclaim = await request(app)
      .post(`/api/broker-operations/${operation.id}/claim`)
      .send({ claimedBy: "host-broker-b", expectedGeneration: 1 });
    expect(reclaim.status, JSON.stringify(reclaim.body)).toBe(200);
    expect(reclaim.body.claimGeneration).toBe(2);
    expect(reclaim.body.claimedBy).toBe("host-broker-b");
    expect(reclaim.body.reclaimed).toBe(true);

    const reclaimActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "broker_operation.reclaimed"), eq(activityLog.entityId, operation.id)));
    expect(reclaimActivities).toHaveLength(1);

    // The displaced claimer's writes fail the generation/identity fence.
    const staleBeat = await request(app)
      .post(`/api/broker-operations/${operation.id}/heartbeat`)
      .send({ claimedBy: "host-broker-a", claimGeneration: 1 });
    expect(staleBeat.status).toBe(409);
    const staleReceipt = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "succeeded",
        completionReceipt: buildQuarantineReceipt(operation.id),
      });
    expect(staleReceipt.status).toBe(409);

    // The live claimer's receipt still lands.
    const liveReceipt = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-b",
        claimGeneration: 2,
        outcome: "succeeded",
        completionReceipt: buildQuarantineReceipt(operation.id, { reviewerIdentity: "reviewer-agent" }),
      });
    expect(liveReceipt.status, JSON.stringify(liveReceipt.body)).toBe(200);
    expect(liveReceipt.body.state).toBe("succeeded");
  }, 120_000);

  it("(5) a preflight-failure receipt records evidence with zero issue mutation", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);
    await claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 });

    const issuesBefore = await db.select().from(issues).where(eq(issues.companyId, seed.companyId));

    const res = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "failed",
        preflight: { hashesVerified: false, mismatchCount: 1, note: "source hash changed since request" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("failed");

    const row = await db.select().from(brokerOperations).where(eq(brokerOperations.id, operation.id)).then((rows) => rows[0]!);
    expect(row.state).toBe("failed");
    expect((row.preflight as Record<string, unknown>).hashesVerified).toBe(false);
    expect(row.rollbackState).toBeNull();

    // ZERO mutation: statuses, receipts, and contracts unchanged.
    const issuesAfter = await db.select().from(issues).where(eq(issues.companyId, seed.companyId));
    const byId = new Map(issuesBefore.map((issue) => [issue.id, issue]));
    expect(issuesAfter).toHaveLength(issuesBefore.length);
    for (const after of issuesAfter) {
      const before = byId.get(after.id)!;
      expect(after.status).toBe(before.status);
      expect(after.completionReceipt).toBeNull();
      expect(after.completionContract).toEqual(before.completionContract);
    }
  }, 120_000);

  it("(6) a succeeded receipt is forwarded into every linked issue's contract acceptance, and the issue can then go done", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);
    await claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 });

    // A wrong-scope receipt (FUL-20271 shape) is rejected fail-closed: no
    // issue writes, operation still claimed.
    const wrongScope = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "succeeded",
        completionReceipt: buildQuarantineReceipt(operation.id, {
          assertions: {
            sourceAbsentFromSourceDir: false,
            targetPresentWithMatchingHash: true,
            observedTargetContentSha256: SOURCE_SHA,
            observedSourceDirEntryCount: 1,
            movedEntryPaths: ["/var/tmp/uw-archive/unrelated-000001.json"],
          },
        }),
      });
    expect(wrongScope.status, JSON.stringify(wrongScope.body)).toBe(422);
    expect(
      (await db.select().from(brokerOperations).where(eq(brokerOperations.id, operation.id)).then((rows) => rows[0]!)).state,
    ).toBe("claimed");

    const res = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "succeeded",
        completionReceipt: buildQuarantineReceipt(operation.id),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("succeeded");
    expect(new Set(res.body.forwardedIssueIds)).toEqual(new Set([seed.anchorIssueId, seed.childIssueId]));

    for (const issueId of [seed.anchorIssueId, seed.childIssueId]) {
      const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      const receipt = row.completionReceipt as Record<string, any>;
      expect(receipt, issueId).not.toBeNull();
      expect(receipt._acceptance).toMatchObject({
        issueId,
        executionRunId: operation.id,
        contractRevision: 1,
      });
    }

    // PR-3 integration: with the accepted receipt in place, done succeeds.
    const done = await request(app)
      .patch(`/api/issues/${seed.anchorIssueId}`)
      .send({ status: "done" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("done");

    // Receipt replay from the same claim is an idempotent no-op.
    const replay = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "succeeded",
        completionReceipt: buildQuarantineReceipt(operation.id),
      });
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(false);
  }, 120_000);

  it("(6b) the activation operation round-trips too: enqueue builds the packaged-runtime contract and the receipt forwards", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed, ACTIVATION_REQUEST);

    expect(operation.name).toBe("activate_runtime_candidate");
    expect((operation.args as Record<string, unknown>).rollbackOperation).toBe("restore_previous_runtime");
    const anchor = await db.select().from(issues).where(eq(issues.id, seed.anchorIssueId)).then((rows) => rows[0]!);
    const contract = anchor.completionContract as Record<string, any>;
    expect(contract.contractType).toBe("packaged_runtime_activation");
    expect(contract.preimageSha256).toBe(ACTIVATION_PREIMAGE_SHA);
    expect(contract.preimage.artifactSha256s).toEqual([ARTIFACT_SHA]);
    expect(contract.preimage.installerIdentity).toBe("broker");

    await claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 });
    const res = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "succeeded",
        completionReceipt: buildActivationReceipt(operation.id),
        preflight: { hashesVerified: true, observedSha256s: [ARTIFACT_SHA] },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("succeeded");

    const done = await request(app)
      .patch(`/api/issues/${seed.anchorIssueId}`)
      .send({ status: "done" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }, 120_000);

  it("(7) rollback evidence is recorded, state rolled_back, and the transition is loud exactly once (nonterminal)", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);
    await claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 });

    const res = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "failed",
        preflight: { hashesVerified: true },
        rollbackEvidence: { archivePath: TARGET_PATH, archiveSha256: SOURCE_SHA },
        note: "postcondition verification failed; inverse op executed",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("rolled_back");

    const row = await db.select().from(brokerOperations).where(eq(brokerOperations.id, operation.id)).then((rows) => rows[0]!);
    expect(row.state).toBe("rolled_back");
    const rollbackState = row.rollbackState as Record<string, any>;
    expect(rollbackState).toMatchObject({
      rollbackOperation: "restore_quarantined_exact_file",
      evidence: { archivePath: TARGET_PATH, archiveSha256: SOURCE_SHA },
      executedBy: "host-broker-a",
      terminal: false,
    });

    // Exactly one loud activity for the rollback transition.
    const rollbackActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "broker_operation.rolled_back"), eq(activityLog.entityId, operation.id)));
    expect(rollbackActivities).toHaveLength(1);

    // Nonterminal for the workflow: no issue was mutated, no receipt accepted.
    for (const issueId of [seed.anchorIssueId, seed.childIssueId]) {
      const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issueRow.completionReceipt).toBeNull();
    }
    // A rolled_back operation accepts no further claims without a new decision.
    await expect(claimBrokerOperation(db, {
      operationId: operation.id,
      claimedBy: "host-broker-b",
      expectedGeneration: 1,
    })).rejects.toMatchObject({ status: 409 });
  }, 120_000);

  it("(8) evidence hygiene: free-text fields beyond the bounded note are zod-rejected", async () => {
    const seed = await seedCompanyAgentAnchorChild();
    const { app, operation } = await approveAndGetOperation(seed);

    // Undeclared free-text field on a claim.
    const extraField = await request(app)
      .post(`/api/broker-operations/${operation.id}/claim`)
      .send({ claimedBy: "host-broker-a", expectedGeneration: 0, story: "let me explain at length..." });
    expect(extraField.status).toBe(400);

    // Prose where an identity belongs.
    const proseIdentity = await request(app)
      .post(`/api/broker-operations/${operation.id}/claim`)
      .send({ claimedBy: "the broker on the host by the window", expectedGeneration: 0 });
    expect(proseIdentity.status).toBe(400);

    await claimBrokerOperation(db, { operationId: operation.id, claimedBy: "host-broker-a", expectedGeneration: 0 });

    // Note over the bound.
    const longNote = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "failed",
        note: "x".repeat(501),
      });
    expect(longNote.status).toBe(400);

    // Undeclared field on a receipt; succeeded without a typed receipt.
    const extraReceiptField = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({
        claimedBy: "host-broker-a",
        claimGeneration: 1,
        outcome: "failed",
        narrative: "everything went fine except the parts that did not",
      });
    expect(extraReceiptField.status).toBe(400);
    const missingReceipt = await request(app)
      .post(`/api/broker-operations/${operation.id}/receipt`)
      .send({ claimedBy: "host-broker-a", claimGeneration: 1, outcome: "succeeded" });
    expect(missingReceipt.status).toBe(400);

    // The operation is untouched by all of the rejected submissions.
    const row = await db.select().from(brokerOperations).where(eq(brokerOperations.id, operation.id)).then((rows) => rows[0]!);
    expect(row.state).toBe("claimed");
    expect(row.receipt).toBeNull();
  }, 120_000);
});
