import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";
import { getActiveDecisionFreeze } from "../decision-freeze.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

export type AutomaticRecoverySuppressionReason = "pause_hold" | "decision_freeze";

/**
 * Shared automatic-recovery suppression guard. Returns WHICH gate suppressed
 * recovery so callers can attribute logs/metrics correctly (a decision freeze
 * is not a pause hold — R2.1 keeps them separate booleans). Query order is a
 * deliberate short-circuit: the pause-hold ancestor walk runs first, and the
 * decision-freeze membership lookup runs only when pause-hold is false, so the
 * empty-lease-table case costs one extra indexed lookup at most.
 */
export async function getAutomaticRecoverySuppressionReason(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
): Promise<AutomaticRecoverySuppressionReason | null> {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
  if (activePauseHold) return "pause_hold";
  // Decision-freeze membership also suppresses automatic recovery: a frozen
  // member is deliberately quiescent, not stranded (empty tables → no-op).
  const activeDecisionFreeze = await getActiveDecisionFreeze(db, companyId, issueId);
  return activeDecisionFreeze ? "decision_freeze" : null;
}

/** Boolean convenience wrapper for call sites that do not attribute the cause. */
export async function isAutomaticRecoverySuppressed(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
): Promise<boolean> {
  return (await getAutomaticRecoverySuppressionReason(db, companyId, issueId, treeControlSvc)) !== null;
}
