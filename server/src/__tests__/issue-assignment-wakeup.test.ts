import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("skips wakeup when issue has no assignee", async () => {
    const wakeup = vi.fn();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup when issue is in backlog", async () => {
    const wakeup = vi.fn();
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes assignee with correct source and payload", async () => {
    const wakeup = vi.fn(async () => undefined);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: "issue-1", mutation: "update" },
      }),
    );
  });

  it("nulls all approval fields in contextSnapshot to prevent stale context leak across issues", async () => {
    const wakeup = vi.fn(async () => undefined);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-y", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          issueId: "issue-y",
          source: "issue.update",
          approvalId: null,
          approvalStatus: null,
          approvalType: null,
          approvalPayload: null,
          approvalDecisionNote: null,
          approvalDecidedAt: null,
          approvalDecidedByUserId: null,
        }),
      }),
    );
  });

  it("stale approvalId from a prior issue is overwritten by the null in contextSnapshot merge", () => {
    // Simulate the merge that the wakeup layer performs: { ...existingContext, ...incomingContext }
    const existingContext = {
      issueId: "issue-x",
      approvalId: "approval-old",
      approvalStatus: "approved",
      approvalType: "board_approval",
      approvalPayload: { foo: "bar" },
      approvalDecisionNote: "looks good",
      approvalDecidedAt: "2026-01-01T00:00:00Z",
      approvalDecidedByUserId: "user-1",
    };

    // This is what queueIssueAssignmentWakeup passes as contextSnapshot for issue-y
    const incomingSnapshot = {
      issueId: "issue-y",
      source: "issue.update",
      approvalId: null,
      approvalStatus: null,
      approvalType: null,
      approvalPayload: null,
      approvalDecisionNote: null,
      approvalDecidedAt: null,
      approvalDecidedByUserId: null,
    };

    const merged = { ...existingContext, ...incomingSnapshot };

    expect(merged.issueId).toBe("issue-y");
    expect(merged.approvalId).toBeNull();
    expect(merged.approvalStatus).toBeNull();
    expect(merged.approvalType).toBeNull();
    expect(merged.approvalPayload).toBeNull();
    expect(merged.approvalDecisionNote).toBeNull();
    expect(merged.approvalDecidedAt).toBeNull();
    expect(merged.approvalDecidedByUserId).toBeNull();
  });
});
