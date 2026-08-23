import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const DECISION_QUIESCENCE_MIGRATION = "0173_decision_quiescence_core.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-decision-quiescence-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

async function makeDecisionQuiescenceMigrationPending(sql: ReturnType<typeof postgres>): Promise<void> {
  const hash = await migrationHash(DECISION_QUIESCENCE_MIGRATION);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${hash}
  `;
  // Simulate the pre-0173 fork history for the objects the data step depends
  // on: without dropping the partial unique the duplicate pending rows below
  // could never be seeded.
  await sql`DROP INDEX IF EXISTS "agent_wakeup_requests_pending_idem_uq"`;
  await sql`DROP INDEX IF EXISTS "issues_open_routine_execution_hidden_uq"`;
}

async function seedCompanyAgent(sql: ReturnType<typeof postgres>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, 'Quiescence Co', ${`Q${companyId.slice(0, 4)}`})
  `;
  await sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
    VALUES (${agentId}, ${companyId}, 'Quiescence Agent', 'engineer', 'process', '{}'::jsonb)
  `;
  return { companyId, agentId };
}

async function seedWakeup(
  sql: ReturnType<typeof postgres>,
  input: {
    companyId: string;
    agentId: string;
    idempotencyKey: string | null;
    status: string;
    requestedAt: string;
  },
) {
  const id = randomUUID();
  await sql`
    INSERT INTO "agent_wakeup_requests"
      ("id", "company_id", "agent_id", "source", "status", "idempotency_key", "requested_at")
    VALUES
      (${id}, ${input.companyId}, ${input.agentId}, 'automation', ${input.status}, ${input.idempotencyKey}, ${input.requestedAt})
  `;
  return id;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision quiescence migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decision quiescence migration (0173)", () => {
  it(
    "duplicate-cancel data step keeps the EARLIEST pending row per idempotency key",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      let earliestId!: string;
      let middleId!: string;
      let latestId!: string;
      let otherKeyId!: string;
      let terminalSameKeyId!: string;
      let nullKeyId!: string;

      try {
        await makeDecisionQuiescenceMigrationPending(sql);
        const { companyId, agentId } = await seedCompanyAgent(sql);
        const key = `dup-key-${randomUUID()}`;

        // Three pending duplicates for one key across the pending statuses.
        earliestId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: key,
          status: "queued",
          requestedAt: "2026-08-01T00:00:00Z",
        });
        middleId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: key,
          status: "deferred_issue_execution",
          requestedAt: "2026-08-02T00:00:00Z",
        });
        latestId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: key,
          status: "claimed",
          requestedAt: "2026-08-03T00:00:00Z",
        });
        // Different key, terminal status for the same key, and a null key —
        // all outside the data step's scope.
        otherKeyId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: `other-${randomUUID()}`,
          status: "queued",
          requestedAt: "2026-08-01T00:00:00Z",
        });
        terminalSameKeyId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: key,
          status: "completed",
          requestedAt: "2026-07-01T00:00:00Z",
        });
        nullKeyId = await seedWakeup(sql, {
          companyId,
          agentId,
          idempotencyKey: null,
          status: "queued",
          requestedAt: "2026-08-01T00:00:00Z",
        });
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [DECISION_QUIESCENCE_MIGRATION],
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql<{
          id: string;
          status: string;
          error: string | null;
          finished_at: Date | null;
        }[]>`
          SELECT "id", "status", "error", "finished_at"
          FROM "agent_wakeup_requests"
        `;
        const byId = new Map(rows.map((row) => [row.id, row]));

        // Earliest pending duplicate survives untouched.
        expect(byId.get(earliestId)).toMatchObject({ status: "queued", error: null });
        // Later duplicates were cancelled with the migration marker.
        for (const cancelledId of [middleId, latestId]) {
          const row = byId.get(cancelledId)!;
          expect(row.status).toBe("cancelled");
          expect(row.error).toContain("migration 0173");
          expect(row.finished_at).not.toBeNull();
        }
        // Untouched: other key, terminal same-key, null key.
        expect(byId.get(otherKeyId)).toMatchObject({ status: "queued", error: null });
        expect(byId.get(terminalSameKeyId)).toMatchObject({ status: "completed", error: null });
        expect(byId.get(nullKeyId)).toMatchObject({ status: "queued", error: null });

        // The partial uniques exist again after the migration.
        const indexes = await verifySql<{ indexname: string }[]>`
          SELECT "indexname"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
            AND "indexname" IN (
              'agent_wakeup_requests_pending_idem_uq',
              'issues_open_routine_execution_hidden_uq'
            )
          ORDER BY "indexname"
        `;
        expect(indexes.map((row) => row.indexname)).toEqual([
          "agent_wakeup_requests_pending_idem_uq",
          "issues_open_routine_execution_hidden_uq",
        ]);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    30_000,
  );
});
