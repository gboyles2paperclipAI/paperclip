import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresEmptyTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const migrationsUrl = new URL("./migrations/", import.meta.url);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

async function readJournalEntries(): Promise<JournalEntry[]> {
  const raw = await fs.readFile(journalUrl, "utf8");
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return parsed.entries;
}

async function readMigrationContent(fileName: string): Promise<string> {
  return fs.readFile(new URL(fileName, migrationsUrl), "utf8");
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function migrationHash(fileName: string): Promise<string> {
  return hashContent(await readMigrationContent(fileName));
}

async function createEmptyDatabase(prefix: string): Promise<string> {
  const db = await startEmbeddedPostgresEmptyTestDatabase(prefix);
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function applyMigrationsThrough(connectionString: string, maxIdx: number): Promise<void> {
  const entries = (await readJournalEntries()).filter((entry) => entry.idx <= maxIdx);
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );

    for (const entry of entries) {
      const fileName = `${entry.tag}.sql`;
      const content = await readMigrationContent(fileName);
      await sql.unsafe("BEGIN");
      try {
        for (const statement of splitMigrationStatements(content)) {
          await sql.unsafe(statement);
        }
        await sql`
          INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
          VALUES (${hashContent(content)}, ${entry.when})
        `;
        await sql.unsafe("COMMIT");
      } catch (error) {
        await sql.unsafe("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  } finally {
    await sql.end();
  }
}

async function seedRepresentativeForkRows(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      INSERT INTO "companies" ("id", "name")
      VALUES
        ('10000000-0000-0000-0000-000000000001', 'Lineage Test Co')
    `);
    await sql.unsafe(`
      INSERT INTO "company_secrets" ("id", "company_id", "key", "name")
      VALUES
        ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'LINEAGE_TEST_SECRET', 'Lineage Test Secret')
    `);
    await sql.unsafe(`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES
        ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'ACP Claude', 'engineer', 'acpx_local', '{"agent":"claude","effort":"high","other":"keep-claude"}'::jsonb),
        ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'ACP Codex', 'engineer', 'acpx_local', '{"agent":"codex","reasoningEffort":"medium","other":"keep-codex"}'::jsonb),
        ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'ACP Other', 'engineer', 'acpx_local', '{"agent":"other","other":"keep-other"}'::jsonb)
    `);
    await sql.unsafe(`
      INSERT INTO "agent_task_sessions" ("id", "company_id", "agent_id", "adapter_type", "task_key", "session_params_json", "session_display_id")
      VALUES
        ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'acpx_local', 'task-a', '{}'::jsonb, 'claude-session'),
        ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'acpx_local', 'task-b', '{}'::jsonb, 'codex-session'),
        ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'acpx_local', 'task-c', '{}'::jsonb, 'other-session')
    `);
    await sql.unsafe(`
      INSERT INTO "agent_runtime_state" ("agent_id", "company_id", "adapter_type", "session_id", "state_json", "last_error")
      VALUES
        ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'acpx_local', 'claude-session', '{"alive":true}'::jsonb, 'stale'),
        ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'acpx_local', 'codex-session', '{"alive":true}'::jsonb, 'stale'),
        ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'acpx_local', 'other-session', '{"alive":true}'::jsonb, 'stale')
    `);
  } finally {
    await sql.end();
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration lineage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("migration lineage contract", () => {
  it("keeps the forward journal shape accepted by the compatibility contract", async () => {
    const entries = await readJournalEntries();
    const tags = entries.map((entry) => entry.tag);
    const whens = entries.map((entry) => entry.when);

    expect(entries).toHaveLength(173);
    expect(tags.slice(126, 131)).toEqual([
      "0126_issue_comment_derived_attribution",
      "0127_recovery_action_terminal_cleanup",
      "0128_issue_thread_interaction_resolution_audit",
      "0129_moi_run_telemetry",
      "0130_environment_custom_images_instance_scoped",
    ]);
    expect(tags.slice(131)).toEqual([
      "0131_user_specific_secrets",
      "0132_agent_api_key_responsible_user",
      "0133_repair_run_responsible_user_context_refs",
      "0134_issue_comment_derived_attribution_fast",
      "0135_resource_membership_stars",
      "0136_run_responsible_user_invariant",
      "0137_repair_run_responsible_user_updated_at_sweep",
      "0138_acpx_default_engine_migration",
      "0139_skill_studio_server_foundation",
      "0140_skill_studio_run_retention",
      "0141_skill_studio_run_templates",
      "0142_built_in_managed_resources",
      "0143_heartbeat_runs_company_created_at_index",
      "0144_company_search_sort_indexes",
      "0145_cases_foundation",
      "0146_case_document_annotations",
      "0147_inbox_dismissal_snooze_kind",
      "0148_routine_activity_gate",
      "0149_cost_event_status",
      "0150_tool_access_mcp_connections",
      "0151_agent_access_phase2_contracts",
      "0152_tool_invocation_catalog_snapshots",
      "0153_tool_gateway_sessions",
      "0154_tool_connection_application_no_cascade",
      "0155_tool_stdio_command_templates",
      "0156_tool_oauth_states",
      "0157_tool_oauth_state_actor_binding",
      "0158_tool_oauth_state_session_binding",
      "0159_tool_profile_new_tools_review",
      "0160_tool_invocation_connected_mcp_metadata",
      "0161_named_mcp_gateways",
      "0162_mcp_gateway_contract_expansion",
      "0163_environment_custom_image_company_scope_repair",
      "0164_tool_runtime_metric_counters",
      "0165_secret_binding_projection_class",
      "0166_plugin_config_company_scope",
      "0167_connection_token_issuances",
      "0168_smoke_lab_results",
      "0169_environment_custom_image_instance_scope_cleanup",
      "0170_tool_connection_installs",
      "0171_tool_gateway_protocol_rate_limit_counters",
      "0172_issue_last_activity_and_heartbeat_lookup",
    ]);
    const preservedForkMaxWhen = Math.max(...whens.slice(0, 131));
    const integratedTailWhens = whens.slice(131);
    expect(new Set(tags).size).toBe(tags.length);
    expect(Math.min(...integratedTailWhens)).toBeGreaterThan(preservedForkMaxWhen);
    for (let index = 1; index < integratedTailWhens.length; index += 1) {
      expect(integratedTailWhens[index]).toBeGreaterThan(integratedTailWhens[index - 1]);
    }
    expect(tags).not.toContain("0127_environment_custom_images_instance_scoped");
  });
});

describeEmbeddedPostgres("migration lineage replay", () => {
  it(
    "replays the integrated history from an empty database once",
    async () => {
      const connectionString = await createEmptyDatabase("paperclip-lineage-empty-");

      await applyPendingMigrations(connectionString);

      const state = await inspectMigrations(connectionString);
      expect(state.status).toBe("upToDate");

      const envHash = await migrationHash("0130_environment_custom_images_instance_scoped.sql");
      const derivedFastHash = await migrationHash("0134_issue_comment_derived_attribution_fast.sql");
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql.unsafe<{
          migration_count: string;
          env_hash_rows: string;
          derived_fast_hash_rows: string;
          user_secret_tables: string;
          plugin_config_company_id: string;
        }[]>(`
          SELECT
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations") AS migration_count,
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '${envHash}') AS env_hash_rows,
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '${derivedFastHash}') AS derived_fast_hash_rows,
            (
              SELECT count(*)::text
              FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name IN ('user_secret_definitions', 'user_secret_declarations')
            ) AS user_secret_tables,
            (
              SELECT count(*)::text
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'plugin_config'
                AND column_name = 'company_id'
            ) AS plugin_config_company_id
        `);
        expect(rows[0]).toEqual({
          migration_count: "173",
          env_hash_rows: "1",
          derived_fast_hash_rows: "1",
          user_secret_tables: "2",
          plugin_config_company_id: "1",
        });
      } finally {
        await sql.end();
      }
    },
    60_000,
  );

  it(
    "upgrades a representative fork-history database without replaying absorbed effects",
    async () => {
      const connectionString = await createEmptyDatabase("paperclip-lineage-fork-");

      await applyMigrationsThrough(connectionString, 130);
      await seedRepresentativeForkRows(connectionString);
      await applyPendingMigrations(connectionString);

      const state = await inspectMigrations(connectionString);
      expect(state.status).toBe("upToDate");

      const envHash = await migrationHash("0130_environment_custom_images_instance_scoped.sql");
      const derivedFastHash = await migrationHash("0134_issue_comment_derived_attribution_fast.sql");
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql.unsafe<{
          migration_count: string;
          env_hash_rows: string;
          derived_fast_hash_rows: string;
          company_secret_scope: string;
          acp_claude_adapter_type: string;
          acp_claude_engine: string;
          acp_claude_effort: string;
          acp_claude_other_config: string;
          acp_codex_adapter_type: string;
          acp_codex_engine: string;
          acp_codex_model_reasoning_effort: string;
          acp_codex_other_config: string;
          acp_other_adapter_type: string;
          acp_matching_sessions_remaining: string;
          acp_unaffected_agent_session_remaining: string;
          acp_runtime_claude_adapter_type: string;
          acp_runtime_claude_session_id: string | null;
          acp_runtime_claude_state_json: Record<string, unknown>;
          acp_runtime_claude_last_error: string | null;
          acp_runtime_codex_adapter_type: string;
          acp_runtime_codex_session_id: string | null;
          acp_runtime_codex_state_json: Record<string, unknown>;
          acp_runtime_codex_last_error: string | null;
          acp_runtime_other_adapter_type: string;
        }[]>(`
          SELECT
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations") AS migration_count,
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '${envHash}') AS env_hash_rows,
            (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '${derivedFastHash}') AS derived_fast_hash_rows,
            (SELECT "scope" FROM "company_secrets" WHERE "id" = '20000000-0000-0000-0000-000000000001') AS company_secret_scope,
            (SELECT "adapter_type" FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000001') AS acp_claude_adapter_type,
            (SELECT "adapter_config" ->> 'engine' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000001') AS acp_claude_engine,
            (SELECT "adapter_config" ->> 'effort' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000001') AS acp_claude_effort,
            (SELECT "adapter_config" ->> 'other' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000001') AS acp_claude_other_config,
            (SELECT "adapter_type" FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000002') AS acp_codex_adapter_type,
            (SELECT "adapter_config" ->> 'engine' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000002') AS acp_codex_engine,
            (SELECT "adapter_config" ->> 'modelReasoningEffort' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000002') AS acp_codex_model_reasoning_effort,
            (SELECT "adapter_config" ->> 'other' FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000002') AS acp_codex_other_config,
            (SELECT "adapter_type" FROM "agents" WHERE "id" = '30000000-0000-0000-0000-000000000003') AS acp_other_adapter_type,
            (
              SELECT count(*)::text
              FROM "agent_task_sessions"
              WHERE "agent_id" IN ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002')
            ) AS acp_matching_sessions_remaining,
            (
              SELECT count(*)::text
              FROM "agent_task_sessions"
              WHERE "agent_id" = '30000000-0000-0000-0000-000000000003'
            ) AS acp_unaffected_agent_session_remaining,
            (SELECT "adapter_type" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000001') AS acp_runtime_claude_adapter_type,
            (SELECT "session_id" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000001') AS acp_runtime_claude_session_id,
            (SELECT "state_json" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000001') AS acp_runtime_claude_state_json,
            (SELECT "last_error" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000001') AS acp_runtime_claude_last_error,
            (SELECT "adapter_type" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000002') AS acp_runtime_codex_adapter_type,
            (SELECT "session_id" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000002') AS acp_runtime_codex_session_id,
            (SELECT "state_json" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000002') AS acp_runtime_codex_state_json,
            (SELECT "last_error" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000002') AS acp_runtime_codex_last_error,
            (SELECT "adapter_type" FROM "agent_runtime_state" WHERE "agent_id" = '30000000-0000-0000-0000-000000000003') AS acp_runtime_other_adapter_type
        `);
        expect(rows[0]).toEqual({
          migration_count: "173",
          env_hash_rows: "1",
          derived_fast_hash_rows: "1",
          company_secret_scope: "company",
          acp_claude_adapter_type: "claude_local",
          acp_claude_engine: "acp",
          acp_claude_effort: "high",
          acp_claude_other_config: "keep-claude",
          acp_codex_adapter_type: "codex_local",
          acp_codex_engine: "acp",
          acp_codex_model_reasoning_effort: "medium",
          acp_codex_other_config: "keep-codex",
          acp_other_adapter_type: "acpx_local",
          acp_matching_sessions_remaining: "0",
          acp_unaffected_agent_session_remaining: "1",
          acp_runtime_claude_adapter_type: "claude_local",
          acp_runtime_claude_session_id: null,
          acp_runtime_claude_state_json: {},
          acp_runtime_claude_last_error: null,
          acp_runtime_codex_adapter_type: "codex_local",
          acp_runtime_codex_session_id: null,
          acp_runtime_codex_state_json: {},
          acp_runtime_codex_last_error: null,
          acp_runtime_other_adapter_type: "acpx_local",
        });
      } finally {
        await sql.end();
      }
    },
    60_000,
  );
});
