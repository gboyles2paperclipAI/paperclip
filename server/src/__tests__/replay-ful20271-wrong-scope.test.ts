import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitForAllHeartbeatRunExecutionsDrain } from "../services/heartbeat.ts";
import {
  COMPLETION_CONTRACT_RECEIPT_RULE,
  computeCompletionContractPreimageSha256,
} from "../services/completion-contracts.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * FUL-20271 replay (ADR-20260823-quiescent-coordination R2.12/R2.13, PR-3):
 * the wrong-scope quarantine. The operator approved quarantining EXACTLY one
 * file from a directory; the executing agent moved 1,340 unrelated entries
 * instead, left the contracted file in place, and marked the issue done.
 *
 * With completion contracts, the contract's preimage (source file hash,
 * directory baseline count, exact target) is captured at attach time and the
 * `done` transition fails closed unless an accepted receipt proves the exact
 * contracted operation happened:
 *
 * (a) wrong-scope receipt (file still present, 1,340 unrelated entries moved,
 *     baseline count changed) → REJECTED, the issue cannot go done;
 * (b) the exact receipt (file absent from source, present at target with the
 *     matching hash, count baseline-1, broker executor, distinct reviewer)
 *     → ACCEPTED, done succeeds;
 * (c) stale contractRevision / wrong executionRunId / changed source hash /
 *     missing rollback evidence → each REJECTED;
 * (d) resubmit of the accepted receipt → idempotent success, no duplicate
 *     effects; a different execution against the satisfied contract → REJECTED;
 * (e) `cancelled` needs no receipt → allowed, resolutionDisposition=cancelled.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "FUL-20271 wrong-scope replay run.",
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
    `Skipping embedded Postgres FUL-20271 wrong-scope replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SOURCE_SHA = createHash("sha256").update("uw-archive-entry-000141-bytes").digest("hex");
const OTHER_SHA = createHash("sha256").update("some-completely-different-bytes").digest("hex");
const SOURCE_PATH = "/var/tmp/uw-archive/entry-000141.json";
const TARGET_PATH = "/backups/uw-quarantine/entry-000141.json";
const BASELINE_COUNT = 1341;

const QUARANTINE_CONTRACT = {
  contractType: "exact_file_quarantine" as const,
  version: 1 as const,
  contractRevision: 2,
  preimage: {
    sourcePath: SOURCE_PATH,
    sourceContentSha256: SOURCE_SHA,
    quarantineTargetPath: TARGET_PATH,
    sourceDirEntryBaselineCount: BASELINE_COUNT,
    executorIdentity: "broker",
    reviewerRequired: true as const,
    rollbackArchiveRequired: true,
  },
};
const PREIMAGE_SHA = computeCompletionContractPreimageSha256(QUARANTINE_CONTRACT);

function buildExactReceipt(input: {
  executionRunId: string;
  reviewerIdentity: string;
  overrides?: Record<string, unknown>;
  assertionOverrides?: Record<string, unknown>;
}) {
  return {
    contractType: "exact_file_quarantine",
    version: 1,
    contractRevision: QUARANTINE_CONTRACT.contractRevision,
    preimageSha256: PREIMAGE_SHA,
    executionRunId: input.executionRunId,
    executorIdentity: "broker",
    reviewerIdentity: input.reviewerIdentity,
    rollbackEvidence: { archivePath: TARGET_PATH, archiveSha256: SOURCE_SHA },
    assertions: {
      sourceAbsentFromSourceDir: true,
      targetPresentWithMatchingHash: true,
      observedTargetContentSha256: SOURCE_SHA,
      observedSourceDirEntryCount: BASELINE_COUNT - 1,
      movedEntryPaths: [SOURCE_PATH],
      ...(input.assertionOverrides ?? {}),
    },
    ...(input.overrides ?? {}),
  };
}

describeEmbeddedPostgres("replay — FUL-20271 wrong-scope quarantine (PR-3 completion contracts)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-replay-ful20271-");
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
        await db.delete(issueExecutionDecisions);
        await db.delete(issueRelations);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
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

  const heartbeatStub = {
    wakeup: async () => undefined,
    getRun: async () => null,
    getActiveRunForAgent: async () => null,
    cancelRun: async () => null,
    reportRunActivity: async () => undefined,
    triggerIssueMonitor: async () => ({ outcome: "triggered" as const }),
  } as any;

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
    app.use("/api", issueRoutes(db, heartbeatStub));
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

  function agentActor(companyId: string, agentId: string, runId?: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      ...(runId ? { runId } : {}),
    };
  }

  /** Agent PATCHes that carry a comment require a run identity. */
  async function seedAgentRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
    });
    return runId;
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
      // wakeOnDemand=false keeps wake records from promoting to background
      // heartbeat runs; this replay asserts on the contract gate, not wakes.
      runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    return agentId;
  }

  async function readIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Board attaches the contract at create (exercising the attach
   * normalization), then the issue is put in progress with an execution-run
   * stamp the receipt must bind to.
   */
  async function seedContractIssue(input: {
    companyId: string;
    executorAgentId: string;
    executionPolicy?: Record<string, unknown>;
    stampExecutionRun?: boolean;
  }) {
    const boardApp = await createIssueApp(boardActor(input.companyId));
    const createResponse = await request(boardApp)
      .post(`/api/companies/${input.companyId}/issues`)
      .send({
        title: "Quarantine exactly entry-000141.json from the UW archive",
        status: "todo",
        completionContract: QUARANTINE_CONTRACT,
        ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
      });
    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    expect(createResponse.body.completionContract.preimageSha256).toBe(PREIMAGE_SHA);
    const issueId = createResponse.body.id as string;

    let executionRunId: string | null = null;
    if (input.stampExecutionRun !== false) {
      executionRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: executionRunId,
        companyId: input.companyId,
        agentId: input.executorAgentId,
        status: "completed",
      });
      await db.update(issues)
        .set({ status: "in_progress", assigneeAgentId: input.executorAgentId, executionRunId })
        .where(eq(issues.id, issueId));
    } else {
      await db.update(issues)
        .set({ status: "in_progress", assigneeAgentId: input.executorAgentId })
        .where(eq(issues.id, issueId));
    }
    return { issueId, executionRunId, boardApp };
  }

  it("(a) the wrong-scope receipt is rejected: file still present, 1,340 unrelated entries moved", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const { issueId, executionRunId, boardApp } = await seedContractIssue({ companyId, executorAgentId });

    // What FUL-20271 actually did: the contracted file never moved, and 1,340
    // unrelated entries left the directory instead (baseline 1341 → 1).
    const unrelatedMovedPaths = Array.from(
      { length: BASELINE_COUNT - 1 },
      (_, index) => `/var/tmp/uw-archive/unrelated-${String(index).padStart(6, "0")}.json`,
    );
    const wrongScopeReceipt = buildExactReceipt({
      executionRunId: executionRunId!,
      reviewerIdentity: reviewerAgentId,
      assertionOverrides: {
        sourceAbsentFromSourceDir: false,
        targetPresentWithMatchingHash: false,
        observedTargetContentSha256: OTHER_SHA,
        observedSourceDirEntryCount: 1,
        movedEntryPaths: unrelatedMovedPaths,
      },
    });

    const doneResponse = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", completionReceipt: wrongScopeReceipt });
    expect(doneResponse.status, JSON.stringify(doneResponse.body)).toBe(422);
    expect(doneResponse.body.details.rule).toBe(COMPLETION_CONTRACT_RECEIPT_RULE);
    expect(doneResponse.body.details.reasons).toEqual(expect.arrayContaining([
      "source_file_still_present",
      "unrelated_entry_count_changed",
      "resource_set_exceeds_preimage",
    ]));

    const stored = await readIssue(issueId);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.completionReceipt).toBeNull();
    expect(stored?.resolutionDisposition).toBeNull();
  }, 120_000);

  it("(b) the exact receipt is accepted and done succeeds with disposition=completed", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const { issueId, executionRunId, boardApp } = await seedContractIssue({ companyId, executorAgentId });

    const exactReceipt = buildExactReceipt({
      executionRunId: executionRunId!,
      reviewerIdentity: reviewerAgentId,
    });
    const doneResponse = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", completionReceipt: exactReceipt });
    expect(doneResponse.status, JSON.stringify(doneResponse.body)).toBe(200);
    expect(doneResponse.body.status).toBe("done");

    const stored = await readIssue(issueId);
    expect(stored?.status).toBe("done");
    expect(stored?.resolutionDisposition).toBe("completed");
    const acceptance = (stored?.completionReceipt as Record<string, any>)._acceptance;
    expect(acceptance).toMatchObject({
      issueId,
      executionRunId,
      contractRevision: QUARANTINE_CONTRACT.contractRevision,
    });
    expect(typeof acceptance.acceptedAt).toBe("string");
    // The board submitter is stamped server-side.
    expect((stored?.completionReceipt as Record<string, unknown>).submittedBy).toBe("board-user");
  }, 120_000);

  it("(c) stale revision, wrong execution id, changed source hash, and missing rollback evidence are each rejected", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const { issueId, executionRunId, boardApp } = await seedContractIssue({ companyId, executorAgentId });

    const rejections: Array<{ name: string; receipt: Record<string, unknown>; reason: string }> = [
      {
        name: "stale contractRevision",
        receipt: buildExactReceipt({
          executionRunId: executionRunId!,
          reviewerIdentity: reviewerAgentId,
          overrides: { contractRevision: 1 },
        }),
        reason: "stale_contract_revision",
      },
      {
        name: "wrong executionRunId",
        receipt: buildExactReceipt({
          executionRunId: randomUUID(),
          reviewerIdentity: reviewerAgentId,
        }),
        reason: "wrong_execution_id",
      },
      {
        name: "changed source hash",
        receipt: buildExactReceipt({
          executionRunId: executionRunId!,
          reviewerIdentity: reviewerAgentId,
          assertionOverrides: { observedTargetContentSha256: OTHER_SHA },
        }),
        reason: "source_content_hash_changed",
      },
      {
        name: "missing rollback evidence",
        receipt: buildExactReceipt({
          executionRunId: executionRunId!,
          reviewerIdentity: reviewerAgentId,
          overrides: { rollbackEvidence: null },
        }),
        reason: "missing_rollback_evidence",
      },
    ];

    for (const rejection of rejections) {
      const response = await request(boardApp)
        .patch(`/api/issues/${issueId}`)
        .send({ status: "done", completionReceipt: rejection.receipt });
      expect(response.status, `${rejection.name}: ${JSON.stringify(response.body)}`).toBe(422);
      expect(response.body.details.rule, rejection.name).toBe(COMPLETION_CONTRACT_RECEIPT_RULE);
      expect(response.body.details.reasons, rejection.name).toContain(rejection.reason);
      const stored = await readIssue(issueId);
      expect(stored?.status, rejection.name).toBe("in_progress");
      expect(stored?.completionReceipt, rejection.name).toBeNull();
    }
  }, 120_000);

  it("(d) resubmitting the accepted receipt is an idempotent no-op; a different execution cannot close the satisfied contract", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const { issueId, executionRunId, boardApp } = await seedContractIssue({ companyId, executorAgentId });

    const exactReceipt = buildExactReceipt({
      executionRunId: executionRunId!,
      reviewerIdentity: reviewerAgentId,
    });
    const firstDone = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", completionReceipt: exactReceipt });
    expect(firstDone.status, JSON.stringify(firstDone.body)).toBe(200);
    const afterFirst = await readIssue(issueId);
    const firstAcceptance = (afterFirst?.completionReceipt as Record<string, any>)._acceptance;

    // Resubmit of the same accepted receipt: no-op success, no duplicate
    // effects — the stored acceptance stamp is unchanged.
    const resubmit = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", completionReceipt: exactReceipt });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    const afterResubmit = await readIssue(issueId);
    expect(afterResubmit?.status).toBe("done");
    expect((afterResubmit?.completionReceipt as Record<string, any>)._acceptance).toEqual(firstAcceptance);
    expect(afterResubmit?.resolutionDisposition).toBe("completed");

    // A receipt bound to a DIFFERENT execution against the already-satisfied
    // contract is rejected — an old acceptance can never be displaced and can
    // never cover a later execution.
    const differentExecutionReceipt = buildExactReceipt({
      executionRunId: randomUUID(),
      reviewerIdentity: reviewerAgentId,
    });
    const differentExecution = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", completionReceipt: differentExecutionReceipt });
    expect(differentExecution.status, JSON.stringify(differentExecution.body)).toBe(422);
    expect(differentExecution.body.details.reasons).toContain("contract_already_satisfied_by_different_execution");
    const afterRejected = await readIssue(issueId);
    expect((afterRejected?.completionReceipt as Record<string, any>)._acceptance).toEqual(firstAcceptance);
  }, 120_000);

  it("(e) cancelled is never blocked by a contract and records resolutionDisposition=cancelled", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const { issueId, boardApp } = await seedContractIssue({ companyId, executorAgentId });

    const cancelResponse = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });
    expect(cancelResponse.status, JSON.stringify(cancelResponse.body)).toBe(200);

    const stored = await readIssue(issueId);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.resolutionDisposition).toBe("cancelled");
    expect(stored?.completionReceipt).toBeNull();
    expect(stored?.completionContract).not.toBeNull();
  }, 120_000);

  it("execution-policy coverage (R2.13): the FINAL stage-commit done passes through the contract gate", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const { issueId, boardApp } = await seedContractIssue({
      companyId,
      executorAgentId,
      stampExecutionRun: false,
      executionPolicy: {
        stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      },
    });

    const executorRunId = await seedAgentRun(companyId, executorAgentId);
    const reviewerRunId = await seedAgentRun(companyId, reviewerAgentId);
    const executorApp = await createIssueApp(agentActor(companyId, executorAgentId, executorRunId));
    const reviewerApp = await createIssueApp(agentActor(companyId, reviewerAgentId, reviewerRunId));

    // Executor "done" commits as in_review (stage handoff) — the contract
    // gate must NOT misfire on the pre-transition requested status.
    const handoff = await request(executorApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Quarantine executed by the broker; requesting review." });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body.status).toBe("in_review");
    expect(handoff.body.assigneeAgentId).toBe(reviewerAgentId);

    // The reviewer's approving "done" IS the final committed done — without an
    // accepted receipt it fails closed at the gate.
    const gatedDone = await request(reviewerApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Review GO." });
    expect(gatedDone.status, JSON.stringify(gatedDone.body)).toBe(422);
    expect(gatedDone.body.details.rule).toBe(COMPLETION_CONTRACT_RECEIPT_RULE);
    expect((await readIssue(issueId))?.status).toBe("in_review");

    // Board records the broker's receipt, then the same final stage-commit
    // done succeeds through the gate.
    const receipt = buildExactReceipt({
      executionRunId: "broker-op-ful20271-final",
      reviewerIdentity: reviewerAgentId,
    });
    const receiptSubmit = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ completionReceipt: receipt });
    expect(receiptSubmit.status, JSON.stringify(receiptSubmit.body)).toBe(200);

    const finalDone = await request(reviewerApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Review GO." });
    expect(finalDone.status, JSON.stringify(finalDone.body)).toBe(200);

    const stored = await readIssue(issueId);
    expect(stored?.status).toBe("done");
    expect(stored?.resolutionDisposition).toBe("completed");
    expect((stored?.executionState as Record<string, unknown> | null)?.status).toBe("completed");
    expect((stored?.completionReceipt as Record<string, any>)._acceptance).toMatchObject({
      issueId,
      executionRunId: "broker-op-ful20271-final",
    });
  }, 120_000);

  it("custody: agents cannot attach contracts or set dispositions; only the assignee submits receipts; reviewer independence is enforced", async () => {
    const companyId = await seedCompany();
    const executorAgentId = await seedAgent(companyId, "Executor");
    const otherAgentId = await seedAgent(companyId, "Bystander");
    const { issueId, executionRunId } = await seedContractIssue({ companyId, executorAgentId });

    // The executor acts under the same run the issue's execution lock is
    // stamped with, so its PATCHes are not refused by run-ownership.
    const otherRunId = await seedAgentRun(companyId, otherAgentId);
    const executorApp = await createIssueApp(agentActor(companyId, executorAgentId, executionRunId!));
    const otherApp = await createIssueApp(agentActor(companyId, otherAgentId, otherRunId));
    const boardApp = await createIssueApp(boardActor(companyId));

    // Agents cannot attach/modify contracts (update or create).
    const contractPatch = await request(executorApp)
      .patch(`/api/issues/${issueId}`)
      .send({ completionContract: QUARANTINE_CONTRACT, comment: "self-attaching" });
    expect(contractPatch.status, JSON.stringify(contractPatch.body)).toBe(422);
    expect(contractPatch.body.error).toBe("Agents cannot attach or modify completion contracts");

    const contractCreate = await request(executorApp)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Self-contracted work", completionContract: QUARANTINE_CONTRACT });
    expect(contractCreate.status, JSON.stringify(contractCreate.body)).toBe(422);
    expect(contractCreate.body.error).toBe("Agents cannot attach completion contracts");

    // Agents cannot record an explicit disposition.
    const dispositionPatch = await request(executorApp)
      .patch(`/api/issues/${issueId}`)
      .send({ resolutionDisposition: "failed", comment: "self-disposing" });
    expect(dispositionPatch.status, JSON.stringify(dispositionPatch.body)).toBe(422);

    // A non-assignee agent cannot submit a receipt (ownership boundary or
    // custody gate — never a success).
    const bystanderReceipt = await request(otherApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        completionReceipt: buildExactReceipt({
          executionRunId: executionRunId!,
          reviewerIdentity: otherAgentId,
        }),
      });
    expect([403, 409, 422], JSON.stringify(bystanderReceipt.body)).toContain(bystanderReceipt.status);
    expect((await readIssue(issueId))?.completionReceipt).toBeNull();

    // The assignee agent MAY submit a receipt; submittedBy is force-stamped
    // to its identity (a spoofed submittedBy is overwritten).
    const assigneeReceipt = buildExactReceipt({
      executionRunId: executionRunId!,
      reviewerIdentity: "broker", // reviewer == executor: must be rejected at the gate
      overrides: { submittedBy: "spoofed-identity" },
    });
    const assigneeSubmit = await request(executorApp)
      .patch(`/api/issues/${issueId}`)
      .send({ completionReceipt: assigneeReceipt, comment: "Broker receipt attached." });
    expect(assigneeSubmit.status, JSON.stringify(assigneeSubmit.body)).toBe(200);
    const storedAfterSubmit = await readIssue(issueId);
    expect((storedAfterSubmit?.completionReceipt as Record<string, unknown>).submittedBy).toBe(executorAgentId);

    // Reviewer independence: reviewer == executor fails the done gate.
    const gatedDone = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(gatedDone.status, JSON.stringify(gatedDone.body)).toBe(422);
    expect(gatedDone.body.details.reasons).toContain("reviewer_is_executor");
    expect((await readIssue(issueId))?.status).toBe("in_progress");
  }, 120_000);
});
