#!/usr/bin/env -S pnpm exec tsx
import fs from "node:fs";
import { desc, eq } from "drizzle-orm";
import { approvals, companies, createDb } from "@paperclipai/db";
import { slackIntegrationService } from "../src/services/slack-integration.js";

const INSTANCE_ROOT = process.env.PAPERCLIP_INSTANCE_ROOT ?? `${process.env.HOME ?? "."}/.paperclip/instances/default`;
const CONFIG_PATH = process.env.PAPERCLIP_CONFIG_PATH ?? `${INSTANCE_ROOT}/config.json`;
const ENV_PATH = process.env.PAPERCLIP_ENV_PATH ?? `${INSTANCE_ROOT}/.env`;

function readConnectionString(): string {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;
    const value =
      config?.database?.connectionString ??
      config?.db?.connectionString ??
      config?.connectionString;
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {}

  try {
    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, "").trim();
    }
  } catch {}

  throw new Error("Could not resolve Paperclip database connection");
}

const db = createDb(readConnectionString());
const company = await db
  .select()
  .from(companies)
  .where(eq(companies.issuePrefix, process.env.SMOKE_COMPANY_PREFIX ?? "FUL"))
  .orderBy(desc(companies.createdAt))
  .limit(1)
  .then((rows) => rows[0] ?? null);

if (!company) throw new Error("Help2day company was not found");

const approval = await db
  .insert(approvals)
  .values({
    companyId: company.id,
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: "local-board",
    status: "pending",
    payload: {
      summary: "Slack approval integration smoke test",
      scope: "slack_approval_smoke_test",
      instructions: "Approve, reject, or request changes from Slack. No customer action will be taken.",
    },
  })
  .returning()
  .then((rows) => rows[0]!);

const posted = await slackIntegrationService(db).postApprovalRequested(approval.id);
console.log(`approval_id=${approval.id}`);
console.log(`slack_posted=${posted.skipped ? "skipped" : posted.ok ? "ok" : "failed"}`);
process.exit(posted.skipped || posted.ok === false ? 1 : 0);
