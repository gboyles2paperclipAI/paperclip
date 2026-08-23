import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { brokerOperations } from "@paperclipai/db";
import {
  claimBrokerOperationSchema,
  heartbeatBrokerOperationSchema,
  isUuidLike,
  submitBrokerOperationReceiptSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  claimBrokerOperation,
  heartbeatBrokerOperation,
  listBrokerOperations,
  submitBrokerOperationReceipt,
} from "../services/broker-operations.js";

/**
 * Approved-action broker claim/heartbeat/receipt surface (ADR R2.16/R3.6/R3.7,
 * PR-5). Board/system-only: the host broker authenticates as the loopback
 * board actor; agents can never claim, heartbeat, or submit receipts
 * (`assertBoard` rejects agent actors before any row is touched). Ships dark
 * with the quiescent human-decision rollout (OpenAPI exclusion, like
 * decision-leases.ts).
 */
export function brokerOperationRoutes(db: Db) {
  const router = Router();

  async function loadOperationForBoard(req: Request, res: Response, id: string) {
    assertBoard(req);
    if (!isUuidLike(id)) {
      res.status(400).json({ error: "Broker operation id must be a valid UUID" });
      return null;
    }
    const row = await db
      .select()
      .from(brokerOperations)
      .where(eq(brokerOperations.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      res.status(404).json({ error: "Broker operation not found" });
      return null;
    }
    assertCompanyAccess(req, row.companyId);
    return row;
  }

  router.get("/companies/:companyId/broker-operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const state = typeof req.query.state === "string" && req.query.state.length > 0
      ? req.query.state
      : null;
    res.json(await listBrokerOperations(db, companyId, { state }));
  });

  router.get("/broker-operations/:id", async (req, res) => {
    const row = await loadOperationForBoard(req, res, req.params.id as string);
    if (!row) return;
    res.json(row);
  });

  router.post(
    "/broker-operations/:id/claim",
    validate(claimBrokerOperationSchema),
    async (req, res) => {
      const row = await loadOperationForBoard(req, res, req.params.id as string);
      if (!row) return;
      const result = await claimBrokerOperation(db, {
        operationId: row.id,
        claimedBy: req.body.claimedBy,
        expectedGeneration: req.body.expectedGeneration,
      });
      res.json({ ...result.operation, reclaimed: result.reclaimed });
    },
  );

  router.post(
    "/broker-operations/:id/heartbeat",
    validate(heartbeatBrokerOperationSchema),
    async (req, res) => {
      const row = await loadOperationForBoard(req, res, req.params.id as string);
      if (!row) return;
      const operation = await heartbeatBrokerOperation(db, {
        operationId: row.id,
        claimedBy: req.body.claimedBy,
        claimGeneration: req.body.claimGeneration,
      });
      res.json(operation);
    },
  );

  router.post(
    "/broker-operations/:id/receipt",
    validate(submitBrokerOperationReceiptSchema),
    async (req, res) => {
      const row = await loadOperationForBoard(req, res, req.params.id as string);
      if (!row) return;
      const result = await submitBrokerOperationReceipt(db, {
        operationId: row.id,
        submission: req.body,
      });
      res.json({
        ...result.operation,
        applied: result.applied,
        forwardedIssueIds: result.forwardedIssueIds,
      });
    },
  );

  return router;
}
