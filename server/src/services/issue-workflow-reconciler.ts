import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { parseObject } from "../adapters/utils.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";

const ACTIVE_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ACTIVE_WAIT_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const UNAVAILABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export type IssueWorkflowFindingKind =
  | "blocked_all_blockers_resolved"
  | "blocked_without_wait_path"
  | "unresolved_dependency_without_blocked_status"
  | "assigned_to_unavailable_agent"
  | "unassigned_actionable_issue"
  | "terminal_issue_runtime_artifact"
  | "in_progress_without_active_run";

export type IssueWorkflowRepairAction =
  | "clear_resolved_blockers"
  | "resume_invalid_blocked_issue"
  | "clear_terminal_execution_lock"
  | "cancel_terminal_queued_run";

export type IssueWorkflowFinding = {
  kind: IssueWorkflowFindingKind;
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  evidence: Record<string, unknown>;
  recommendedAction: string;
};

export type IssueWorkflowRepair = {
  issueId: string;
  identifier: string | null;
  action: IssueWorkflowRepairAction;
  details: Record<string, unknown>;
};

export type IssueWorkflowReconciliationResult = {
  companyId: string;
  checked: number;
  findings: IssueWorkflowFinding[];
  repaired: IssueWorkflowRepair[];
  skipped: Array<{
    issueId: string;
    identifier: string | null;
    kind: IssueWorkflowFindingKind;
    reason: string;
  }>;
};

type IssueCandidate = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "priority"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionState"
  | "executionPolicy"
  | "monitorNextCheckAt"
  | "checkoutRunId"
  | "executionRunId"
  | "executionLockedAt"
  | "updatedAt"
  | "projectId"
>;

type AgentAvailability = {
  id: string;
  status: string;
  runtimeConfig: Record<string, unknown>;
  lastHeartbeatAt: Date | null;
};

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function hasScheduledMonitor(issue: IssueCandidate) {
  if (issue.monitorNextCheckAt) return true;
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  return Boolean(policy?.monitor?.nextCheckAt);
}

function agentUnavailableReason(agent: AgentAvailability | null | undefined) {
  if (!agent) return "missing_agent";
  if (UNAVAILABLE_AGENT_STATUSES.has(agent.status)) return `agent_status_${agent.status}`;
  const heartbeat = parseObject(agent.runtimeConfig.heartbeat);
  if (heartbeat.enabled === false) return "heartbeat_disabled";
  return null;
}

function issueSummary(issue: IssueCandidate) {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    projectId: issue.projectId,
  };
}

export function issueWorkflowReconciler(db: Db) {
  const issuesSvc = issueService(db);

  async function isProjectWorktreeHeld(
    companyId: string,
    projectId: string,
    excludeIssueId: string,
  ): Promise<{ held: boolean; byIssueId?: string; byRunId?: string }> {
    const row = await db
      .select({ issueId: issues.id, runId: heartbeatRuns.id })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          eq(heartbeatRuns.companyId, issues.companyId),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.projectId, projectId),
          isNull(issues.hiddenAt),
          not(eq(issues.id, excludeIssueId)),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return { held: false };
    return { held: true, byIssueId: row.issueId, byRunId: row.runId };
  }

  async function listIssueCandidates(companyId: string, limit: number) {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
        executionPolicy: issues.executionPolicy,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
        updatedAt: issues.updatedAt,
        projectId: issues.projectId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...ACTIVE_ISSUE_STATUSES, ...TERMINAL_ISSUE_STATUSES]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(limit);
  }

  async function buildPendingWaitMaps(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) {
      return {
        pendingInteractions: new Set<string>(),
        pendingApprovals: new Set<string>(),
        activeRecoveryActions: new Set<string>(),
      };
    }

    const [interactionRows, approvalRows, recoveryRows] = await Promise.all([
      db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, issueIds),
            eq(issueThreadInteractions.status, "pending"),
          ),
        ),
      db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(issueApprovals.issueId, issueIds),
            eq(approvals.companyId, companyId),
            inArray(approvals.status, [...ACTIVE_WAIT_APPROVAL_STATUSES]),
          ),
        ),
      db
        .select({ issueId: issueRecoveryActions.sourceIssueId })
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.companyId, companyId),
            inArray(issueRecoveryActions.sourceIssueId, issueIds),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
          ),
        ),
    ]);

    return {
      pendingInteractions: new Set(interactionRows.map((row) => row.issueId)),
      pendingApprovals: new Set(approvalRows.map((row) => row.issueId)),
      activeRecoveryActions: new Set(recoveryRows.map((row) => row.issueId)),
    };
  }

  async function buildAgentMap(companyId: string, agentIds: string[]) {
    const uniqueAgentIds = [...new Set(agentIds.filter(Boolean))];
    const map = new Map<string, AgentAvailability>();
    if (uniqueAgentIds.length === 0) return map;
    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, uniqueAgentIds)));
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  async function buildActiveRunMap(companyId: string) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])));

    const byIssueId = new Map<string, Array<{ id: string; status: string; agentId: string }>>();
    for (const row of rows) {
      const issueId = parseObject(row.contextSnapshot).issueId;
      if (typeof issueId !== "string" || issueId.length === 0) continue;
      const current = byIssueId.get(issueId) ?? [];
      current.push({ id: row.id, status: row.status, agentId: row.agentId });
      byIssueId.set(issueId, current);
    }
    return byIssueId;
  }

  function hasStructuredWaitPath(
    issue: IssueCandidate,
    maps: Awaited<ReturnType<typeof buildPendingWaitMaps>>,
    unresolvedBlockerCount: number,
  ) {
    return (
      unresolvedBlockerCount > 0 ||
      Boolean(issue.assigneeUserId) ||
      hasExecutionParticipant(issue.executionState) ||
      hasScheduledMonitor(issue) ||
      maps.pendingInteractions.has(issue.id) ||
      maps.pendingApprovals.has(issue.id) ||
      maps.activeRecoveryActions.has(issue.id)
    );
  }

  async function reportCompany(
    companyId: string,
    opts?: { limit?: number },
  ): Promise<IssueWorkflowReconciliationResult> {
    const candidates = await listIssueCandidates(companyId, opts?.limit ?? 1000);
    const issueIds = candidates.map((issue) => issue.id);
    const [dependencyReadiness, waitMaps, agentMap, activeRunMap] = await Promise.all([
      issuesSvc.listDependencyReadiness(companyId, issueIds),
      buildPendingWaitMaps(companyId, issueIds),
      buildAgentMap(companyId, candidates.map((issue) => issue.assigneeAgentId).filter((id): id is string => Boolean(id))),
      buildActiveRunMap(companyId),
    ]);

    const findings: IssueWorkflowFinding[] = [];

    for (const issue of candidates) {
      const readiness = dependencyReadiness.get(issue.id);
      const blockerIssueIds = readiness?.blockerIssueIds ?? [];
      const unresolvedBlockerIssueIds = readiness?.unresolvedBlockerIssueIds ?? [];
      const activeRuns = activeRunMap.get(issue.id) ?? [];

      if (issue.status === "blocked") {
        if (blockerIssueIds.length > 0 && unresolvedBlockerIssueIds.length === 0 && readiness?.isDependencyReady) {
          findings.push({
            ...issueSummary(issue),
            kind: "blocked_all_blockers_resolved",
            evidence: { blockerIssueIds },
            recommendedAction: "Clear resolved blocker relations and move the issue back to todo for execution.",
          });
        } else if (!hasStructuredWaitPath(issue, waitMaps, unresolvedBlockerIssueIds.length)) {
          findings.push({
            ...issueSummary(issue),
            kind: "blocked_without_wait_path",
            evidence: { blockerIssueIds, unresolvedBlockerIssueIds },
            recommendedAction: "Attach a first-class blocker/wait path or resume the issue if it already has an active owner.",
          });
        }
      } else if (ACTIVE_ISSUE_STATUSES.includes(issue.status as (typeof ACTIVE_ISSUE_STATUSES)[number])) {
        if (unresolvedBlockerIssueIds.length > 0) {
          findings.push({
            ...issueSummary(issue),
            kind: "unresolved_dependency_without_blocked_status",
            evidence: { blockerIssueIds, unresolvedBlockerIssueIds },
            recommendedAction: "Move the issue to blocked or remove/replace stale blocker relations.",
          });
        }
      }

      if (
        issue.assigneeAgentId &&
        ACTIVE_ISSUE_STATUSES.includes(issue.status as (typeof ACTIVE_ISSUE_STATUSES)[number])
      ) {
        const unavailableReason = agentUnavailableReason(agentMap.get(issue.assigneeAgentId));
        if (unavailableReason) {
          findings.push({
            ...issueSummary(issue),
            kind: "assigned_to_unavailable_agent",
            evidence: { unavailableReason },
            recommendedAction: "Reassign to an available compatible agent or create a board escalation.",
          });
        }
      }

      if ((issue.status === "todo" || issue.status === "in_progress") && !issue.assigneeAgentId && !issue.assigneeUserId) {
        findings.push({
          ...issueSummary(issue),
          kind: "unassigned_actionable_issue",
          evidence: {},
          recommendedAction: "Route to an appropriate active owner before it can execute.",
        });
      }

      if (
        TERMINAL_ISSUE_STATUSES.includes(issue.status as (typeof TERMINAL_ISSUE_STATUSES)[number]) &&
        (issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt || activeRuns.length > 0)
      ) {
        findings.push({
          ...issueSummary(issue),
          kind: "terminal_issue_runtime_artifact",
          evidence: {
            checkoutRunId: issue.checkoutRunId,
            executionRunId: issue.executionRunId,
            executionLockedAt: issue.executionLockedAt,
            activeRunIds: activeRuns.map((run) => run.id),
            activeRunStatuses: activeRuns.map((run) => run.status),
          },
          recommendedAction: "Clear stale issue execution locks and cancel queued/scheduled runtime work.",
        });
      }

      if (
        issue.status === "in_progress" &&
        activeRuns.length === 0 &&
        !hasStructuredWaitPath(issue, waitMaps, unresolvedBlockerIssueIds.length)
      ) {
        findings.push({
          ...issueSummary(issue),
          kind: "in_progress_without_active_run",
          evidence: {
            checkoutRunId: issue.checkoutRunId,
            executionRunId: issue.executionRunId,
            executionLockedAt: issue.executionLockedAt,
          },
          recommendedAction: "Wake/recover the assignee or move the issue to visible intervention.",
        });
      }
    }

    return { companyId, checked: candidates.length, findings, repaired: [], skipped: [] };
  }

  async function reconcileCompany(
    companyId: string,
    opts?: { apply?: boolean; limit?: number; actorId?: string },
  ): Promise<IssueWorkflowReconciliationResult> {
    const report = await reportCompany(companyId, opts);
    if (!opts?.apply) return report;

    const repaired: IssueWorkflowRepair[] = [];
    const skipped: IssueWorkflowReconciliationResult["skipped"] = [];
    const actorId = opts.actorId ?? "issue_workflow_reconciler";

    for (const finding of report.findings) {
      if (finding.kind === "blocked_all_blockers_resolved") {
        await issuesSvc.update(finding.issueId, { status: "todo", blockedByIssueIds: [] });
        repaired.push({
          issueId: finding.issueId,
          identifier: finding.identifier,
          action: "clear_resolved_blockers",
          details: finding.evidence,
        });
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId,
          action: "issue.workflow_reconciler.resolved_blockers_cleared",
          entityType: "issue",
          entityId: finding.issueId,
          details: {
            identifier: finding.identifier,
            blockerIssueIds: finding.evidence.blockerIssueIds ?? [],
          },
        });
        continue;
      }

      if (finding.kind === "blocked_without_wait_path") {
        const agentId = finding.assigneeAgentId;
        if (!agentId) {
          skipped.push({
            issueId: finding.issueId,
            identifier: finding.identifier,
            kind: finding.kind,
            reason: "missing_agent_assignee",
          });
          continue;
        }
        const [agent] = await db
          .select({ id: agents.id, status: agents.status, runtimeConfig: agents.runtimeConfig, lastHeartbeatAt: agents.lastHeartbeatAt })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
          .limit(1);
        const unavailableReason = agentUnavailableReason(agent ?? null);
        if (unavailableReason) {
          skipped.push({
            issueId: finding.issueId,
            identifier: finding.identifier,
            kind: finding.kind,
            reason: unavailableReason,
          });
          continue;
        }
        if (finding.projectId) {
          const worktreeHold = await isProjectWorktreeHeld(companyId, finding.projectId, finding.issueId);
          if (worktreeHold.held) {
            skipped.push({
              issueId: finding.issueId,
              identifier: finding.identifier,
              kind: finding.kind,
              reason: `project_worktree_held:${worktreeHold.byIssueId}:${worktreeHold.byRunId}`,
            });
            await logActivity(db, {
              companyId,
              actorType: "system",
              actorId,
              action: "issue.workflow_reconciler.project_worktree_held_skip",
              entityType: "issue",
              entityId: finding.issueId,
              details: {
                identifier: finding.identifier,
                assigneeAgentId: agentId,
                heldByIssueId: worktreeHold.byIssueId,
                heldByRunId: worktreeHold.byRunId,
              },
            });
            continue;
          }
        }
        await issuesSvc.update(finding.issueId, { status: "todo", blockedByIssueIds: [] });
        repaired.push({
          issueId: finding.issueId,
          identifier: finding.identifier,
          action: "resume_invalid_blocked_issue",
          details: finding.evidence,
        });
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId,
          action: "issue.workflow_reconciler.invalid_blocked_resumed",
          entityType: "issue",
          entityId: finding.issueId,
          details: {
            identifier: finding.identifier,
            assigneeAgentId: agentId,
          },
        });
        continue;
      }

      if (finding.kind === "terminal_issue_runtime_artifact") {
        await db
          .update(issues)
          .set({
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, finding.issueId));
        repaired.push({
          issueId: finding.issueId,
          identifier: finding.identifier,
          action: "clear_terminal_execution_lock",
          details: finding.evidence,
        });

        const activeRunIds = Array.isArray(finding.evidence.activeRunIds)
          ? finding.evidence.activeRunIds.filter((id): id is string => typeof id === "string")
          : [];
        const referencedRunIds = [
          ...activeRunIds,
          typeof finding.evidence.checkoutRunId === "string" ? finding.evidence.checkoutRunId : null,
          typeof finding.evidence.executionRunId === "string" ? finding.evidence.executionRunId : null,
        ].filter((id): id is string => Boolean(id));
        const candidateRunIds = [...new Set(referencedRunIds)];
        if (candidateRunIds.length > 0) {
          const cancellableRows = await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                inArray(heartbeatRuns.id, candidateRunIds),
                inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
              ),
            );
          const cancellableRunIds = cancellableRows.map((row) => row.id);
          if (cancellableRunIds.length > 0) {
            await db
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                errorCode: "issue_terminal_status",
                error: "Cancelled by issue workflow reconciler because the linked issue is terminal.",
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, cancellableRunIds)));
            for (const runId of cancellableRunIds) {
              repaired.push({
                issueId: finding.issueId,
                identifier: finding.identifier,
                action: "cancel_terminal_queued_run",
                details: { runId },
              });
            }
          }
        }

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId,
          action: "issue.workflow_reconciler.terminal_runtime_artifact_cleared",
          entityType: "issue",
          entityId: finding.issueId,
          details: {
            identifier: finding.identifier,
            evidence: finding.evidence,
          },
        });
      }
    }

    if (repaired.length > 0 || skipped.length > 0) {
      logger.info(
        { companyId, checked: report.checked, findings: report.findings.length, repaired: repaired.length, skipped: skipped.length },
        "issue workflow reconciler completed",
      );
    }

    return {
      ...report,
      repaired,
      skipped,
    };
  }

  async function listRecentActivity(companyId: string, limit = 20) {
    return db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          sql`${activityLog.action} like 'issue.workflow_reconciler.%'`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
  }

  return {
    reportCompany,
    reconcileCompany,
    listRecentActivity,
  };
}
