import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueThreadInteractionService", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-thread-interactions-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedConfirmationIssue(title = "Comment supersede") {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title,
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, goalId, issueId };
  }

  it("accepts suggested tasks by creating a rooted issue tree under the current issue", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const assigneeAgentId = randomUUID();
    const responsibleUserId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
      responsibleUserId,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
            workMode: "planning",
            assigneeAgentId,
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.interaction.kind).toBe("suggest_tasks");
    expect(accepted.interaction.status).toBe("accepted");
    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
        expect.objectContaining({ clientKey: "child" }),
      ],
    });
    expect(accepted.createdIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId,
        status: "todo",
      }),
      expect.objectContaining({
        assigneeAgentId: null,
        status: "todo",
      }),
    ]);
    const createdIssueRows = await db
      .select({
        title: issues.title,
        workMode: issues.workMode,
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(createdIssueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Create the root follow-up", workMode: "planning" }),
        expect.objectContaining({ title: "Create the nested follow-up", workMode: "standard" }),
      ]),
    );
    expect(createdIssueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Create the root follow-up", responsibleUserId }),
        expect.objectContaining({ title: "Create the nested follow-up", responsibleUserId }),
      ]),
    );

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");

    const nestedChildren = await issuesSvc.list(companyId, { parentId: children[0]!.id });
    expect(nestedChildren).toHaveLength(1);
    expect(nestedChildren[0]?.title).toBe("Create the nested follow-up");
    expect(nestedChildren[0]?.requestDepth).toBe(4);

    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("accepted");

    await expect(interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");

    const childrenAfterDuplicateAccept = await issuesSvc.list(companyId, { parentId: issueId });
    expect(childrenAfterDuplicateAccept).toHaveLength(1);
  });

  it("accepts a selected subset of suggested tasks and records the skipped drafts", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Selectively persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
          {
            clientKey: "sibling",
            title: "Create the sibling follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedClientKeys: ["root"],
    }, {
      userId: "local-board",
    });

    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
      ],
      skippedClientKeys: ["child", "sibling"],
    });

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");
  });

  it("rejects partial acceptance when a selected task omits its selected-tree parent", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Validate selective acceptance",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    await expect(
      interactionsSvc.acceptSuggestedTasks({
        id: issueId,
        companyId,
        goalId,
        projectId: null,
      }, created.id, {
        selectedClientKeys: ["child"],
      }, {
        userId: "local-board",
      }),
    ).rejects.toThrow("requires its parent");
  });

  it("persists validated answers for ask_user_questions interactions", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist question answers",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Question parent",
      status: "todo",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Choose the scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Optional extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const answered = await interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: [], otherText: "Custom Phase 1" },
        {
          questionId: "extras",
          optionIds: ["docs", "tests", "docs"],
          otherText: "  Pair with release notes  ",
        },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(answered.status).toBe("answered");
    expect(answered.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: [], otherText: "Custom Phase 1" },
        { questionId: "extras", optionIds: ["docs", "tests"], otherText: "Pair with release notes" },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    });

    await expect(interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: ["phase-2"] },
      ],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");
  });

  it("persists cancelled ask_user_questions interactions without answer data", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Cancel question answers",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Question parent",
      status: "in_review",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          required: true,
          options: [
            { id: "phase-1", label: "Phase 1" },
            { id: "phase-2", label: "Phase 2" },
          ],
        }],
      },
    }, {
      userId: "local-board",
    });

    const cancelled = await interactionsSvc.cancelQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      reason: "Not needed anymore",
    }, {
      userId: "local-board",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toEqual({
      version: 1,
      answers: [],
      cancelled: true,
      cancellationReason: "Not needed anymore",
      summaryMarkdown: null,
    });

    await expect(interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");
  });

  it("expires ask_user_questions interactions by default when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "ask_user_questions",
      payload: {
        supersedeOnUserComment: true,
      },
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "ask_user_questions",
      status: "expired",
      result: {
        version: 1,
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId,
        summaryMarkdown: null,
      },
      resolvedByUserId: "local-board",
    });
  });

  it("expires ask_user_questions interactions by default when an agent comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question agent supersede");
    const commentId = randomUUID();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Code Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorAgentId: agentId,
    }, {
      agentId,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "ask_user_questions",
      status: "expired",
      result: {
        version: 1,
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId,
        summaryMarkdown: null,
      },
      resolvedByAgentId: agentId,
      resolvedByUserId: null,
    });
  });

  it("keeps ask_user_questions pending when user-comment supersede is explicitly disabled", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede opt-out");

    await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        supersedeOnUserComment: false,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("does not supersede ask_user_questions for system or older user comments", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede exclusions");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });
    const createdAtMs = new Date(created.createdAt).getTime();

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {})).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs - 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    })).resolves.toHaveLength(0);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("repairs historical ask_user_questions superseded by later user comments idempotently", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical question supersede");
    const commentId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "system",
      body: "System-side progress note.",
      createdAt: new Date("2026-05-18T12:00:30.000Z"),
      updatedAt: new Date("2026-05-18T12:00:30.000Z"),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      body: "Please revise this first.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "ask_user_questions",
      status: "expired",
      result: {
        version: 1,
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId,
        summaryMarkdown: null,
      },
      resolvedByAgentId: null,
      resolvedByUserId: "local-board",
    });

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    })).resolves.toEqual([]);
  });

  it("reuses the existing interaction when the same idempotency key is submitted twice", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Interaction dedupe",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date("2026-04-20T12:00:00.000Z"),
    });

    const input = {
      kind: "ask_user_questions" as const,
      idempotencyKey: "run-1:questionnaire",
      sourceRunId: runId,
      continuationPolicy: "wake_assignee" as const,
      payload: {
        version: 1 as const,
        questions: [
          {
            id: "scope",
            prompt: "Pick a scope",
            selectionMode: "single" as const,
            options: [{ id: "phase-2", label: "Phase 2" }],
          },
        ],
      },
    };

    const first = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    const second = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    expect(second.id).toBe(first.id);
    expect(second.sourceRunId).toBe(runId);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe("run-1:questionnaire");
  });

  it("accepts request_confirmation interactions without creating child issues", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Keep editing",
        detailsMarkdown: "Creates follow-up work after acceptance.",
      },
    }, {
      userId: "local-board",
    });

    expect(created.kind).toBe("request_confirmation");
    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
      requestId: "req-confirm-1",
      resolutionMethod: "ui_click",
    });

    expect(accepted.createdIssues).toEqual([]);
    expect(accepted.interaction).toMatchObject({
      kind: "request_confirmation",
      status: "accepted",
      result: {
        version: 1,
        outcome: "accepted",
      },
      resolvedByUserId: "local-board",
      resolutionAudit: {
        method: "ui_click",
        requestId: "req-confirm-1",
      },
    });
    expect(accepted.interaction.resolutionAudit?.resolvedAt).toBeTruthy();

    const auditRows = await interactionsSvc.listForCompany({
      companyId,
      method: "ui_click",
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toEqual({
      issue: {
        id: issueId,
        identifier: null,
        status: "in_progress",
      },
      interaction: {
        id: created.id,
        kind: "request_confirmation",
        status: "accepted",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        resolvedAt: expect.any(Date),
        resolvedBy: {
          agentId: null,
          userId: "local-board",
        },
        outcome: "accepted",
        resolutionAudit: {
          method: "ui_click",
        },
      },
    });
    expect(JSON.stringify(auditRows[0])).not.toMatch(
      /sourceRunId|sourceCommentId|createdBy|resolvedByAgentId|resolvedByUserId|requestId|prompt|payload|result|secret|transcript/i,
    );
    expect(await interactionsSvc.listForCompany({
      companyId,
      method: "api_explicit",
    })).toHaveLength(0);

    await db.update(issueThreadInteractions).set({
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
      resolvedAt: new Date("2026-07-03T00:00:00.000Z"),
    }).where(eq(issueThreadInteractions.id, created.id));
    expect(await interactionsSvc.listForCompany({
      companyId,
      createdAfter: new Date("2026-06-30T00:00:00.000Z"),
      createdBefore: new Date("2026-07-01T00:00:00.000Z"),
      updatedAfter: new Date("2026-07-02T00:00:00.000Z"),
      resolvedAfter: new Date("2026-07-03T00:00:00.000Z"),
      resolvedBefore: new Date("2026-07-04T00:00:00.000Z"),
    })).toHaveLength(1);
    expect(await interactionsSvc.listForCompany({
      companyId,
      resolvedBefore: new Date("2026-07-02T23:59:59.999Z"),
    })).toHaveLength(0);

    const requiresReason = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Decline only with a reason?",
        rejectRequiresReason: true,
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.rejectInteraction({
      id: issueId,
      companyId,
    }, requiresReason.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("A decline reason is required for this confirmation");
  });

  it("scopes company interaction audits by pending status, issue status, and created window", async () => {
    const { companyId, goalId, issueId: doneIssueId } = await seedConfirmationIssue("Company audit filters");
    const cancelledIssueId = randomUUID();
    const todoIssueId = randomUUID();
    await db.insert(issues).values([{
      id: cancelledIssueId,
      companyId,
      goalId,
      title: "Cancelled issue",
      status: "in_progress",
      priority: "medium",
    }, {
      id: todoIssueId,
      companyId,
      goalId,
      title: "Todo issue",
      status: "in_progress",
      priority: "medium",
    }]);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, doneIssueId));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, cancelledIssueId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, todoIssueId));

    const oldDone = await interactionsSvc.create({
      id: doneIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Old pending terminal issue",
      },
    }, {
      userId: "local-board",
    });
    const oldCancelled = await interactionsSvc.create({
      id: cancelledIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Old pending cancelled issue",
      },
    }, {
      userId: "local-board",
    });
    const oldTodo = await interactionsSvc.create({
      id: todoIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Old pending todo issue",
      },
    }, {
      userId: "local-board",
    });
    const freshDone = await interactionsSvc.create({
      id: doneIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Fresh pending terminal issue",
      },
    }, {
      userId: "local-board",
    });

    const oldCreatedAt = new Date("2026-07-01T00:00:00.000Z");
    const freshCreatedAt = new Date("2026-07-03T00:00:00.000Z");
    await db.update(issueThreadInteractions)
      .set({ createdAt: oldCreatedAt, updatedAt: oldCreatedAt })
      .where(eq(issueThreadInteractions.id, oldDone.id));
    await db.update(issueThreadInteractions)
      .set({ createdAt: oldCreatedAt, updatedAt: oldCreatedAt })
      .where(eq(issueThreadInteractions.id, oldCancelled.id));
    await db.update(issueThreadInteractions)
      .set({ createdAt: oldCreatedAt, updatedAt: oldCreatedAt })
      .where(eq(issueThreadInteractions.id, oldTodo.id));
    await db.update(issueThreadInteractions)
      .set({ createdAt: freshCreatedAt, updatedAt: freshCreatedAt })
      .where(eq(issueThreadInteractions.id, freshDone.id));

    const defaultAuditRows = await interactionsSvc.listForCompany({ companyId });
    expect(defaultAuditRows).toHaveLength(0);

    const terminalPendingRows = await interactionsSvc.listForCompany({
      companyId,
      statuses: ["pending"],
      issueStatuses: ["done", "cancelled"],
      createdBefore: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(terminalPendingRows.map((row) => row.interaction.id).sort()).toEqual([
      oldCancelled.id,
      oldDone.id,
    ].sort());
    expect(terminalPendingRows[0]).toMatchObject({
      issue: {
        status: expect.stringMatching(/done|cancelled/),
      },
      interaction: {
        status: "pending",
        outcome: null,
        resolutionAudit: { method: null },
      },
    });

    const updatedRows = await interactionsSvc.listForCompany({
      companyId,
      statuses: ["pending"],
      updatedAfter: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(updatedRows.map((row) => row.interaction.id)).toContain(freshDone.id);
    expect(updatedRows.map((row) => row.interaction.id)).not.toContain(oldDone.id);

    const firstPagedRow = await interactionsSvc.listForCompany({
      companyId,
      statuses: ["pending"],
      issueStatuses: ["done", "cancelled"],
      createdBefore: new Date("2026-07-02T00:00:00.000Z"),
      limit: 1,
    });
    const secondPagedRow = await interactionsSvc.listForCompany({
      companyId,
      statuses: ["pending"],
      issueStatuses: ["done", "cancelled"],
      createdBefore: new Date("2026-07-02T00:00:00.000Z"),
      limit: 1,
      offset: 1,
    });
    expect(firstPagedRow).toHaveLength(1);
    expect(secondPagedRow).toHaveLength(1);
    expect([
      firstPagedRow[0]?.interaction.id,
      secondPagedRow[0]?.interaction.id,
    ]).toEqual([oldDone.id, oldCancelled.id].sort().reverse());
  });

  it("keeps company interaction audit rows inside the requested company", async () => {
    const first = await seedConfirmationIssue("First company audit");
    const second = await seedConfirmationIssue("Second company audit");
    const firstInteraction = await interactionsSvc.create({
      id: first.issueId,
      companyId: first.companyId,
    }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "First company?" },
    }, { userId: "local-board" });
    await interactionsSvc.create({
      id: second.issueId,
      companyId: second.companyId,
    }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Second company?" },
    }, { userId: "local-board" });

    const rows = await interactionsSvc.listForCompany({
      companyId: first.companyId,
      statuses: ["pending"],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.issue.id).toBe(first.issueId);
    expect(rows[0]?.interaction.id).toBe(firstInteraction.id);
  });

  it("accepts request_checkbox_confirmation interactions with selected option ids", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Checkbox confirmation accept");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which files should be deleted?",
        options: [
          { id: "file-a", label: "a.txt" },
          { id: "file-b", label: "b.txt" },
          { id: "file-c", label: "c.txt" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 0,
        maxSelected: 2,
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "request_checkbox_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        supersedeOnUserComment: true,
        allowDeclineReason: true,
      },
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["file-c", "file-a"],
    }, {
      userId: "local-board",
    });

    expect(accepted.createdIssues).toEqual([]);
    expect(accepted.interaction).toMatchObject({
      kind: "request_checkbox_confirmation",
      status: "accepted",
      result: {
        version: 1,
        outcome: "accepted",
        selectedOptionIds: ["file-a", "file-c"],
      },
      resolvedByUserId: "local-board",
    });
  });

  it("enforces request_checkbox_confirmation selected option references and bounds", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Checkbox confirmation bounds");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Pick one or two options.",
        options: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
          { id: "three", label: "Three" },
        ],
        defaultSelectedOptionIds: ["one"],
        minSelected: 1,
        maxSelected: 2,
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: [],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Select at least 1 checkbox confirmation option(s)");

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["missing"],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Unknown checkbox confirmation optionId: missing");

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["one", "two", "three"],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Select no more than 2 checkbox confirmation option(s)");
  });

  it("expires request_checkbox_confirmation interactions when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Checkbox confirmation supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which files should be deleted?",
        options: [{ id: "file-a", label: "a.txt" }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "request_checkbox_confirmation",
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
    });
  });

  it("keeps request_checkbox_confirmation pending when an agent-run-authored comment is posted after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Checkbox agent run supersede guard");
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Code Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which files should be deleted?",
        options: [{ id: "file-a", label: "a.txt" }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorAgentId: agentId,
      createdByRunId: randomUUID(),
    }, {
      agentId,
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: "pending",
    });
  });

  it("submits request_item_verdicts partially and completes when all items are resolved", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict partial submit");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
          { id: "tests", label: "Tests" },
        ],
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "request_item_verdicts",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        verdicts: ["approve", "reject"],
        requireReasonOn: ["reject"],
        allowBulkApprove: true,
        supersedeOnUserComment: true,
      },
    });

    const first = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject", reason: "Missing examples" }],
    }, {
      userId: "local-board",
    });

    expect(first.newlyResolvedItemIds).toEqual(["docs"]);
    expect(first.interaction).toMatchObject({
      kind: "request_item_verdicts",
      status: "pending",
      result: {
        version: 1,
        outcome: "resolved",
        complete: false,
        items: [
          {
            id: "docs",
            verdict: "reject",
            reason: "Missing examples",
            resolvedByUserId: "local-board",
          },
        ],
      },
      resolvedAt: null,
    });

    const duplicate = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject" }],
    }, {
      userId: "local-board",
    });

    expect(duplicate.newlyResolvedItemIds).toEqual([]);
    expect(duplicate.interaction).toMatchObject({
      status: "pending",
      result: {
        complete: false,
        items: [
          {
            id: "docs",
            verdict: "reject",
            reason: "Missing examples",
          },
        ],
      },
    });

    const completed = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [
        { id: "api", verdict: "approve" },
        { id: "tests", verdict: "reject", reason: "No route coverage" },
      ],
    }, {
      userId: "local-board",
    });

    expect(completed.newlyResolvedItemIds).toEqual(["api", "tests"]);
    expect(completed.interaction).toMatchObject({
      kind: "request_item_verdicts",
      status: "answered",
      result: {
        version: 1,
        outcome: "resolved",
        complete: true,
        items: [
          { id: "api", verdict: "approve" },
          { id: "docs", verdict: "reject", reason: "Missing examples" },
          { id: "tests", verdict: "reject", reason: "No route coverage" },
        ],
      },
      resolvedByUserId: "local-board",
    });

    const duplicateAfterComplete = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });
    expect(duplicateAfterComplete.newlyResolvedItemIds).toEqual([]);
    expect(duplicateAfterComplete.interaction.status).toBe("answered");
  });

  it("enforces request_item_verdicts ids, enabled verdicts, and required reasons", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict validation");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "missing", verdict: "approve" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Unknown item verdict id: missing");

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "defer" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Verdict defer is not enabled");

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("A reason is required when verdict is reject");
  });

  it("preserves resolved request_item_verdicts items when a later user comment supersedes the pending remainder", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
      },
    }, {
      userId: "local-board",
    });

    await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "request_item_verdicts",
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        complete: false,
        commentId,
        items: [
          {
            id: "api",
            verdict: "approve",
            resolvedByUserId: "local-board",
          },
        ],
      },
    });
  });

  it("returns agent-authored request confirmations to the creating agent when a board user accepts", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Product Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Review the plan",
      status: "in_review",
      priority: "medium",
      assigneeUserId: "local-board",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        acceptLabel: "Approve plan",
        rejectLabel: "Ask for changes",
      },
    }, {
      agentId,
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.continuationIssue).toEqual({
      id: issueId,
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: "todo",
    });

    const updatedIssue = (await db.select().from(issues)).find((issue) => issue.id === issueId);
    expect(updatedIssue).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });
  });

  it("expires request confirmations by default when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue();
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      payload: {
        supersedeOnUserComment: true,
      },
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
      resolvedByUserId: "local-board",
    });
  });

  it("keeps request confirmations pending when an agent-run-authored comment is posted after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Agent run comment supersede guard");
    const commentId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Code Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorAgentId: agentId,
      createdByRunId: runId,
    }, {
      agentId,
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: "pending",
      resolvedByAgentId: null,
      resolvedByUserId: null,
    });
  });

  it("keeps request confirmations pending when a user-looking comment carries run provenance", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Run-stamped board-looking comment supersede guard");
    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
      createdByRunId: randomUUID(),
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: "pending",
      resolvedByAgentId: null,
      resolvedByUserId: null,
    });
  });

  it("keeps request confirmations pending when user-comment supersede is explicitly disabled", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Comment supersede opt-out");

    await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
        supersedeOnUserComment: false,
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("keeps legacy request confirmations pending when comment supersede was not stored", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Legacy confirmation without comment supersede flag");

    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: { kind: "none" },
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
      createdByUserId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("does not supersede request confirmations for system or older user comments", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Comment supersede exclusions");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    const createdAtMs = new Date(created.createdAt).getTime();

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {
      agentId: randomUUID(),
    })).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {})).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs - 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    })).resolves.toHaveLength(0);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("repairs historical request confirmations superseded by later user comments idempotently", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical comment supersede");
    const commentId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "system",
      body: "System-side progress note.",
      createdAt: new Date("2026-05-18T12:00:30.000Z"),
      updatedAt: new Date("2026-05-18T12:00:30.000Z"),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      body: "Please revise this first.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
      resolvedByAgentId: null,
      resolvedByUserId: "local-board",
    });

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    })).resolves.toEqual([]);
  });

  it("does not repair historical request confirmations for comments authored by an agent run", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical run-authored comment guard");
    const agentId = randomUUID();
    const runId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Code Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "finished",
      startedAt: new Date("2026-05-18T12:00:30.000Z"),
      finishedAt: new Date("2026-05-18T12:01:30.000Z"),
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      createdByRunId: runId,
      body: "Agent-authored progress note.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: "pending",
    });
  });

  it("expires request confirmations when the watched issue document revision changes", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Document target confirmation",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v1",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "v1",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply the plan document?",
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
    }, {
      userId: "local-board",
    });

    await db.insert(documentRevisions).values({
      id: nextRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "v2",
    });
    await db.update(documents).set({
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.interaction).toMatchObject({
      id: created.id,
      status: "expired",
      payload: {
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: {
          type: "issue_document",
          key: "plan",
          revisionId,
        },
      },
    });
  });

  it("preserves resolved request_item_verdicts items when the watched issue document revision changes", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Document target verdicts",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v1",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "v1",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
    }, {
      userId: "local-board",
    });

    await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });

    await db.insert(documentRevisions).values({
      id: nextRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "v2",
    });
    await db.update(documents).set({
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });

    const stale = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "approve" }],
    }, {
      userId: "local-board",
    });

    expect(stale.newlyResolvedItemIds).toEqual([]);
    expect(stale.interaction).toMatchObject({
      id: created.id,
      status: "expired",
      payload: {
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
      result: {
        version: 1,
        outcome: "stale_target",
        complete: false,
        staleTarget: {
          type: "issue_document",
          key: "plan",
          revisionId,
        },
        items: [
          {
            id: "api",
            verdict: "approve",
            resolvedByUserId: "local-board",
          },
        ],
      },
    });
  });

  it("expires an unanswered approval and auto-reissues it exactly once", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Timed approval lifecycle");
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      continuationPolicy: "none",
      title: "Operator approval",
      payload: {
        version: 1,
        prompt: "Approve the proposed action?",
      },
    }, { agentId: null, userId: "local-board" });

    expect(created.payload.expiresAt).toBeTruthy();
    expect(created.payload.escalated).toBe(false);
    const expiresAt = new Date(created.payload.expiresAt!);
    const sweepAt = new Date(expiresAt.getTime() + 1);
    const config = {
      interactionTtlSeconds: 60,
      approvalTtlSeconds: 60,
      notificationWebhookUrl: undefined,
    };

    const concurrent = await Promise.all([
      interactionsSvc.expireDueOperatorInteractions(sweepAt, { config }),
      interactionsSvc.expireDueOperatorInteractions(sweepAt, { config }),
    ]);
    expect(concurrent.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    expect(concurrent.reduce((sum, result) => sum + result.reissued, 0)).toBe(1);

    const afterFirstSweep = await interactionsSvc.listForIssue(issueId);
    expect(afterFirstSweep).toHaveLength(2);
    const original = afterFirstSweep.find((row) => row.id === created.id);
    const replacement = afterFirstSweep.find((row) => row.id !== created.id);
    expect(original).toMatchObject({ status: "expired", result: { outcome: "timeout" } });
    expect(replacement).toMatchObject({
      status: "pending",
      idempotencyKey: `timeout-reissue:${created.id}`,
      payload: {
        escalated: true,
        originalInteractionId: created.id,
      },
    });

    const replacementExpiry = new Date(replacement!.payload.expiresAt!);
    const finalSweep = await interactionsSvc.expireDueOperatorInteractions(
      new Date(replacementExpiry.getTime() + 1),
      { config },
    );
    expect(finalSweep).toMatchObject({ expired: 1, reissued: 0 });
    expect(await interactionsSvc.listForIssue(issueId)).toHaveLength(2);
  });

  describe("workspace_finalize accept gate", () => {
    type AcceptGateInteractionKind = "request_confirmation" | "request_checkbox_confirmation";

    async function seedAcceptGateFixture(options?: {
      kind?: AcceptGateInteractionKind;
      sourceRunId?: string | null;
    }) {
      const companyId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const issueId = randomUUID();
      const goalId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId =
        options?.sourceRunId === null ? null : options?.sourceRunId ?? randomUUID();
      const foreignRunId = randomUUID();
      const kind = options?.kind ?? "request_confirmation";

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Workspace",
        sourceType: "local_path",
        visibility: "default",
        isPrimary: true,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values([
        ...(sourceRunId
          ? [
              {
                id: sourceRunId,
                companyId,
                agentId,
                invocationSource: "manual",
                status: "succeeded",
                startedAt: new Date("2026-05-23T21:55:00.000Z"),
                finishedAt: new Date("2026-05-23T22:05:00.000Z"),
              },
            ]
          : []),
        {
          id: foreignRunId,
          companyId,
          agentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date("2026-05-23T22:10:00.000Z"),
        },
      ]);
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "exec",
        status: "active",
        providerType: "git_worktree",
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Accept gate fixture",
        level: "task",
        status: "active",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        goalId,
        title: "Issue with execution workspace",
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId,
      });

      const payload = kind === "request_checkbox_confirmation"
        ? {
            version: 1 as const,
            prompt: "Which files should be accepted?",
            options: [
              { id: "file-a", label: "a.txt" },
              { id: "file-b", label: "b.txt" },
            ],
            minSelected: 0,
            maxSelected: 2,
          }
        : {
            version: 1 as const,
            prompt: "Mark this issue done?",
          };

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind,
        continuationPolicy: "wake_assignee",
        sourceRunId,
        payload,
      }, {
        userId: "local-board",
      });

      return {
        companyId,
        projectId,
        executionWorkspaceId,
        issueId,
        goalId,
        interactionId: created.id,
        sourceRunId,
        foreignRunId,
      };
    }

    it("allows request_confirmation accept when the source run finalized but a foreign run is mid-flight", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId, foreignRunId } =
        await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("refuses request_confirmation accept until the source run records a successful workspace_finalize", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });

      await expect(
        interactionsSvc.acceptInteraction(
          { id: issueId, companyId, goalId, projectId: null },
          interactionId,
          {},
          { userId: "local-board" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "the run that created this interaction has not finished syncing its workspace",
        ),
        details: { executionWorkspaceId, sourceRunId },
      });

      const row = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("pending");

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:05:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("allows request_confirmation accept when sourceRunId is null", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, foreignRunId } =
        await seedAcceptGateFixture({ sourceRunId: null });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("allows request_checkbox_confirmation accept when the source run finalized but a foreign run is mid-flight", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId, foreignRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-b"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
        result: {
          selectedOptionIds: ["file-b"],
        },
      });
    });

    it("refuses request_checkbox_confirmation accept until the source run records a successful workspace_finalize", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });

      await expect(
        interactionsSvc.acceptInteraction(
          { id: issueId, companyId, goalId, projectId: null },
          interactionId,
          { selectedOptionIds: ["file-a"] },
          { userId: "local-board" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "the run that created this interaction has not finished syncing its workspace",
        ),
        details: { executionWorkspaceId, sourceRunId },
      });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-a"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
      });
    });

    it("allows request_checkbox_confirmation accept when sourceRunId is null", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, foreignRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation", sourceRunId: null });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-a"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
      });
    });

    it("allows accept of suggest_tasks even when no successful workspace_finalize has landed", async () => {
      // suggest_tasks acceptance only creates follow-up issues; it does not
      // approve code state or move the source workspace forward, so the
      // workspace_finalize gate (PAPA-440) must not apply here. Without this
      // carve-out the board cannot triage suggested tasks on an issue whose
      // latest workspace op is still worktree_prepare.
      const { companyId, executionWorkspaceId, issueId, goalId, foreignRunId } = await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-28T22:00:00.000Z"),
      });

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind: "suggest_tasks",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          tasks: [
            {
              clientKey: "follow-up",
              title: "Created from suggest_tasks accept under prepare-only workspace",
            },
          ],
        },
      }, {
        userId: "local-board",
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: created.id,
        kind: "suggest_tasks",
        status: "accepted",
      });
    });

    it("allows accept when the issue has no execution workspace attached", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("No execution workspace accept");

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Mark this issue done?",
        },
      }, {
        userId: "local-board",
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId: null, projectId: null },
        created.id,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: created.id,
        status: "accepted",
      });
    });
  });

  describe("dismissInteraction (FUL-14276)", () => {
    it("dismisses an ask_user_questions interaction as cancelled with an empty answer set", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss ask_user_questions");

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          questions: [
            {
              id: "scope",
              prompt: "Choose the scope",
              selectionMode: "single",
              required: true,
              options: [
                { id: "phase-1", label: "Phase 1" },
                { id: "phase-2", label: "Phase 2" },
              ],
            },
          ],
        },
      }, { userId: "local-board" });

      const dismissed = await interactionsSvc.dismissInteraction(
        { id: issueId, companyId },
        created.id,
        { reason: "No longer needed" },
        { userId: "local-board" },
      );

      expect(dismissed.status).toBe("cancelled");
      expect(dismissed.result).toEqual({
        version: 1,
        answers: [],
        cancelled: true,
        cancellationReason: "No longer needed",
        summaryMarkdown: null,
      });
      expect(dismissed.resolvedByUserId).toBe("local-board");
      expect(dismissed.resolvedByAgentId).toBeNull();
      expect(dismissed.resolutionAudit).toMatchObject({ method: "unknown", requestId: null });
      expect(dismissed.resolvedAt).not.toBeNull();
    });

    it("dismisses a suggest_tasks interaction as cancelled with a rejection reason", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss suggest_tasks");

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "suggest_tasks",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          tasks: [{ clientKey: "root", title: "Create the root follow-up" }],
        },
      }, { userId: "local-board" });

      const dismissed = await interactionsSvc.dismissInteraction(
        { id: issueId, companyId },
        created.id,
        { reason: "Not needed anymore" },
        { userId: "local-board" },
      );

      expect(dismissed.status).toBe("cancelled");
      expect(dismissed.result).toEqual({
        version: 1,
        rejectionReason: "Not needed anymore",
      });
    });

    it("dismisses a request_confirmation interaction as cancelled with a rejected outcome", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss request_confirmation");

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Apply this plan?",
        },
      }, { userId: "local-board" });

      const dismissed = await interactionsSvc.dismissInteraction(
        { id: issueId, companyId },
        created.id,
        { reason: "Stale, agent no longer needs approval" },
        { userId: "local-board" },
      );

      expect(dismissed.status).toBe("cancelled");
      expect(dismissed.result).toEqual({
        version: 1,
        outcome: "rejected",
        reason: "Stale, agent no longer needs approval",
      });
    });

    it("dismisses a request_checkbox_confirmation interaction as cancelled with a null reason when none is given", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss request_checkbox_confirmation");
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_checkbox_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Which files should be deleted?",
          options: [
            { id: "file-a", label: "a.txt" },
            { id: "file-b", label: "b.txt" },
          ],
        },
      }, { userId: "local-board" });

      const dismissed = await interactionsSvc.dismissInteraction(
        { id: issueId, companyId },
        created.id,
        {},
        { agentId },
      );

      expect(dismissed.status).toBe("cancelled");
      expect(dismissed.result).toEqual({
        version: 1,
        outcome: "rejected",
        reason: null,
      });
      expect(dismissed.resolvedByAgentId).toBe(agentId);
      expect(dismissed.resolvedByUserId).toBeNull();
    });

    it("throws not found when the interaction belongs to a different issue in the same company", async () => {
      const { companyId, goalId, issueId } = await seedConfirmationIssue("Dismiss issue mismatch owner");
      const otherIssueId = randomUUID();
      await db.insert(issues).values({
        id: otherIssueId,
        companyId,
        goalId,
        title: "Unrelated issue",
        status: "in_progress",
        priority: "medium",
      });

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Apply this plan?" },
      }, { userId: "local-board" });

      await expect(interactionsSvc.dismissInteraction(
        { id: otherIssueId, companyId },
        created.id,
        {},
        { userId: "local-board" },
      )).rejects.toThrow("Interaction not found");
    });

    it("throws not found when the interaction belongs to a different company", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss company mismatch owner");
      const otherCompanyId = randomUUID();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Apply this plan?" },
      }, { userId: "local-board" });

      await expect(interactionsSvc.dismissInteraction(
        { id: issueId, companyId: otherCompanyId },
        created.id,
        {},
        { userId: "local-board" },
      )).rejects.toThrow("Interaction not found");
    });

    it("throws a conflict when dismissing an interaction that is not pending", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss already resolved");

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Apply this plan?" },
      }, { userId: "local-board" });

      await db
        .update(issueThreadInteractions)
        .set({ status: "rejected" })
        .where(eq(issueThreadInteractions.id, created.id));

      await expect(interactionsSvc.dismissInteraction(
        { id: issueId, companyId },
        created.id,
        {},
        { userId: "local-board" },
      )).rejects.toThrow("Interaction has already been resolved");
    });

    it("allows only one winner when two dismiss calls race the same pending interaction", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("Dismiss concurrent race");

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Apply this plan?" },
      }, { userId: "local-board" });

      const [first, second] = await Promise.allSettled([
        interactionsSvc.dismissInteraction(
          { id: issueId, companyId },
          created.id,
          { reason: "First caller" },
          { userId: "local-board" },
        ),
        interactionsSvc.dismissInteraction(
          { id: issueId, companyId },
          created.id,
          { reason: "Second caller" },
          { userId: "local-board" },
        ),
      ]);

      const outcomes = [first, second];
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof interactionsSvc.dismissInteraction>>> =>
          outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]?.value.status).toBe("cancelled");
      expect((rejected[0]?.reason as Error).message).toBe("Interaction has already been resolved");

      const winnerReason = (fulfilled[0]?.value.result as { reason?: string | null } | null)?.reason;

      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("cancelled");
      expect((rows[0]?.result as { reason?: string | null } | null)?.reason).toBe(winnerReason);
      expect(["First caller", "Second caller"]).toContain(winnerReason);
    });
  });
});
