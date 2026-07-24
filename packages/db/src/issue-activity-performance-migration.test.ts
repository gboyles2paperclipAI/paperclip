import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0172_issue_last_activity_and_heartbeat_lookup.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-issue-activity-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue activity migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue activity performance migration", () => {
  it("backfills activity, maintains it on writes, and exposes index-backed plans", async () => {
    const connectionString = await createTempDatabase();
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const localOnlyAt = "2026-03-26T13:00:00.000Z";
    const canonicalAt = "2026-03-26T12:00:00.000Z";

    try {
      await sql`DROP TRIGGER IF EXISTS "issues_maintain_last_activity_at" ON "issues"`;
      await sql`DROP TRIGGER IF EXISTS "issue_comments_touch_issue_last_activity" ON "issue_comments"`;
      await sql`DROP TRIGGER IF EXISTS "activity_log_touch_issue_last_activity" ON "activity_log"`;
      await sql`DROP INDEX IF EXISTS "issues_company_last_activity_idx"`;
      await sql`DROP INDEX IF EXISTS "heartbeat_runs_company_issue_created_at_desc_idx"`;
      await sql`ALTER TABLE "issues" DROP COLUMN IF EXISTS "last_activity_at"`;
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${await migrationHash()}
      `;

      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Performance test', 'PERF')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
        VALUES (${agentId}, ${companyId}, 'Performance agent', 'engineer', 'process', '{}'::jsonb)
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier", "updated_at")
        VALUES (${issueId}, ${companyId}, 'Activity target', 'PERF-1', '2026-03-26T10:00:00.000Z')
      `;
      await sql`
        INSERT INTO "issue_comments" ("company_id", "issue_id", "body", "created_at", "updated_at")
        VALUES (${companyId}, ${issueId}, 'Later comment', '2026-03-26T11:00:00.000Z', '2026-03-26T11:00:00.000Z')
      `;
      await sql`
        INSERT INTO "activity_log" ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "created_at")
        VALUES
          (${companyId}, 'system', 'system', 'issue.document_updated', 'issue', ${issueId}, ${canonicalAt}),
          (${companyId}, 'user', 'user-1', 'issue.read_marked', 'issue', ${issueId}, ${localOnlyAt})
      `;
      await sql`
        INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "context_snapshot", "created_at")
        VALUES (${runId}, ${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId })}, '2026-03-26T12:30:00.000Z')
      `;
    } finally {
      await sql.end();
    }

    expect(await inspectMigrations(connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION],
    });
    await applyPendingMigrations(connectionString);

    const verify = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const [backfilled] = await verify<{ last_activity_at: Date }[]>`
        SELECT "last_activity_at" FROM "issues" WHERE "id" = ${issueId}
      `;
      expect(backfilled?.last_activity_at.toISOString()).toBe(canonicalAt);

      await verify`
        INSERT INTO "issue_comments" ("company_id", "issue_id", "body", "created_at", "updated_at")
        VALUES (${companyId}, ${issueId}, 'Newest comment', '2026-03-26T14:00:00.000Z', '2026-03-26T14:00:00.000Z')
      `;
      const [afterComment] = await verify<{ last_activity_at: Date }[]>`
        SELECT "last_activity_at" FROM "issues" WHERE "id" = ${issueId}
      `;
      expect(afterComment?.last_activity_at.toISOString()).toBe("2026-03-26T14:00:00.000Z");

      await verify`
        INSERT INTO "activity_log" ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "created_at")
        VALUES (${companyId}, 'system', 'system', 'issue.status_changed', 'issue', ${issueId}, '2026-03-26T15:00:00.000Z')
      `;
      const [afterActivity] = await verify<{ last_activity_at: Date }[]>`
        SELECT "last_activity_at" FROM "issues" WHERE "id" = ${issueId}
      `;
      expect(afterActivity?.last_activity_at.toISOString()).toBe("2026-03-26T15:00:00.000Z");

      const beforeStatusWrite = Date.now();
      await verify`UPDATE "issues" SET "status" = 'todo' WHERE "id" = ${issueId}`;
      const [afterStatus] = await verify<{ last_activity_at: Date }[]>`
        SELECT "last_activity_at" FROM "issues" WHERE "id" = ${issueId}
      `;
      expect(afterStatus?.last_activity_at.getTime()).toBeGreaterThanOrEqual(beforeStatusWrite);

      await verify`SET enable_seqscan = off`;
      const heartbeatPlan = await verify.unsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (COSTS OFF) SELECT "id" FROM "heartbeat_runs" WHERE "company_id" = '${companyId}' AND ("context_snapshot" ->> 'issueId') = '${issueId}' ORDER BY "created_at" DESC, "id" DESC LIMIT 50`,
      );
      expect(heartbeatPlan.map((row) => row["QUERY PLAN"]).join("\n"))
        .toContain("heartbeat_runs_company_issue_created_at_desc_idx");

      const issuePlan = await verify.unsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (COSTS OFF) SELECT "id" FROM "issues" WHERE "company_id" = '${companyId}' ORDER BY "last_activity_at" DESC, "updated_at" DESC, "id" DESC LIMIT 50`,
      );
      const issuePlanText = issuePlan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(issuePlanText).toContain("issues_company_last_activity_idx");
      expect(issuePlanText).not.toContain("SubPlan");
      expect(issuePlanText).not.toContain("issue_comments");
      expect(issuePlanText).not.toContain("activity_log");
    } finally {
      await verify.end();
    }
  }, 30_000);
});
