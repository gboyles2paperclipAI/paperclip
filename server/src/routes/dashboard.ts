import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  dashboardService,
  parseRunTelemetryLimit,
  parseRunTelemetryWindowHours,
} from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/run-telemetry", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const telemetry = await svc.runTelemetry(companyId, {
      windowHours: parseRunTelemetryWindowHours(req.query.window),
      limit: parseRunTelemetryLimit(req.query.limit),
    });
    res.json(telemetry);
  });

  return router;
}
