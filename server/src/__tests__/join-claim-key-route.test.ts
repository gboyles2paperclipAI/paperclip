import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";

const mockCreateApiKey = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    agentService: () => ({ createApiKey: mockCreateApiKey }),
    logActivity: mockLogActivity,
  };
});

const { accessRoutes } = await import("../routes/access.js");
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres join-claim key route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /join-requests/:requestId/claim-api-key", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("join-claim-key-route");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockCreateApiKey.mockReset();
    mockLogActivity.mockReset();
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    app.use(errorHandler);
    return app;
  }

  it("passes join provenance through key creation and records only safe activity details", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const inviteId = randomUUID();
    const requestId = randomUUID();
    const keyId = randomUUID();
    const claimSecret = "test".repeat(4);
    const responsibleUserId = "approver-user";
    const creation = {
      actorType: "system",
      actorId: "join-claim",
      source: "join_request_claim",
    } as const;

    await db.insert(companies).values({
      id: companyId,
      name: "Join claim route test",
      issuePrefix: `J${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claimed agent",
      role: "engineer",
      status: "idle",
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: `invite-${randomUUID()}`,
      allowedJoinTypes: "agent",
      expiresAt: new Date("2027-07-14T00:00:00.000Z"),
    });
    await db.insert(joinRequests).values({
      id: requestId,
      inviteId,
      companyId,
      requestType: "agent",
      status: "approved",
      requestIp: "127.0.0.1",
      createdAgentId: agentId,
      approvedByUserId: responsibleUserId,
      approvedAt: new Date("2026-07-14T10:00:00.000Z"),
      claimSecretHash: createHash("sha256").update(claimSecret).digest("hex"),
      claimSecretExpiresAt: new Date("2027-07-14T00:00:00.000Z"),
    });

    mockCreateApiKey.mockResolvedValue({
      id: keyId,
      name: "initial-join-key",
      scope: { kind: "standard" },
      creation,
      token: "route-response-token-value",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date("2026-07-14T11:00:00.000Z"),
    });
    mockLogActivity.mockResolvedValue(undefined);

    const response = await request(createApp())
      .post(`/api/join-requests/${requestId}/claim-api-key`)
      .send({ claimSecret });

    expect(response.status).toBe(201);
    expect(mockCreateApiKey).toHaveBeenCalledWith(
      agentId,
      "initial-join-key",
      { kind: "standard" },
      { responsibleUserId, creation },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), {
      companyId,
      actorType: "system",
      actorId: "join-claim",
      action: "agent_api_key.claimed",
      entityType: "agent_api_key",
      entityId: keyId,
      details: {
        agentId,
        joinRequestId: requestId,
        keyId,
        responsibleUserId,
        creation,
      },
    });

    const activityPayload = JSON.stringify(mockLogActivity.mock.calls[0]?.[1]);
    expect(activityPayload).not.toContain(claimSecret);
    expect(activityPayload).not.toContain("route-response-token-value");
    expect(activityPayload).not.toMatch(/token|tokenHash|keyHash|hash/i);
  });
});
