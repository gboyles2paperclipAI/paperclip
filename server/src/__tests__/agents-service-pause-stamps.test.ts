import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
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
    `Skipping embedded Postgres agent pause stamp tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent pause audit stamps", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-stamps-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(overrides: Partial<typeof agents.$inferInsert> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return { companyId, agentId };
  }

  async function readStamps(agentId: string) {
    const row = await db
      .select({
        status: agents.status,
        pausedAt: agents.pausedAt,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("agent row missing");
    return row;
  }

  it("pause() stamps pausedAt and a manual pauseReason", async () => {
    const { agentId } = await seedAgent();
    const svc = agentService(db);

    await svc.pause(agentId);

    const row = await readStamps(agentId);
    expect(row.status).toBe("paused");
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.pauseReason).toBe("manual");
  });

  it("update() with status paused stamps pausedAt and defaults pauseReason to manual", async () => {
    // This is the board/CTO lifecycle path (PATCH /api/agents/:id with
    // {"status": "paused"}) that historically left both audit fields null.
    const { agentId } = await seedAgent();
    const svc = agentService(db);
    const before = Date.now();

    const updated = await svc.update(agentId, { status: "paused" });
    expect(updated?.status).toBe("paused");

    const row = await readStamps(agentId);
    expect(row.status).toBe("paused");
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.pausedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.pauseReason).toBe("manual");
  });

  it("update() with status paused honors a caller-supplied pauseReason", async () => {
    const { agentId } = await seedAgent();
    const svc = agentService(db);

    await svc.update(agentId, { status: "paused", pauseReason: "system" });

    const row = await readStamps(agentId);
    expect(row.status).toBe("paused");
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.pauseReason).toBe("system");
  });

  it("update() keeps the original stamps when the agent is already paused", async () => {
    const pausedAt = new Date("2026-08-01T12:00:00.000Z");
    const { agentId } = await seedAgent({
      status: "paused",
      pausedAt,
      pauseReason: "budget",
    });
    const svc = agentService(db);

    await svc.update(agentId, { status: "paused", title: "Retitled" });

    const row = await readStamps(agentId);
    expect(row.pausedAt?.toISOString()).toBe(pausedAt.toISOString());
    expect(row.pauseReason).toBe("budget");
  });

  it("update() backfills missing stamps on an already-paused legacy row", async () => {
    // Rows written by the unstamped path before this fix have status paused
    // with both audit fields null. Re-asserting the paused status through the
    // service repairs them.
    const { agentId } = await seedAgent({
      status: "paused",
      pausedAt: null,
      pauseReason: null,
    });
    const svc = agentService(db);

    await svc.update(agentId, { status: "paused" });

    const row = await readStamps(agentId);
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.pauseReason).toBe("manual");
  });

  it("update() clears the stamps when the agent leaves the paused state", async () => {
    const { agentId } = await seedAgent({
      status: "paused",
      pausedAt: new Date("2026-08-01T12:00:00.000Z"),
      pauseReason: "manual",
    });
    const svc = agentService(db);

    await svc.update(agentId, { status: "idle" });

    const row = await readStamps(agentId);
    expect(row.status).toBe("idle");
    expect(row.pausedAt).toBeNull();
    expect(row.pauseReason).toBeNull();
  });

  it("update() ignores a stray pauseReason on a non-paused agent", async () => {
    const { agentId } = await seedAgent();
    const svc = agentService(db);

    await svc.update(agentId, { pauseReason: "system" });

    const row = await readStamps(agentId);
    expect(row.status).toBe("idle");
    expect(row.pausedAt).toBeNull();
    expect(row.pauseReason).toBeNull();
  });

  it("update() re-attributes an existing pause when only pauseReason is patched", async () => {
    const pausedAt = new Date("2026-08-01T12:00:00.000Z");
    const { agentId } = await seedAgent({
      status: "paused",
      pausedAt,
      pauseReason: "manual",
    });
    const svc = agentService(db);

    await svc.update(agentId, { pauseReason: "budget" });

    const row = await readStamps(agentId);
    expect(row.status).toBe("paused");
    expect(row.pausedAt?.toISOString()).toBe(pausedAt.toISOString());
    expect(row.pauseReason).toBe("budget");
  });

  it("update() without a status change leaves pause fields untouched", async () => {
    const pausedAt = new Date("2026-08-01T12:00:00.000Z");
    const { agentId } = await seedAgent({
      status: "paused",
      pausedAt,
      pauseReason: "manual",
    });
    const svc = agentService(db);

    await svc.update(agentId, { title: "Retitled" });

    const row = await readStamps(agentId);
    expect(row.status).toBe("paused");
    expect(row.pausedAt?.toISOString()).toBe(pausedAt.toISOString());
    expect(row.pauseReason).toBe("manual");
  });
});
