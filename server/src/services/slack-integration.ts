import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyMemberships } from "@paperclipai/db";
import { badRequest, forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { approvalService, heartbeatService, issueApprovalService, logActivity } from "./index.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const SLACK_VERSION = "v0";
const MAX_SLACK_SKEW_SECONDS = 60 * 5;
const APPROVAL_ACTIONS = new Set(["approve", "reject", "needs_changes"]);
const SECRET_TEXT_RE =
  /\b(?:password|passcode|mfa|2fa|otp|recovery key|api key|secret|token|authorization|bearer|credit card|card number|cvv|ssn)\b/i;
const IMAGE_KEY_RE = /(?:image|screenshot|attachment|asset|file|upload|photo)/i;
const SENSITIVE_LABEL_TEXT_RE =
  /\b(?:password|passcode|mfa|2fa|otp|recovery key|api key|secret|token|authorization|bearer|credit card|card number|cvv|ssn)\b\s*[:=]\s*[^\s,;]+/gi;

export type SlackApprovalAction = "approve" | "reject" | "needs_changes";

export interface SlackInteractionContext {
  teamId: string | null;
  channelId: string | null;
  messageTs: string | null;
  userId: string;
  action: SlackApprovalAction;
  approvalId: string;
  responseUrl: string | null;
  rawPayload: unknown;
}

export interface SlackSignatureVerificationInput {
  signingSecret: string | undefined;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer | string | undefined;
  nowSeconds?: number;
}

export function verifySlackRequestSignature(input: SlackSignatureVerificationInput): string {
  const signingSecret = input.signingSecret?.trim();
  if (!signingSecret) throw unauthorized("Slack signing secret is not configured");
  if (!input.timestampHeader || !input.signatureHeader || !input.rawBody) {
    throw unauthorized("Missing Slack signature headers");
  }

  const timestamp = Number(input.timestampHeader);
  if (!Number.isInteger(timestamp)) throw unauthorized("Invalid Slack timestamp");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_SLACK_SKEW_SECONDS) {
    throw unauthorized("Expired Slack interaction");
  }

  const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString("utf8") : input.rawBody;
  const base = `${SLACK_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SLACK_VERSION}=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const actual = input.signatureHeader.trim();
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw unauthorized("Invalid Slack signature");
  }

  return createHash("sha256").update(base).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeAction(value: string | null): SlackApprovalAction | null {
  if (value === "approve" || value === "reject" || value === "needs_changes") return value;
  return null;
}

function parseActionValue(value: unknown): { approvalId: string; action: SlackApprovalAction } | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const approvalId = stringValue(parsed.approval_id ?? parsed.approvalId);
    const action = normalizeAction(stringValue(parsed.action));
    return approvalId && action ? { approvalId, action } : null;
  } catch {
    const [approvalId, actionRaw] = raw.split(":");
    const action = normalizeAction(actionRaw ?? null);
    return approvalId && action ? { approvalId, action } : null;
  }
}

export function parseSlackApprovalInteraction(payload: unknown): SlackInteractionContext {
  if (!isRecord(payload)) throw badRequest("Malformed Slack interaction payload");
  const user = isRecord(payload.user) ? payload.user : null;
  const userId = stringValue(user?.id);
  if (!userId) throw badRequest("Slack interaction is missing user ID");

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const firstAction = actions.find(isRecord);
  if (!firstAction) throw badRequest("Slack interaction is missing action");
  const actionId = stringValue(firstAction.action_id);
  if (actionId && !APPROVAL_ACTIONS.has(actionId)) {
    throw badRequest("Unsupported Slack approval action");
  }

  const parsedValue = parseActionValue(firstAction.value);
  const action = parsedValue?.action ?? normalizeAction(actionId);
  const approvalId =
    parsedValue?.approvalId
    ?? stringValue(payload.callback_id)?.replace(/^paperclip_approval:/, "")
    ?? null;
  if (!approvalId || !action) throw badRequest("Slack approval action is incomplete");

  const team = isRecord(payload.team) ? payload.team : null;
  const channel = isRecord(payload.channel) ? payload.channel : null;
  const message = isRecord(payload.message) ? payload.message : null;

  return {
    teamId: stringValue(team?.id),
    channelId: stringValue(channel?.id),
    messageTs: stringValue(message?.ts) ?? stringValue(payload.message_ts),
    userId,
    action,
    approvalId,
    responseUrl: stringValue(payload.response_url),
    rawPayload: payload,
  };
}

function slackUserMapFromEnv(): Record<string, string> {
  const raw = process.env.SLACK_USER_MAP_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0
      ),
    );
  } catch {
    return {};
  }
}

export function mapSlackUserToPaperclipUser(slackUserId: string): string | null {
  return slackUserMapFromEnv()[slackUserId] ?? null;
}

export function redactSlackText(input: unknown): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return redactSensitiveText(text)
    .replace(SENSITIVE_LABEL_TEXT_RE, (match) => match.replace(/([:=]\s*)[^\s,;]+$/u, "$1***REDACTED***"))
    .replace(/\b\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}[- ]?\d{3,6}\b/g, "***REDACTED***")
    .slice(0, 700);
}

function summarizePayload(payload: Record<string, unknown>): string {
  const redacted = redactEventPayload(payload) ?? {};
  const entries = Object.entries(redacted)
    .filter(([key]) => !IMAGE_KEY_RE.test(key))
    .filter(([, value]) => typeof value !== "string" || !SECRET_TEXT_RE.test(value))
    .slice(0, 6);
  if (entries.length === 0) return "Open Paperclip for details.";
  return entries.map(([key, value]) => `*${key}:* ${redactSlackText(value)}`).join("\n");
}

export function buildSlackApprovalBlocks(input: {
  approvalId: string;
  type: string;
  payload: Record<string, unknown>;
  paperclipUrl?: string | null;
}) {
  const paperclipUrl = input.paperclipUrl?.trim();
  const value = (action: SlackApprovalAction) => JSON.stringify({ approval_id: input.approvalId, action });
  const elements: Array<Record<string, unknown>> = [
    {
      type: "button",
      text: { type: "plain_text", text: "Approve" },
      style: "primary",
      action_id: "approve",
      value: value("approve"),
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Reject" },
      style: "danger",
      action_id: "reject",
      value: value("reject"),
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Needs changes" },
      action_id: "needs_changes",
      value: value("needs_changes"),
    },
  ];
  if (paperclipUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Open in Paperclip" },
      action_id: "open_paperclip",
      url: `${paperclipUrl.replace(/\/$/, "")}/approvals/${input.approvalId}`,
      value: input.approvalId,
    });
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Paperclip approval requested*\nApproval ID: \`${input.approvalId}\`\nType: \`${input.type}\``,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: summarizePayload(input.payload) } },
    { type: "actions", elements },
  ];
}

export async function postSlackMessage(input: { channel: string | undefined; text: string; blocks?: unknown[] }) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const channel = input.channel?.trim();
  if (!token || !channel) return { skipped: true as const };
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: redactSlackText(input.text),
      ...(input.blocks ? { blocks: input.blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  }).catch((err) => {
    logger.warn({ err }, "Slack message post failed");
    return null;
  });
  if (!response) return { skipped: false as const, ok: false };
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    logger.warn({ status: response.status, error: body.error }, "Slack message post failed");
  }
  return { skipped: false as const, ok: Boolean(body.ok) };
}

export async function updateSlackInteractionMessage(input: {
  responseUrl: string | null;
  text: string;
  blocks?: unknown[];
}) {
  if (!input.responseUrl) return;
  await fetch(input.responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      replace_original: true,
      text: redactSlackText(input.text),
      ...(input.blocks ? { blocks: input.blocks } : {}),
    }),
  }).catch((err) => {
    logger.warn({ err }, "Slack response_url update failed");
  });
}

export function maybeNotifySlackForActivity(input: {
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
}) {
  const details = input.details ?? {};
  const textForAction = (): { channel: string | undefined; text: string } | null => {
    if (input.action === "issue.created") {
      return {
        channel: process.env.SLACK_TICKETS_CHANNEL_ID ?? process.env.SLACK_ALERTS_CHANNEL_ID,
        text: `Ticket created: ${input.entityId}`,
      };
    }
    if (input.action === "issue.updated" && details.status === "blocked") {
      return {
        channel: process.env.SLACK_ALERTS_CHANNEL_ID,
        text: `Agent blocked on issue: ${input.entityId}`,
      };
    }
    if (input.action.includes("escalation") || String(details.type ?? "").includes("escalation")) {
      return {
        channel: process.env.SLACK_ALERTS_CHANNEL_ID,
        text: `Escalation notification: ${input.entityType} ${input.entityId}`,
      };
    }
    return null;
  };
  const notification = textForAction();
  if (!notification) return;
  void postSlackMessage({
    ...notification,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: redactSlackText(notification.text) } }],
  }).catch((err) => logger.warn({ err }, "Slack activity notification failed"));
}

export function slackIntegrationService(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  async function assertAuthorizedUser(companyId: string, userId: string) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!member || member.membershipRole === "viewer") {
      throw forbidden("Mapped Paperclip user is not authorized to approve");
    }
  }

  async function assertNotReplay(companyId: string, approvalId: string, requestHash: string) {
    const existing = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, approvalId),
          eq(activityLog.action, "approval.slack_decision_recorded"),
          sql`${activityLog.details}->>'requestHash' = ${requestHash}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) throw unprocessable("Duplicate Slack interaction");
  }

  async function wakeRequester(input: {
    approval: Awaited<ReturnType<ReturnType<typeof approvalService>["getById"]>> & NonNullable<unknown>;
    linkedIssueIds: string[];
    actorUserId: string;
  }) {
    if (!input.approval.requestedByAgentId) return;
    const primaryIssueId = input.linkedIssueIds[0] ?? null;
    const wakeRun = await heartbeat.wakeup(input.approval.requestedByAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "board_approval_granted",
      payload: {
        event: "board_approval_granted",
        approvalId: input.approval.id,
        approvalStatus: input.approval.status,
        scope: input.approval.type,
        issueId: primaryIssueId,
        issueIds: input.linkedIssueIds,
        approvedBy: input.actorUserId,
        constraints: [
          "Do not request passwords or MFA codes",
          "Record all customer-impacting changes",
          "Stop and escalate if suspected compromise evidence increases",
        ],
      },
      requestedByActorType: "user",
      requestedByActorId: input.actorUserId,
      contextSnapshot: {
        source: "slack.approval",
        event: "board_approval_granted",
        approvalId: input.approval.id,
        approvalStatus: input.approval.status,
        taskId: primaryIssueId,
        issueId: primaryIssueId,
        issueIds: input.linkedIssueIds,
        wakeReason: "board_approval_granted",
      },
    });
    await logActivity(db, {
      companyId: input.approval.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "approval.requester_wakeup_queued",
      entityType: "approval",
      entityId: input.approval.id,
      details: {
        requesterAgentId: input.approval.requestedByAgentId,
        wakeRunId: wakeRun?.id ?? null,
        linkedIssueIds: input.linkedIssueIds,
      },
    });
  }

  return {
    postApprovalRequested: async (approvalId: string) => {
      const approval = await approvals.getById(approvalId);
      if (!approval) throw unprocessable("Approval not found");
      return postSlackMessage({
        channel: process.env.SLACK_APPROVALS_CHANNEL_ID,
        text: `Paperclip approval requested: ${approval.id}`,
        blocks: buildSlackApprovalBlocks({
          approvalId: approval.id,
          type: approval.type,
          payload: approval.payload,
          paperclipUrl: process.env.PAPERCLIP_PUBLIC_URL,
        }),
      });
    },

    handleInteraction: async (interaction: SlackInteractionContext, requestHash: string) => {
      const paperclipUserId = mapSlackUserToPaperclipUser(interaction.userId);
      if (!paperclipUserId) throw forbidden("Slack user is not mapped to a Paperclip board user");

      const existing = await approvals.getById(interaction.approvalId);
      if (!existing) throw unprocessable("Approval not found");
      if (!["pending", "revision_requested"].includes(existing.status)) {
        throw unprocessable("Approval is not pending");
      }
      await assertAuthorizedUser(existing.companyId, paperclipUserId);
      await assertNotReplay(existing.companyId, existing.id, requestHash);

      const decisionNote = `Slack decision by ${interaction.userId}`;
      const result = interaction.action === "approve"
        ? await approvals.approve(existing.id, paperclipUserId, decisionNote)
        : interaction.action === "reject"
          ? await approvals.reject(existing.id, paperclipUserId, decisionNote)
          : { approval: await approvals.requestRevision(existing.id, paperclipUserId, decisionNote), applied: true };

      const linkedIssues = await issueApprovals.listIssuesForApproval(result.approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      await logActivity(db, {
        companyId: result.approval.companyId,
        actorType: "user",
        actorId: paperclipUserId,
        action: interaction.action === "approve"
          ? "approval.approved"
          : interaction.action === "reject"
            ? "approval.rejected"
            : "approval.revision_requested",
        entityType: "approval",
        entityId: result.approval.id,
        details: { type: result.approval.type, source: "slack", linkedIssueIds },
      });
      await logActivity(db, {
        companyId: result.approval.companyId,
        actorType: "user",
        actorId: paperclipUserId,
        action: "approval.slack_decision_recorded",
        entityType: "approval",
        entityId: result.approval.id,
        details: {
          approvalId: result.approval.id,
          slackTeamId: interaction.teamId,
          slackChannelId: interaction.channelId,
          slackMessageTs: interaction.messageTs,
          slackUserId: interaction.userId,
          paperclipUserId,
          decision: interaction.action,
          requestHash,
        },
      });

      if (interaction.action === "approve" && result.applied) {
        try {
          await wakeRequester({ approval: result.approval, linkedIssueIds, actorUserId: paperclipUserId });
        } catch (err) {
          logger.warn(
            { err, approvalId: result.approval.id, requestedByAgentId: result.approval.requestedByAgentId },
            "failed to queue requester wakeup after Slack approval",
          );
          await logActivity(db, {
            companyId: result.approval.companyId,
            actorType: "user",
            actorId: paperclipUserId,
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: result.approval.id,
            details: {
              requesterAgentId: result.approval.requestedByAgentId,
              linkedIssueIds,
              source: "slack",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      await updateSlackInteractionMessage({
        responseUrl: interaction.responseUrl,
        text: `Paperclip approval ${result.approval.status}: ${result.approval.id}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Paperclip approval ${result.approval.status}*\nApproval ID: \`${result.approval.id}\`\nDecision recorded in Paperclip.`,
            },
          },
        ],
      });
      return result.approval;
    },
  };
}

export function slackHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  return badRequest(err instanceof Error ? err.message : "Invalid Slack interaction");
}
