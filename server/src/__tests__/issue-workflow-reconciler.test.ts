import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueWorkflowReconciler } from "../services/issue-workflow-reconciler.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue workflow reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueWorkflowReconciler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-workflow-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Help2day",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Lead",
      role: "engineering",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("reports and repairs blocked issues whose blockers are all resolved", async () => {
    const { companyId, agentId } = await seedCompany();
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Merged dependency",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: blockedId,
        companyId,
        title: "Still marked blocked",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const report = await issueWorkflowReconciler(db).reportCompany(companyId);
    expect(report.findings.map((finding) => finding.kind)).toContain("blocked_all_blockers_resolved");

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.map((repair) => repair.action)).toContain("clear_resolved_blockers");

    const [updated] = await db.select().from(issues).where(eq(issues.id, blockedId));
    expect(updated.status).toBe("todo");
    const relationRows = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, blockedId));
    expect(relationRows).toHaveLength(0);
  });

  it("resumes invalid blocked issues only when an active agent owner exists", async () => {
    const { companyId, agentId } = await seedCompany();
    const resumableId = randomUUID();
    const pendingInteractionId = randomUUID();

    await db.insert(issues).values([
      {
        id: resumableId,
        companyId,
        title: "Blocked with no wait path",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: pendingInteractionId,
        companyId,
        title: "Blocked pending confirmation",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: pendingInteractionId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { message: "Approve this path?" },
    });

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issueId: resumableId, action: "resume_invalid_blocked_issue" }),
      ]),
    );
    expect(result.findings.some((finding) => finding.issueId === pendingInteractionId)).toBe(false);

    const rows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")));
    expect(rows.map((row) => row.id)).toEqual([pendingInteractionId]);
  });

  it("clears terminal issue execution locks and cancels queued terminal runs", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already done",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date("2026-06-05T00:00:00Z"),
    });

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.map((repair) => repair.action)).toEqual(
      expect.arrayContaining(["clear_terminal_execution_lock", "cancel_terminal_queued_run"]),
    );

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue.checkoutRunId).toBeNull();
    expect(updatedIssue.executionRunId).toBeNull();
    expect(updatedIssue.executionLockedAt).toBeNull();

    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun.status).toBe("cancelled");
    expect(updatedRun.errorCode).toBe("issue_terminal_status");
  });

  it("skips blocked_without_wait_path repair when project worktree is held by another issue's active run", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = randomUUID();
    const runningIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared Workspace Project",
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: { issueId: runningIssueId },
    });
    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "Holding the project worktree",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        projectId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked without formal wait path",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        projectId,
      },
    ]);

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.some((r) => r.issueId === blockedIssueId && r.action === "resume_invalid_blocked_issue")).toBe(false);
    expect(result.skipped.some((s) => s.issueId === blockedIssueId && s.reason.startsWith("project_worktree_held:"))).toBe(true);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(updatedIssue.status).toBe("blocked");
  });

  it("retains blocked status for externally blocked issues when the blocker is confirmed but still open", async () => {
    const { companyId, agentId } = await seedCompany();
    const blockerId = randomUUID();
    const blockedId = randomUUID();

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Active blocker issue",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: blockedId,
        companyId,
        title: "Correctly blocked by active issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.some((r) => r.issueId === blockedId && r.action === "resume_invalid_blocked_issue")).toBe(false);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, blockedId));
    expect(updatedIssue.status).toBe("blocked");
  });

  it("reports unavailable assignees and unassigned actionable issues without guessing a new owner", async () => {
    const { companyId, agentId } = await seedCompany();
    const pausedAgentId = randomUUID();
    await db.insert(agents).values({
      id: pausedAgentId,
      companyId,
      name: "Paused Engineer",
      role: "engineering",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Assigned to paused owner",
        status: "todo",
        priority: "high",
        assigneeAgentId: pausedAgentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "No owner",
        status: "todo",
        priority: "high",
        assigneeAgentId: null,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Healthy owner",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(["assigned_to_unavailable_agent", "unassigned_actionable_issue"]),
    );
    expect(result.repaired.some((repair) => repair.action === "resume_invalid_blocked_issue")).toBe(false);
  });

  it("cross-project isolation: held worktree in project A does not suppress repair for blocked issue in project B", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const runningIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(projects).values([
      { id: projectAId, companyId, name: "Project A" },
      { id: projectBId, companyId, name: "Project B" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: { issueId: runningIssueId },
    });
    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "Holding project A worktree",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        projectId: projectAId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked in project B without wait path",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        projectId: projectBId,
      },
    ]);

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.some((r) => r.issueId === blockedIssueId && r.action === "resume_invalid_blocked_issue")).toBe(true);
    expect(result.skipped.some((s) => s.issueId === blockedIssueId)).toBe(false);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(updatedIssue.status).toBe("todo");
  });

  it("null projectId bypasses worktree-held check and proceeds to repair", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = randomUUID();
    const runningIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Some Project",
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: { issueId: runningIssueId },
    });
    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "Holding a project worktree",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        projectId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked without projectId or wait path",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        projectId: null,
      },
    ]);

    const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
    expect(result.repaired.some((r) => r.issueId === blockedIssueId && r.action === "resume_invalid_blocked_issue")).toBe(true);
    expect(result.skipped.some((s) => s.issueId === blockedIssueId)).toBe(false);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(updatedIssue.status).toBe("todo");
  });

  it.each(["queued", "scheduled_retry"] as const)(
    "worktree-held detection skips repair when holding run has status '%s'",
    async (runStatus) => {
      const { companyId, agentId } = await seedCompany();
      const projectId = randomUUID();
      const runningIssueId = randomUUID();
      const blockedIssueId = randomUUID();
      const activeRunId = randomUUID();

      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Shared Project",
      });
      await db.insert(heartbeatRuns).values({
        id: activeRunId,
        companyId,
        agentId,
        status: runStatus,
        invocationSource: "automation",
        contextSnapshot: { issueId: runningIssueId },
      });
      await db.insert(issues).values([
        {
          id: runningIssueId,
          companyId,
          title: "Holding the project worktree",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
          projectId,
          executionRunId: activeRunId,
          executionLockedAt: new Date(),
        },
        {
          id: blockedIssueId,
          companyId,
          title: "Blocked without formal wait path",
          status: "blocked",
          priority: "high",
          assigneeAgentId: agentId,
          projectId,
        },
      ]);

      const result = await issueWorkflowReconciler(db).reconcileCompany(companyId, { apply: true });
      expect(result.repaired.some((r) => r.issueId === blockedIssueId && r.action === "resume_invalid_blocked_issue")).toBe(false);
      expect(result.skipped.some((s) => s.issueId === blockedIssueId && s.reason.startsWith("project_worktree_held:"))).toBe(true);

      const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
      expect(updatedIssue.status).toBe("blocked");
    },
  );
});
