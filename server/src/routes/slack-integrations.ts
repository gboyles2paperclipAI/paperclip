import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  parseSlackApprovalInteraction,
  slackHttpError,
  slackIntegrationService,
  verifySlackRequestSignature,
} from "../services/slack-integration.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

export function slackIntegrationRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const slack = slackIntegrationService(db, options);

  router.post("/integrations/slack/interactions", async (req, res, next) => {
    try {
      const requestHash = verifySlackRequestSignature({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        timestampHeader: req.header("x-slack-request-timestamp"),
        signatureHeader: req.header("x-slack-signature"),
        rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
      });
      const rawPayload = typeof req.body?.payload === "string" ? req.body.payload : null;
      if (!rawPayload) throw slackHttpError(new Error("Missing Slack payload"));
      const interaction = parseSlackApprovalInteraction(JSON.parse(rawPayload));
      const approval = await slack.handleInteraction(interaction, requestHash);
      res.json({ ok: true, approvalId: approval.id, status: approval.status });
    } catch (err) {
      next(slackHttpError(err));
    }
  });

  return router;
}
