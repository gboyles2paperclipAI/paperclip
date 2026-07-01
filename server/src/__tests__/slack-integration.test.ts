import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  buildSlackApprovalBlocks,
  handleSlackSocketEnvelope,
  isSlackSocketInteractiveEnvelope,
  parseSlackApprovalInteraction,
  parseSlackSocketEnvelope,
  postSlackMessage,
  redactSlackText,
  verifySlackRequestSignature,
} from "../services/slack-integration.js";
import { slackIntegrationRoutes } from "../routes/slack-integrations.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function sign(secret: string, timestamp: number, body: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function interactionBody(input: {
  approvalId: string;
  action?: "approve" | "reject" | "needs_changes";
  slackUserId?: string;
  responseUrl?: string;
}) {
  const payload = {
    type: "block_actions",
    team: { id: "T123" },
    channel: { id: "C123" },
    message: { ts: "1710000000.000100" },
    user: { id: input.slackUserId ?? "UOWNER" },
    response_url: input.responseUrl ?? "https://slack.example.test/response",
    actions: [
      {
        action_id: input.action ?? "approve",
        value: JSON.stringify({
          approval_id: input.approvalId,
          action: input.action ?? "approve",
        }),
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function createApp(db: ReturnType<typeof createDb>) {
  const app = express();
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };
  app.use(express.urlencoded({ extended: false, verify: captureRawBody }));
  app.use("/api", slackIntegrationRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describe("Slack integration utilities", () => {
  it("verifies Slack signatures over the exact raw body", () => {
    const secret = "slack-signing-secret";
    const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const timestamp = 1_700_000_000;
    const requestHash = verifySlackRequestSignature({
      signingSecret: secret,
      timestampHeader: String(timestamp),
      signatureHeader: sign(secret, timestamp, body),
      rawBody: body,
      nowSeconds: timestamp,
    });

    expect(requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects expired Slack signatures", () => {
    const secret = "slack-signing-secret";
    const body = "payload=test";
    expect(() =>
      verifySlackRequestSignature({
        signingSecret: secret,
        timestampHeader: "100",
        signatureHeader: sign(secret, 100, body),
        rawBody: body,
        nowSeconds: 100 + 301,
      }),
    ).toThrow("Expired Slack interaction");
  });

  it("parses minimal opaque approval action values", () => {
    const parsed = parseSlackApprovalInteraction({
      team: { id: "T123" },
      channel: { id: "C123" },
      message: { ts: "1710000000.000100" },
      user: { id: "U123" },
      actions: [{ action_id: "needs_changes", value: JSON.stringify({ approval_id: "appr-1", action: "needs_changes" }) }],
    });

    expect(parsed).toMatchObject({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1710000000.000100",
      userId: "U123",
      approvalId: "appr-1",
      action: "needs_changes",
    });
  });

  it("renders approval blocks without secret fields or raw screenshots", () => {
    const blocks = buildSlackApprovalBlocks({
      approvalId: "appr-1",
      type: "request_board_approval",
      payload: {
        summary: "Remote access request",
        password: "do-not-post",
        screenshotText: "untrusted image text",
        recoveryKey: "1234-5678-9012-3456",
      },
      paperclipUrl: "https://paperclip.example.test",
    });
    const encoded = JSON.stringify(blocks);

    expect(encoded).toContain("appr-1");
    expect(encoded).toContain("Remote access request");
    expect(encoded).not.toContain("do-not-post");
    expect(encoded).not.toContain("untrusted image text");
    expect(encoded).not.toContain("1234-5678");
    expect(encoded).toContain("Open in Paperclip");
  });

  it("redacts sensitive text in Slack payloads", () => {
    expect(redactSlackText("password: hunter2 MFA 123456 card 4242 4242 4242 4242"))
      .not.toContain("hunter2");
  });

  it("does not throw when Slack chat.postMessage is unreachable", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "C123";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    await expect(postSlackMessage({
      channel: process.env.SLACK_ALERTS_CHANNEL_ID,
      text: "safe notification",
    })).resolves.toEqual({ skipped: false, ok: false });

    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ALERTS_CHANNEL_ID;
  });

  it("parses and identifies Slack Socket Mode interactive envelopes", () => {
    const envelope = parseSlackSocketEnvelope(JSON.stringify({
      envelope_id: "env-1",
      type: "interactive",
      payload: {
        user: { id: "U123" },
        actions: [{ action_id: "approve", value: JSON.stringify({ approval_id: "appr-1", action: "approve" }) }],
      },
    }));

    expect(isSlackSocketInteractiveEnvelope(envelope)).toBe(true);
  });

  it("acks Slack Socket Mode interactions and uses the envelope ID for idempotency", async () => {
    const ack = vi.fn();
    const handleInteraction = vi.fn(async () => ({ id: "appr-1", status: "approved" }));
    const envelope = parseSlackSocketEnvelope(JSON.stringify({
      envelope_id: "env-1",
      type: "interactive",
      payload: {
        team: { id: "T123" },
        channel: { id: "C123" },
        message: { ts: "1710000000.000100" },
        user: { id: "U123" },
        actions: [{ action_id: "approve", value: JSON.stringify({ approval_id: "appr-1", action: "approve" }) }],
      },
    }));

    await handleSlackSocketEnvelope({ envelope, ack, service: { handleInteraction } });

    expect(ack).toHaveBeenCalledOnce();
    expect(handleInteraction).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "appr-1",
      userId: "U123",
    }), "socket:env-1");
  });

  it("keeps legacy chat references retired", () => {
    const legacyName = ["Dis", "cord"].join("");
    const legacyEnv = ["DIS", "CORD_WEBHOOK_URL"].join("");
    const result = spawnSync(
      "git",
      [
        "grep",
        "-n",
        "-E",
        `${legacyName}|${legacyName.toLowerCase()}|${legacyEnv}`,
        "--",
        ".",
        ":(exclude)packages/db/src/migrations/meta",
      ],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("");
  });
});

describeEmbeddedPostgres("Slack approval interactions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-integration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_USER_MAP_JSON;
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedApproval(status = "pending") {
    const company = await db.insert(companies).values({
      name: `Slack Test ${randomUUID()}`,
      issuePrefix: `ST${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "paperclip-owner",
      status: "active",
      membershipRole: "owner",
    });
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Support Agent",
      role: "support",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo ok" },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      title: "Approve remote access",
      status: "blocked",
      priority: "high",
      createdByAgentId: agent.id,
      assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const approval = await db.insert(approvals).values({
      companyId: company.id,
      type: "request_board_approval",
      requestedByAgentId: agent.id,
      requestedByUserId: null,
      status,
      payload: { scope: "remote_access_escalation_for_ticket_123" },
    }).returning().then((rows) => rows[0]!);
    await db.insert(issueApprovals).values({
      companyId: company.id,
      issueId: issue.id,
      approvalId: approval.id,
    });
    return { company, agent, issue, approval };
  }

  async function sendInteraction(app: express.Express, body: string, secret = "slack-secret") {
    const timestamp = Math.floor(Date.now() / 1000);
    return request(app)
      .post("/api/integrations/slack/interactions")
      .set("content-type", "application/x-www-form-urlencoded")
      .set("x-slack-request-timestamp", String(timestamp))
      .set("x-slack-signature", sign(secret, timestamp, body))
      .send(body);
  }

  it("records approval, audit event, and structured wakeup after verified Slack approval", async () => {
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_USER_MAP_JSON = JSON.stringify({ UOWNER: "paperclip-owner" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const { approval, agent } = await seedApproval();
    const body = interactionBody({ approvalId: approval.id });

    const res = await sendInteraction(createApp(db), body);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = await db.select().from(approvals).where(eq(approvals.id, approval.id)).then((rows) => rows[0]!);
    expect(updated.status).toBe("approved");

    const audit = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityType, "approval"), eq(activityLog.entityId, approval.id)))
      .orderBy(desc(activityLog.createdAt));
    expect(audit.some((row) => row.action === "approval.slack_decision_recorded")).toBe(true);
    expect(audit.find((row) => row.action === "approval.slack_decision_recorded")?.details).toMatchObject({
      slackTeamId: "T123",
      slackChannelId: "C123",
      slackUserId: "UOWNER",
      paperclipUserId: "paperclip-owner",
      decision: "approve",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.payload).toMatchObject({
      event: "board_approval_granted",
      approvalId: approval.id,
      approvedBy: "paperclip-owner",
    });
  }, 15_000);

  it("keeps the Slack approval response successful when requester wakeup fails", async () => {
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_USER_MAP_JSON = JSON.stringify({ UOWNER: "paperclip-owner" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const { approval, agent } = await seedApproval();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agent.id));

    const res = await sendInteraction(createApp(db), interactionBody({ approvalId: approval.id }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");
    const failure = await db.select().from(activityLog)
      .where(and(
        eq(activityLog.entityType, "approval"),
        eq(activityLog.entityId, approval.id),
        eq(activityLog.action, "approval.requester_wakeup_failed"),
      ));
    expect(failure).toHaveLength(1);
  }, 15_000);

  it("rejects unauthorized Slack users before resolving the approval", async () => {
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_USER_MAP_JSON = JSON.stringify({ UOTHER: "paperclip-owner" });
    const { approval } = await seedApproval();

    const res = await sendInteraction(createApp(db), interactionBody({ approvalId: approval.id, slackUserId: "UOWNER" }));

    expect(res.status).toBe(403);
    const unchanged = await db.select().from(approvals).where(eq(approvals.id, approval.id)).then((rows) => rows[0]!);
    expect(unchanged.status).toBe("pending");
  });

  it("rejects non-pending approvals", async () => {
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_USER_MAP_JSON = JSON.stringify({ UOWNER: "paperclip-owner" });
    const { approval } = await seedApproval("approved");

    const res = await sendInteraction(createApp(db), interactionBody({ approvalId: approval.id }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("not pending");
  });

  it("rejects duplicate Slack interactions by request hash", async () => {
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_USER_MAP_JSON = JSON.stringify({ UOWNER: "paperclip-owner" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const { approval } = await seedApproval();
    const body = interactionBody({ approvalId: approval.id, action: "needs_changes" });
    const app = createApp(db);

    const first = await sendInteraction(app, body);
    const second = await sendInteraction(app, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(422);
    expect(second.body.error).toContain("Duplicate");
  }, 15_000);
});
