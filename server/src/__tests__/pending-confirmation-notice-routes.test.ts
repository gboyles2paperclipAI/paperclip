/**
 * Tests for POST /api/issues/:id/pending-confirmation-notices
 *
 * Covers:
 *   - Happy path: notice created, comment posted, assignee woken
 *   - Auth boundary: agent posting to an issue they do NOT own succeeds (cross-boundary)
 *   - Auth: non-agent (board user) is rejected
 *   - Auth: low-trust agent (company_scope:read denied) is rejected
 *   - Not-found: missing interaction returns 404
 *   - Not-found: wrong-status interaction (not pending) returns 404
 *   - Idempotency: duplicate call returns existing notice without creating a second comment
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTIFIER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTERACTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ISSUE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMPANY_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  addComment: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  getById: vi.fn(),
  listForIssue: vi.fn(),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => ({ id: "run-1" })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

// Configurable idempotency row — default null (no duplicate); tests override to simulate duplicate.
let mockIdempotencyRows: Array<{ id: string }> = [];

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(mockIdempotencyRows).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

// Access service: allow by default; tests override for low-trust denial
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_company_agent",
  explanation: "Allowed by test.",
})));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => null),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => ({ id: NOTIFIER_AGENT_ID, companyId: COMPANY_ID, permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    documentAnnotationService: () => ({}),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({ id: "settings-1", general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" } })),
      listCompanyIds: vi.fn(async () => [COMPANY_ID]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    // NOTE: assignee is ASSIGNEE_AGENT_ID — NOT the calling NOTIFIER_AGENT_ID.
    // This is the core of the cross-boundary test: the notifier agent does not own
    // the target issue but should still be able to post a notice via this endpoint.
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "FUL-11132",
    title: "Pending-confirmation target issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function createPendingInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: INTERACTION_ID,
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    kind: "request_confirmation",
    status: "pending",
    continuationPolicy: "wake_assignee_on_accept",
    idempotencyKey: null,
    sourceCommentId: null,
    sourceRunId: "run-source-1",
    payload: { version: 1, message: "Please confirm the plan." },
    result: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

// Agent actor as the notifier (NOT the issue owner).
// Agents are authenticated with a single companyId, not a companyIds array.
function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: NOTIFIER_AGENT_ID,
    companyId: COMPANY_ID,
    runId: "run-notifier-1",
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = agentActor()) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const NOTICE_REQUEST = {
  interactionId: INTERACTION_ID,
  ageMinutes: 75,
  thresholdMinutes: 60,
};

describe.sequential("pending-confirmation-notice routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockIdempotencyRows = [];

    mockIssueService.getById.mockResolvedValue(createIssue());
    mockIssueService.addComment.mockResolvedValue({
      id: COMMENT_ID,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      body: "notice body",
      authorAgentId: NOTIFIER_AGENT_ID,
      authorType: "agent",
      createdAt: "2026-06-14T04:00:00.000Z",
      updatedAt: "2026-06-14T04:00:00.000Z",
    });
    mockInteractionService.getById.mockResolvedValue(createPendingInteraction());
    mockInteractionService.listForIssue.mockResolvedValue([]);
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);

    mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_company_agent",
      explanation: "Allowed by test.",
    }));
  });

  it("posts a notice comment and wakes the assignee when the notifier is not the issue owner", async () => {
    // NOTIFIER_AGENT_ID != ASSIGNEE_AGENT_ID — this is the cross-boundary case.
    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(201);
    expect(res.body.noticeId).toBe(COMMENT_ID);
    expect(res.body.commentId).toBe(COMMENT_ID);
    expect(res.body.wakeQueued).toBe(true);
    expect(res.body.duplicate).toBeUndefined();

    // Comment was added — not gated by assertAgentIssueMutationAllowed
    expect(mockIssueService.addComment).toHaveBeenCalledOnce();
    const [, commentBody] = mockIssueService.addComment.mock.calls[0];
    expect(commentBody).toContain(`pc-notice:${INTERACTION_ID}`);
    expect(commentBody).toContain("75m");
    expect(commentBody).toContain("threshold: 60m");

    // Assignee woken with structured payload
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledOnce();
    const [wokenAgentId, wakeOpts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(wokenAgentId).toBe(ASSIGNEE_AGENT_ID);
    expect(wakeOpts.reason).toBe("pending_confirmation_notice");
    expect(wakeOpts.payload).toMatchObject({
      kind: "pending_confirmation_notice",
      issueId: ISSUE_ID,
      interactionId: INTERACTION_ID,
      ageMinutes: 75,
      thresholdMinutes: 60,
    });
  });

  it("rejects board users — agent authentication required", async () => {
    const boardActor = { type: "board", userId: "local-board", companyIds: [COMPANY_ID], source: "local_implicit", isInstanceAdmin: false };
    const app = await createApp(boardActor);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Agent authentication required/i);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects low-trust agents that fail company_scope:read", async () => {
    // Simulate the low-trust agent case: company_scope:read is denied
    mockAccessDecide.mockImplementation(async (input: { action?: string }) => {
      if (input.action === "company_scope:read") {
        return {
          allowed: false,
          action: input.action,
          reason: "deny_low_trust",
          explanation: "LOW_TRUST_REVIEW_PRESET agents cannot use company-wide APIs.",
        };
      }
      return { allowed: true, action: input.action, reason: "allow_company_agent", explanation: "Allowed." };
    });

    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/company_scope:read/i);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the named interaction is not pending on this issue", async () => {
    mockInteractionService.getById.mockResolvedValue(
      createPendingInteraction({ status: "accepted" }),
    );

    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the interaction belongs to a different issue", async () => {
    mockInteractionService.getById.mockResolvedValue(
      createPendingInteraction({ issueId: "other-issue-id" }),
    );

    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns the existing notice without creating a duplicate (idempotency)", async () => {
    const EXISTING_NOTICE_ID = "11111111-1111-4111-8111-111111111111";
    mockIdempotencyRows = [{ id: EXISTING_NOTICE_ID }];

    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.noticeId).toBe(EXISTING_NOTICE_ID);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.wakeQueued).toBe(false);
    // No new comment created
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // No new wake queued
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body schema (missing interactionId)", async () => {
    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send({ ageMinutes: 75, thresholdMinutes: 60 });

    expect(res.status).toBe(400);
  });

  it("does not wake when there is no assignee agent", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue({ assigneeAgentId: null }));

    const app = await createApp(agentActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/pending-confirmation-notices`)
      .set("Content-Type", "application/json")
      .send(NOTICE_REQUEST);

    expect(res.status).toBe(201);
    expect(res.body.wakeQueued).toBe(false);
    expect(mockIssueService.addComment).toHaveBeenCalledOnce();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
