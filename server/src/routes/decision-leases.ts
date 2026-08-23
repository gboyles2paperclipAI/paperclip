import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { decisionLeases } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import { heartbeatService, logActivity } from "../services/index.js";
import {
  buildContinuationPayloadForLease,
  dispatchDecisionContinuations,
  listDecisionLeaseMemberIds,
  listDecisionLeases,
  resolveLease,
} from "../services/decision-leases.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/**
 * Decision-lease observability + the dedicated break-glass release route
 * (ADR R2.6). Release is board/user-only, NEVER consults the freeze gate, and
 * resolves the lease as operator_override — emergency release is always one
 * authenticated call even when the cone is wedged.
 */
export function decisionLeaseRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  router.get("/companies/:companyId/decision-leases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const state = typeof req.query.state === "string" && req.query.state.length > 0
      ? req.query.state
      : null;
    const leases = await listDecisionLeases(db, companyId, { state });
    res.json(leases);
  });

  router.post("/decision-leases/:id/release", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!isUuidLike(id)) {
      res.status(400).json({ error: "Decision lease id must be a valid UUID" });
      return;
    }
    const lease = await db
      .select()
      .from(decisionLeases)
      .where(eq(decisionLeases.id, id))
      .then((rows) => rows[0] ?? null);
    if (!lease) {
      res.status(404).json({ error: "Decision lease not found" });
      return;
    }
    assertCompanyAccess(req, lease.companyId);

    const payload = await buildContinuationPayloadForLease(db, lease, "operator_override");
    const outcome = await resolveLease(db, lease.id, "operator_override", { payload });
    const actorId = req.actor.userId ?? "board";

    await logActivity(db, {
      companyId: lease.companyId,
      actorType: "user",
      actorId,
      action: "decision_lease.operator_override_released",
      entityType: "decision_lease",
      entityId: lease.id,
      details: {
        decisionKind: lease.decisionKind,
        decisionId: lease.decisionId,
        anchorIssueId: lease.anchorIssueId,
        applied: outcome.applied,
        disposition: outcome.disposition,
      },
    });

    if (outcome.applied) {
      // Best-effort immediate delivery; the scheduler outbox sweep is the
      // guaranteed path (CAS-consume makes both safe).
      await dispatchDecisionContinuations(db, { enqueueWakeup: heartbeat.wakeup }, { leaseId: lease.id })
        .catch(() => {});
    }

    const memberIssueIds = await listDecisionLeaseMemberIds(db, lease.id);
    res.json({
      leaseId: lease.id,
      applied: outcome.applied,
      disposition: outcome.disposition,
      state: outcome.lease.state,
      anchorIssueId: lease.anchorIssueId,
      memberIssueIds,
    });
  });

  return router;
}
