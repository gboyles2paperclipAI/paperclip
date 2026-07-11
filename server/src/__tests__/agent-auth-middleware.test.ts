import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent JWT middleware run binding", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let otherAgentId: string;
  let runId: string;
  let otherAgentRunId: string;
  let otherCompanyRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-auth-middleware-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "middleware-test-agent-jwt-secret";
    const [company, otherCompany] = await db.insert(companies).values([
      { name: `Agent auth ${randomUUID()}`, issuePrefix: `AA${randomUUID().slice(0, 5).toUpperCase()}` },
      { name: `Agent auth other ${randomUUID()}`, issuePrefix: `AB${randomUUID().slice(0, 5).toUpperCase()}` },
    ]).returning();
    companyId = company!.id;
    otherCompanyId = otherCompany!.id;

    const [agent, otherAgent] = await db.insert(agents).values([
      {
        companyId,
        name: "JWT actor",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
      {
        companyId: otherCompanyId,
        name: "Other JWT actor",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ]).returning();
    agentId = agent!.id;
    otherAgentId = otherAgent!.id;

    const [run, otherAgentRun, otherCompanyRun] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "running" },
      { companyId, agentId: otherAgentId, status: "running" },
      { companyId: otherCompanyId, agentId: otherAgentId, status: "running" },
    ]).returning();
    runId = run!.id;
    otherAgentRunId = otherAgentRun!.id;
    otherCompanyRunId = otherCompanyRun!.id;
  });

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    await tempDb?.cleanup();
  });

  function appForActor() {
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/actor", (req, res) => res.json(req.actor));
    return app;
  }

  it("uses the signed run and ignores a conflicting unsigned run header", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId)!;
    const res = await request(appForActor())
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", otherCompanyRunId);

    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    });
  });

  it.each([
    ["unknown", randomUUID()],
    ["cross-agent", () => otherAgentRunId],
    ["cross-company", () => otherCompanyRunId],
  ])("rejects a JWT with %s persisted run ownership", async (_label, runValue) => {
    const claimedRunId = typeof runValue === "function" ? runValue() : runValue;
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", claimedRunId)!;
    const res = await request(appForActor()).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.body).toMatchObject({ type: "none", source: "none" });
  });

  it("preserves API-key authentication while attaching only a matching run header", async () => {
    const apiKey = "agent-api-key-test-token";
    await db.insert(agentApiKeys).values({
      companyId,
      agentId,
      name: "middleware test",
      keyHash: createHash("sha256").update(apiKey).digest("hex"),
    });

    const valid = await request(appForActor())
      .get("/actor")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("X-Paperclip-Run-Id", runId);
    expect(valid.body).toMatchObject({ type: "agent", agentId, companyId, runId, source: "agent_key" });

    const mismatched = await request(appForActor())
      .get("/actor")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("X-Paperclip-Run-Id", otherCompanyRunId);
    expect(mismatched.body).toMatchObject({ type: "agent", agentId, companyId, source: "agent_key" });
    expect(mismatched.body).not.toHaveProperty("runId");
  });
});
