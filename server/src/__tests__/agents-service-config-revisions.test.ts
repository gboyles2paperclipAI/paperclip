import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent config revision tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service config revisions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-config-revisions-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-config-revisions");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("keeps paused status and legacy model profiles through revisions and restore", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const legacyProfile = {
      label: "Brand policy fallback",
      adapterConfig: {
        adapterType: "claude_local",
        model: "claude-sonnet-4-6",
      },
      legacyMetadata: { source: "pre-model-profile-v1" },
    };
    const initialRuntimeConfig = {
      heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 },
      modelProfiles: {
        cheap: { adapterConfig: { model: "claude-haiku-4-5-20251001" } },
        "brand-policy-fallback": legacyProfile,
      },
      futureRuntimeField: { preserved: true },
    };
    const svc = agentService(db);
    const created = await svc.create(companyId, {
      name: "Paused legacy profile agent",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-07-12T00:00:00.000Z"),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: initialRuntimeConfig,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const firstRuntimeConfig = structuredClone(initialRuntimeConfig);
    firstRuntimeConfig.modelProfiles.cheap.adapterConfig.model = "gpt-5.3-codex-spark";
    const firstUpdate = await svc.update(created.id, {
      runtimeConfig: firstRuntimeConfig,
    }, {
      recordRevision: { source: "patch", createdByUserId: "local-board" },
    });

    expect(firstUpdate).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      runtimeConfig: firstRuntimeConfig,
    });
    let revisions = await svc.listConfigRevisions(created.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.changedKeys).toEqual(["runtimeConfig"]);
    expect(revisions[0]?.beforeConfig).toMatchObject({ runtimeConfig: initialRuntimeConfig });
    expect(revisions[0]?.afterConfig).toMatchObject({ runtimeConfig: firstRuntimeConfig });

    const secondRuntimeConfig = structuredClone(firstRuntimeConfig);
    secondRuntimeConfig.modelProfiles.cheap.adapterConfig.model = "gpt-5.4";
    await svc.update(created.id, { runtimeConfig: secondRuntimeConfig }, {
      recordRevision: { source: "patch", createdByUserId: "local-board" },
    });

    const restored = await svc.rollbackConfigRevision(created.id, revisions[0]!.id, {
      userId: "local-board",
    });
    expect(restored).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      runtimeConfig: firstRuntimeConfig,
    });
    expect(restored?.runtimeConfig.modelProfiles?.["brand-policy-fallback"]).toEqual(legacyProfile);

    revisions = await svc.listConfigRevisions(created.id);
    expect(revisions).toHaveLength(3);
    expect(revisions[0]?.source).toBe("rollback");
    expect(revisions[0]?.changedKeys).toEqual(["runtimeConfig"]);
  });
});
