import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";
import { getActiveDecisionFreeze } from "../decision-freeze.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
) {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
  if (activePauseHold) return true;
  // Decision-freeze membership also suppresses automatic recovery: a frozen
  // member is deliberately quiescent, not stranded (R2.1; empty tables → no-op).
  const activeDecisionFreeze = await getActiveDecisionFreeze(db, companyId, issueId);
  return Boolean(activeDecisionFreeze);
}
