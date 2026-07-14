import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
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
    `Skipping embedded Postgres agent API key inventory tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent API key inventory", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-api-key-inventory");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Key inventory test",
      issuePrefix: `K${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Inventory agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  it("returns last-use and every bounded board creation source without secret material", async () => {
    const { companyId, agentId } = await seedAgent();
    const service = agentService(db);
    const cases = [
      { source: "local_implicit", actorId: "local-board" },
      { source: "session", actorId: "session-user" },
      { source: "board_key", actorId: "board-key-user" },
      { source: "cloud_tenant", actorId: "cloud-user" },
    ] as const;
    const createdKeys = [];

    for (const testCase of cases) {
      const creation = {
        actorType: "user",
        actorId: testCase.actorId,
        source: testCase.source,
      } as const;
      const created = await service.createApiKey(
        agentId,
        testCase.source,
        { kind: "standard" },
        { creation },
      );
      createdKeys.push({ created, creation });
      await db.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: testCase.actorId,
        action: "agent.key_created",
        entityType: "agent",
        entityId: agentId,
        details: {
          keyId: created.id,
          name: created.name,
          scope: created.scope,
          creation: created.creation,
        },
      });
    }

    const lastUsedAt = new Date("2026-07-14T10:45:00.000Z");
    await db
      .update(agentApiKeys)
      .set({ lastUsedAt })
      .where(eq(agentApiKeys.id, createdKeys[0]!.created.id));

    const stored = await db.select({
      id: agentApiKeys.id,
      keyHash: agentApiKeys.keyHash,
    }).from(agentApiKeys);
    for (const { created } of createdKeys) {
      expect(stored.find((row) => row.id === created.id)?.keyHash).not.toBe(created.token);
      expect(created).not.toHaveProperty("keyHash");
    }

    const keys = await service.listKeys(agentId);
    expect(keys).toHaveLength(cases.length);
    for (const [index, { created, creation }] of createdKeys.entries()) {
      expect(keys.find((key) => key.id === created.id)).toEqual(expect.objectContaining({
        id: created.id,
        name: cases[index]!.source,
        scope: { kind: "standard" },
        creation,
        lastUsedAt: index === 0 ? lastUsedAt : null,
        revokedAt: null,
      }));
    }

    const activities = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "agent.key_created"));
    const serializedActivities = JSON.stringify(activities);
    for (const { created } of createdKeys) {
      expect(serializedActivities).not.toContain(created.token);
    }
    expect(serializedActivities).not.toContain("keyHash");
    expect(JSON.stringify(keys)).not.toContain("token");
    expect(JSON.stringify(keys)).not.toContain("keyHash");
    for (const { created } of createdKeys) {
      expect(JSON.stringify(keys)).not.toContain(created.token);
    }
  });

  it("recovers join-request claim provenance from the safe audit record", async () => {
    const { companyId, agentId } = await seedAgent();
    const service = agentService(db);
    const creation = {
      actorType: "system",
      actorId: "join-claim",
      source: "join_request_claim",
    } as const;
    const created = await service.createApiKey(
      agentId,
      "initial-join-key",
      { kind: "standard" },
      { creation },
    );

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "join-claim",
      action: "agent_api_key.claimed",
      entityType: "agent_api_key",
      entityId: created.id,
      details: {
        agentId,
        joinRequestId: randomUUID(),
        creation: created.creation,
      },
    });

    await expect(service.listKeys(agentId)).resolves.toEqual([
      expect.objectContaining({ id: created.id, creation }),
    ]);
    const activity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, created.id))
      .then((rows) => rows[0]);
    expect(JSON.stringify(activity)).not.toContain(created.token);
    expect(JSON.stringify(activity)).not.toContain("keyHash");
  });

  it("accepts responsible-user and creation options together without misreading either", async () => {
    const { agentId } = await seedAgent();
    const service = agentService(db);
    const creation = {
      actorType: "user",
      actorId: "creator-user",
      source: "session",
    } as const;

    const withBoth = await service.createApiKey(
      agentId,
      "both-options",
      { kind: "standard" },
      { responsibleUserId: "responsible-user", creation },
    );
    const provenanceOnly = await service.createApiKey(
      agentId,
      "provenance-only",
      { kind: "standard" },
      { creation },
    );
    const undefinedOptions = await service.createApiKey(
      agentId,
      "undefined-options",
      { kind: "standard" },
      undefined,
    );

    expect(withBoth.creation).toEqual(creation);
    expect(provenanceOnly.creation).toEqual(creation);
    expect(undefinedOptions.creation).toEqual({
      actorType: "unknown",
      actorId: null,
      source: "unknown",
    });
  });

  it("chooses duplicate creation activity deterministically by timestamp then id", async () => {
    const { companyId, agentId } = await seedAgent();
    const service = agentService(db);
    const created = await service.createApiKey(agentId, "duplicate-audit");
    const sharedTimestamp = new Date("2026-07-14T11:00:00.000Z");
    const stableCreation = {
      actorType: "user",
      actorId: "stable-winner",
      source: "session",
    } as const;

    await db.insert(activityLog).values([
      {
        id: "00000000-0000-4000-8000-000000000002",
        companyId,
        actorType: "user",
        actorId: "conflicting-loser",
        action: "agent.key_created",
        entityType: "agent",
        entityId: agentId,
        details: {
          keyId: created.id,
          creation: {
            actorType: "user",
            actorId: "conflicting-loser",
            source: "cloud_tenant",
          },
        },
        createdAt: sharedTimestamp,
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        companyId,
        actorType: "user",
        actorId: "stable-winner",
        action: "agent.key_created",
        entityType: "agent",
        entityId: agentId,
        details: { keyId: created.id, creation: stableCreation },
        createdAt: sharedTimestamp,
      },
    ]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.listKeys(agentId)).resolves.toEqual([
        expect.objectContaining({ id: created.id, creation: stableCreation }),
      ]);
    }
  });

  it("reports unknown provenance for rows created without provenance metadata", async () => {
    const { companyId, agentId } = await seedAgent();
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: keyId,
      companyId,
      agentId,
      name: "legacy",
      keyHash: "legacy-hash-only",
    });

    await expect(agentService(db).listKeys(agentId)).resolves.toEqual([
      expect.objectContaining({
        id: keyId,
        creation: {
          actorType: "unknown",
          actorId: null,
          source: "unknown",
        },
        lastUsedAt: null,
      }),
    ]);
  });
});
