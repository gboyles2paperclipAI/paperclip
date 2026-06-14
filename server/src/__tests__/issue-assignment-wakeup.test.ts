import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

function makeHeartbeat() {
  const wakeup = vi.fn().mockResolvedValue(undefined);
  return { wakeup };
}

describe("queueIssueAssignmentWakeup", () => {
  it("does not wake when issue has no assignee", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
      reason: "issue_assigned",
      mutation: "assignee_changed",
      contextSource: "patch_route",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("does not wake when issue status is backlog", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "issue_assigned",
      mutation: "assignee_changed",
      contextSource: "patch_route",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("includes all 7 approval fields as explicit null in contextSnapshot", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-2", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "assignee_changed",
      contextSource: "patch_route",
    });
    const snapshot = heartbeat.wakeup.mock.calls[0][1].contextSnapshot;
    expect(snapshot).toMatchObject({
      approvalId: null,
      approvalStatus: null,
      approvalType: null,
      approvalPayload: null,
      approvalDecisionNote: null,
      approvalDecidedAt: null,
      approvalDecidedByUserId: null,
    });
  });

  it("stale approvalId from prior issue is suppressed after spread merge (regression: FUL-11220)", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-y", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "assignee_changed",
      contextSource: "patch_route",
    });
    const incoming = heartbeat.wakeup.mock.calls[0][1].contextSnapshot as Record<string, unknown>;
    // Simulate the merge that heartbeat.ts performs: existing context (with stale approval)
    // spread with the incoming contextSnapshot.
    const existingContext = {
      issueId: "issue-x",
      approvalId: "stale-approval-uuid",
      approvalStatus: "approved",
    };
    const merged = { ...existingContext, ...incoming };
    expect(merged.approvalId).toBeNull();
    expect(merged.approvalStatus).toBeNull();
  });

  it("passes through non-approval fields (issueId, source)", async () => {
    const heartbeat = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-3", assigneeAgentId: "agent-1", status: "in_progress" },
      reason: "issue_assigned",
      mutation: "assignee_changed",
      contextSource: "webhook",
    });
    const snapshot = heartbeat.wakeup.mock.calls[0][1].contextSnapshot;
    expect(snapshot).toMatchObject({ issueId: "issue-3", source: "webhook" });
  });
});
