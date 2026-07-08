import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyMemberships, companySecrets } from "@paperclipai/db";
import { badRequest, forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { approvalService, heartbeatService, issueApprovalService, logActivity, secretService } from "./index.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const SLACK_VERSION = "v0";
const MAX_SLACK_SKEW_SECONDS = 60 * 5;
const BLOCKED_ACTIVITY_NOTIFICATION_DEDUPE_MS = 30 * 60 * 1000;
const APPROVAL_ACTIONS = new Set(["approve", "reject", "needs_changes"]);
const SECRET_TEXT_RE =
  /\b(?:password|passcode|mfa|2fa|otp|recovery key|api key|secret|token|authorization|bearer|credit card|card number|cvv|ssn)\b/i;
const IMAGE_KEY_RE = /(?:image|screenshot|attachment|asset|file|upload|photo)/i;
const SENSITIVE_LABEL_TEXT_RE =
  /\b(?:password|passcode|mfa|2fa|otp|recovery key|api key|secret|token|authorization|bearer|credit card|card number|cvv|ssn)\b\s*[:=]\s*[^\s,;]+/gi;
const NOISE_PAYLOAD_KEYS = new Set([
  "adapterConfig",
  "attachments",
  "blocks",
  "image",
  "images",
  "raw",
  "rawBody",
  "screenshot",
  "screenshots",
  "upload",
  "uploads",
]);

// Process-local blocked notification dedupe is intentional for the current
// single-process/systemd deployment. A future multi-node deployment may need
// DB, Redis, or outbox-backed dedupe, but do not migrate this Map to storage
// until the deployment model requires cross-process suppression.
const blockedActivityNotificationSeenAt = new Map<string, number>();

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

interface SlackSocketEnvelope {
  envelope_id?: unknown;
  type?: unknown;
  accepts_response_payload?: unknown;
  payload?: unknown;
  reason?: unknown;
  debug_info?: unknown;
}

interface SlackSocketConnection {
  close(): void;
}

interface SlackSocketModeOptions {
  pluginWorkerManager?: PluginWorkerManager;
  reconnectDelayMs?: number;
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

function parseApprovalAction(action: Record<string, unknown>) {
  const actionId = stringValue(action.action_id);
  const parsedValue = parseActionValue(action.value);
  const decision = parsedValue?.action ?? normalizeAction(actionId);
  if (!decision) return null;
  if (actionId && !APPROVAL_ACTIONS.has(actionId) && !parsedValue) return null;
  return { parsedValue, action: decision };
}

function hasSlackApprovalDecisionAction(payload: Record<string, unknown>) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return actions.filter(isRecord).some((action) => Boolean(parseApprovalAction(action)));
}

export function parseSlackApprovalInteraction(payload: unknown): SlackInteractionContext {
  if (!isRecord(payload)) throw badRequest("Malformed Slack interaction payload");
  const user = isRecord(payload.user) ? payload.user : null;
  const userId = stringValue(user?.id);
  if (!userId) throw badRequest("Slack interaction is missing user ID");

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const parsedAction = actions
    .filter(isRecord)
    .map((candidate) => parseApprovalAction(candidate))
    .find((parsed) => parsed);
  if (!parsedAction) throw badRequest("Slack approval action is incomplete");
  const { parsedValue, action } = parsedAction;
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

export function parseSlackSocketEnvelope(message: string): SlackSocketEnvelope {
  const parsed = JSON.parse(message) as unknown;
  if (!isRecord(parsed)) throw badRequest("Malformed Slack Socket Mode envelope");
  return parsed;
}

export function isSlackSocketInteractiveEnvelope(envelope: SlackSocketEnvelope): boolean {
  return envelope.type === "interactive" && isRecord(envelope.payload);
}

export async function handleSlackSocketEnvelope(input: {
  envelope: SlackSocketEnvelope;
  ack: (payload?: Record<string, unknown>) => void;
  service: Pick<ReturnType<typeof slackIntegrationService>, "handleInteraction">;
}) {
  const envelopeId = stringValue(input.envelope.envelope_id);
  if (!envelopeId) throw badRequest("Slack Socket Mode envelope is missing envelope_id");
  input.ack();

  if (!isSlackSocketInteractiveEnvelope(input.envelope)) return { ignored: true as const };
  const payload = input.envelope.payload;
  if (!isRecord(payload)) return { ignored: true as const };
  if (!hasSlackApprovalDecisionAction(payload)) return { ignored: true as const };
  const interaction = parseSlackApprovalInteraction(payload);
  const approval = await input.service.handleInteraction(interaction, `socket:${envelopeId}`);
  return { ignored: false as const, approval };
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

async function findCompanySecretByKey(db: Db, companyId: string | null, key: string) {
  const keys = Array.from(new Set([key, key.toLowerCase()]));
  const names = Array.from(new Set([key, key.toLowerCase()]));
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(
      companyId ? eq(companySecrets.companyId, companyId) : undefined,
      ne(companySecrets.status, "deleted"),
      or(inArray(companySecrets.key, keys), inArray(companySecrets.name, names)),
    ))
    .orderBy(desc(companySecrets.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveSlackSetting(db: Db | undefined, companyId: string | null | undefined, key: string): Promise<string | null> {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  if (!db) return null;
  const secret = await findCompanySecretByKey(db, companyId ?? null, key);
  if (!secret) return null;
  return secretService(db).resolveSecretValue(secret.companyId, secret.id, "latest").catch((err) => {
    logger.warn({ err, companyId: secret.companyId, secretKey: secret.key }, "Slack secret resolution failed");
    return null;
  });
}

export async function mapSlackUserToPaperclipUser(
  slackUserId: string,
  db?: Db,
  companyId?: string | null,
): Promise<string | null> {
  const fromEnv = slackUserMapFromEnv()[slackUserId];
  if (fromEnv) return fromEnv;
  const raw = await resolveSlackSetting(db, companyId, "SLACK_USER_MAP_JSON");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const mapped = parsed[slackUserId];
    return typeof mapped === "string" && mapped.trim() ? mapped.trim() : null;
  } catch {
    return null;
  }
}

export function redactSlackText(input: unknown): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return redactSensitiveText(text)
    .replace(SENSITIVE_LABEL_TEXT_RE, (match) => match.replace(/([:=]\s*)[^\s,;]+$/u, "$1***REDACTED***"))
    .replace(/\b\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}[- ]?\d{3,6}\b/g, "***REDACTED***")
    .slice(0, 700);
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function formatSlackValue(value: unknown, maxLength = 140): string {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (Array.isArray(value)) {
    const joined = value.map((entry) => redactSlackText(entry)).filter(Boolean).slice(0, 4).join(", ");
    return joined.length > 0 ? joined.slice(0, maxLength) : "Not provided";
  }
  if (typeof value === "object") {
    return redactSlackText(value).slice(0, maxLength);
  }
  return redactSlackText(String(value)).slice(0, maxLength);
}

function truncateSlackText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const redacted = redactSlackText(value).replace(/\s+/g, " ").trim();
  if (!redacted) return null;
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : redacted;
}

function payloadText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return redactSlackText(value);
  }
  return null;
}

function approvalTypeLabel(type: string): string {
  switch (type) {
    case "hire_agent":
      return "Hire agent";
    case "approve_ceo_strategy":
      return "CEO strategy";
    case "budget_override_required":
      return "Budget override";
    case "request_board_approval":
      return "Board approval";
    default:
      return humanizeKey(type);
  }
}

function compactId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function compactAgent(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  return raw.length > 12 ? `agent ${compactId(raw)}` : raw;
}

function actionRequiredLine(required: boolean, reason: string): string {
  return `Action required: ${required ? "yes" : "no"} - ${reason}`;
}

function blockedActivityDedupeKey(input: {
  companyId?: string | null;
  entityId: string;
  details: Record<string, unknown>;
  summary: string;
}): string {
  const reason =
    stringValue(input.details.blocker)
    ?? stringValue(input.details.reason)
    ?? stringValue(input.details.summary)
    ?? stringValue(input.details.title)
    ?? input.summary;
  return [
    input.companyId ?? "global",
    input.entityId,
    reason.toLowerCase().replace(/\s+/g, " ").slice(0, 240),
  ].join(":");
}

function hasRecentBlockedActivityNotification(key: string, nowMs: number): boolean {
  const previous = blockedActivityNotificationSeenAt.get(key);
  if (previous !== undefined && nowMs - previous < BLOCKED_ACTIVITY_NOTIFICATION_DEDUPE_MS) {
    return true;
  }
  blockedActivityNotificationSeenAt.set(key, nowMs);
  for (const [seenKey, seenAt] of blockedActivityNotificationSeenAt) {
    if (nowMs - seenAt >= BLOCKED_ACTIVITY_NOTIFICATION_DEDUPE_MS) {
      blockedActivityNotificationSeenAt.delete(seenKey);
    }
  }
  return false;
}

export function resetSlackActivityNotificationDedupeForTests() {
  blockedActivityNotificationSeenAt.clear();
}

function buildPayloadFields(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const redacted = redactEventPayload(payload) ?? {};
  const preferredKeys = [
    "scope",
    "reason",
    "risk",
    "priority",
    "customer",
    "ticketId",
    "issueId",
    "issueIds",
    "requestedBy",
    "requestedByAgentId",
  ];
  const seen = new Set<string>();
  const fields: Array<Record<string, unknown>> = [];
  for (const key of preferredKeys) {
    if (!(key in redacted) || IMAGE_KEY_RE.test(key) || NOISE_PAYLOAD_KEYS.has(key)) continue;
    const value = redacted[key];
    if (typeof value === "string" && SECRET_TEXT_RE.test(value)) continue;
    fields.push({
      type: "mrkdwn",
      text: `*${humanizeKey(key)}*\n${formatSlackValue(value)}`,
    });
    seen.add(key);
    if (fields.length >= 8) return fields;
  }
  for (const [key, value] of Object.entries(redacted)) {
    if (seen.has(key)) continue;
    if (IMAGE_KEY_RE.test(key) || NOISE_PAYLOAD_KEYS.has(key)) continue;
    if (["summary", "title", "description", "instructions"].includes(key)) continue;
    if (typeof value === "string" && SECRET_TEXT_RE.test(value)) continue;
    fields.push({
      type: "mrkdwn",
      text: `*${humanizeKey(key)}*\n${formatSlackValue(value)}`,
    });
    if (fields.length >= 8) break;
  }
  return fields;
}

export function buildSlackApprovalBlocks(input: {
  approvalId: string;
  type: string;
  payload: Record<string, unknown>;
  paperclipUrl?: string | null;
}) {
  const paperclipUrl = input.paperclipUrl?.trim();
  const value = (action: SlackApprovalAction) => JSON.stringify({ approval_id: input.approvalId, action });
  const title =
    payloadText(input.payload, ["title", "summary", "scope", "reason"])
    ?? "Paperclip approval requested";
  const description = payloadText(input.payload, ["description", "instructions"]);
  const fields = [
    {
      type: "mrkdwn",
      text: `*Action required*\nyes - approve, reject, or request changes`,
    },
    {
      type: "mrkdwn",
      text: `*Owner*\nBoard/operator`,
    },
    {
      type: "mrkdwn",
      text: `*Approval ID*\n\`${input.approvalId}\``,
    },
    {
      type: "mrkdwn",
      text: `*Request type*\n${approvalTypeLabel(input.type)}`,
    },
    ...buildPayloadFields(input.payload),
  ].slice(0, 10);
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
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*[ACTION REQUIRED] Approval needed*\n${actionRequiredLine(true, "approve, reject, or request changes")}\n${truncateSlackText(title, 240) ?? "Open Paperclip for details."}`,
      },
    },
    {
      type: "section",
      fields: fields.slice(0, 6),
    },
  ];
  if (description) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Context: ${truncateSlackText(description, 240)}` }],
    });
  }
  blocks.push(
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Next update: Paperclip records the button decision and wakes the requester when the approval is applied.",
        },
      ],
    },
    { type: "actions", elements },
  );
  return blocks;
}

export async function postSlackMessage(input: {
  db?: Db;
  companyId?: string | null;
  channel: string | undefined;
  channelKey?: "SLACK_APPROVALS_CHANNEL_ID" | "SLACK_ALERTS_CHANNEL_ID" | "SLACK_TICKETS_CHANNEL_ID";
  text: string;
  blocks?: unknown[];
}) {
  const token = await resolveSlackSetting(input.db, input.companyId, "SLACK_BOT_TOKEN");
  const channel = input.channel?.trim() || (input.channelKey
    ? await resolveSlackSetting(input.db, input.companyId, input.channelKey)
    : null);
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

function buildActivityNotificationBlocks(input: {
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  actionRequired: string;
  owner: string;
  nextUpdate: string;
}) {
  const fields: Array<Record<string, unknown>> = [
    { type: "mrkdwn", text: `*Action required*\n${input.actionRequired.replace(/^Action required:\s*/i, "")}` },
    { type: "mrkdwn", text: `*Owner*\n${input.owner}` },
    { type: "mrkdwn", text: `*Entity*\n${humanizeKey(input.entityType)} ${compactId(input.entityId)}` },
    { type: "mrkdwn", text: `*Next update*\n${input.nextUpdate}` },
  ];
  for (const [key, value] of Object.entries(redactEventPayload(input.details) ?? {})) {
    if (fields.length >= 7) break;
    if (IMAGE_KEY_RE.test(key) || NOISE_PAYLOAD_KEYS.has(key)) continue;
    if (typeof value === "string" && SECRET_TEXT_RE.test(value)) continue;
    fields.push({ type: "mrkdwn", text: `*${humanizeKey(key)}*\n${formatSlackValue(value, 120)}` });
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${input.title}*\n${input.actionRequired}\n${input.summary}` },
    },
    {
      type: "section",
      fields,
    },
  ];
}

function buildIssueInteractionNotificationBlocks(input: {
  title: string;
  summary: string;
  entityId: string;
  details: Record<string, unknown>;
  paperclipUrl?: string | null;
}) {
  const details = redactEventPayload(input.details) ?? {};
  const interactionKind = stringValue(details.interactionKind);
  const issueIdentifier = stringValue(details.issueIdentifier);
  const issueTitle = truncateSlackText(stringValue(details.issueTitle), 120);
  const cardTitle = truncateSlackText(stringValue(details.interactionTitle) ?? input.summary, 180);
  const prompt = truncateSlackText(stringValue(details.prompt) ?? stringValue(details.interactionSummary), 220);
  const requestedBy = compactAgent(details.createdByAgentId);
  const optionCount = typeof details.optionCount === "number" ? details.optionCount : null;
  const fields: Array<Record<string, unknown>> = [
    {
      type: "mrkdwn",
      text: `*Action required*\nyes - review the decision card`,
    },
    {
      type: "mrkdwn",
      text: `*Owner*\nBoard/operator`,
    },
    {
      type: "mrkdwn",
      text: `*Issue*\n${issueIdentifier ? `${issueIdentifier}${issueTitle ? ` - ${issueTitle}` : ""}` : compactId(input.entityId)}`,
    },
    {
      type: "mrkdwn",
      text: `*Decision type*\n${interactionKind === "request_checkbox_confirmation" ? "Select initiatives" : "Accept or reject"}`,
    },
  ];
  if (requestedBy) {
    fields.push({ type: "mrkdwn", text: `*Requested by*\n${requestedBy}` });
  }
  if (optionCount !== null) {
    fields.push({ type: "mrkdwn", text: `*Options*\n${optionCount}` });
  }
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*[ACTION REQUIRED] ${input.title}*\n${actionRequiredLine(true, "review the Paperclip decision card")}\n${cardTitle ?? "Open Paperclip to review this request."}`,
      },
    },
    {
      type: "section",
      fields,
    },
  ];
  if (prompt && prompt !== cardTitle) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Prompt: ${prompt}` }],
    });
  }
  const paperclipUrl = input.paperclipUrl?.trim();
  if (paperclipUrl) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "Open in Paperclip" },
        action_id: "open_paperclip_issue",
        url: `${paperclipUrl.replace(/\/$/, "")}/issues/${input.entityId}`,
        value: input.entityId,
      }],
    });
  }
  return blocks;
}

export function maybeNotifySlackForActivity(input: {
  db?: Db;
  companyId?: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  nowMs?: number;
}) {
  const details = input.details ?? {};
  const textForAction = (): {
    channel: string | undefined;
    channelKey?: "SLACK_APPROVALS_CHANNEL_ID" | "SLACK_ALERTS_CHANNEL_ID" | "SLACK_TICKETS_CHANNEL_ID";
    text: string;
    blocks: unknown[];
  } | null => {
    if (input.action === "issue.created") {
      return null;
    }
    if (input.action === "issue.thread_interaction_created") {
      const kind = String(details.interactionKind ?? "");
      if (kind !== "request_confirmation" && kind !== "request_checkbox_confirmation") return null;
      const title = kind === "request_checkbox_confirmation" ? "Approval options ready" : "Approval needed";
      const summary =
        payloadText(details, ["interactionTitle", "title", "prompt", "summary"])
        ?? `Issue ${compactId(input.entityId)} has a pending ${humanizeKey(kind)} card.`;
      return {
        channel: process.env.SLACK_APPROVALS_CHANNEL_ID,
        channelKey: "SLACK_APPROVALS_CHANNEL_ID",
        text: `[ACTION REQUIRED] ${title}: ${summary}`,
        blocks: buildIssueInteractionNotificationBlocks({
          title,
          summary,
          entityId: input.entityId,
          details,
          paperclipUrl: process.env.PAPERCLIP_PUBLIC_URL,
        }),
      };
    }
    if (input.action === "issue.updated" && details.status === "blocked") {
      const title = "[ACTION REQUIRED] Agent blocked";
      const summary = payloadText(details, ["title", "summary", "blocker", "reason"]) ?? `Issue ${compactId(input.entityId)} is blocked.`;
      const dedupeKey = blockedActivityDedupeKey({
        companyId: input.companyId,
        entityId: input.entityId,
        details,
        summary,
      });
      if (hasRecentBlockedActivityNotification(dedupeKey, input.nowMs ?? Date.now())) return null;
      return {
        channel: process.env.SLACK_ALERTS_CHANNEL_ID,
        channelKey: "SLACK_ALERTS_CHANNEL_ID",
        text: `${title}: ${summary}`,
        blocks: buildActivityNotificationBlocks({
          title,
          summary,
          entityType: input.entityType,
          entityId: input.entityId,
          details,
          actionRequired: actionRequiredLine(true, "clear the blocker or assign the next owner"),
          owner: "Current assignee/manager",
          nextUpdate: "When the issue leaves blocked or the blocker reason changes",
        }),
      };
    }
    if (input.action.includes("escalation") || String(details.type ?? "").includes("escalation")) {
      const title = String(details.type ?? "").includes("security") ? "[ACTION REQUIRED] Security escalation" : "[ACTION REQUIRED] Escalation requested";
      const summary = payloadText(details, ["title", "summary", "reason", "scope"]) ?? `${humanizeKey(input.entityType)} ${compactId(input.entityId)} needs attention.`;
      return {
        channel: process.env.SLACK_ALERTS_CHANNEL_ID,
        channelKey: "SLACK_ALERTS_CHANNEL_ID",
        text: `${title}: ${summary}`,
        blocks: buildActivityNotificationBlocks({
          title,
          summary,
          entityType: input.entityType,
          entityId: input.entityId,
          details,
          actionRequired: actionRequiredLine(true, "triage the escalation and choose the next owner"),
          owner: "Board/operator",
          nextUpdate: "When the escalation is accepted, reassigned, or closed",
        }),
      };
    }
    return null;
  };
  const notification = textForAction();
  if (!notification) return;
  void postSlackMessage({
    db: input.db,
    companyId: input.companyId,
    ...notification,
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
        db,
        companyId: approval.companyId,
        channel: process.env.SLACK_APPROVALS_CHANNEL_ID,
        channelKey: "SLACK_APPROVALS_CHANNEL_ID",
        text: `[ACTION REQUIRED] Paperclip approval requested: ${approval.id}`,
        blocks: buildSlackApprovalBlocks({
          approvalId: approval.id,
          type: approval.type,
          payload: approval.payload,
          paperclipUrl: process.env.PAPERCLIP_PUBLIC_URL,
        }),
      });
    },

    handleInteraction: async (interaction: SlackInteractionContext, requestHash: string) => {
      const existing = await approvals.getById(interaction.approvalId);
      if (!existing) throw unprocessable("Approval not found");
      const paperclipUserId = await mapSlackUserToPaperclipUser(interaction.userId, db, existing.companyId);
      if (!paperclipUserId) throw forbidden("Slack user is not mapped to a Paperclip board user");
      await assertAuthorizedUser(existing.companyId, paperclipUserId);
      await assertNotReplay(existing.companyId, existing.id, requestHash);
      if (!["pending", "revision_requested"].includes(existing.status)) {
        throw unprocessable("Approval is not pending");
      }

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
        text: `[FYI - no action] Paperclip approval ${result.approval.status}: ${result.approval.id}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*[FYI - no action] Paperclip approval ${result.approval.status}*\n${actionRequiredLine(false, "decision recorded in Paperclip")}\nApproval ID: \`${result.approval.id}\``,
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

async function openSlackSocketModeConnection(appToken: string): Promise<string | null> {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({}),
  }).catch((err) => {
    logger.warn({ err }, "Slack Socket Mode connection request failed");
    return null;
  });
  if (!response) return null;
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; url?: string };
  if (!response.ok || body.ok === false || !body.url) {
    logger.warn({ status: response.status, error: body.error }, "Slack Socket Mode connection request failed");
    return null;
  }
  return body.url;
}

export function startSlackSocketMode(
  db: Db,
  options: SlackSocketModeOptions = {},
): SlackSocketConnection | null {
  const slack = slackIntegrationService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const reconnectDelayMs = options.reconnectDelayMs ?? 10_000;
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    const appToken = await resolveSlackSetting(db, null, "SLACK_APP_TOKEN");
    if (!appToken) return;
    const url = await openSlackSocketModeConnection(appToken);
    if (!url || stopped) {
      scheduleReconnect();
      return;
    }

    socket = new WebSocket(url);
    socket.on("open", () => {
      logger.info("Slack Socket Mode connected");
    });
    socket.on("message", (data) => {
      let currentEnvelope: SlackSocketEnvelope | null = null;
      const sendAck = (payload?: Record<string, unknown>) => {
        const envelopeId = stringValue((currentEnvelope as SlackSocketEnvelope | null)?.envelope_id);
        if (!envelopeId || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ envelope_id: envelopeId, ...(payload ? { payload } : {}) }));
      };
      try {
        currentEnvelope = parseSlackSocketEnvelope(data.toString());
        if (currentEnvelope.type === "disconnect") {
          logger.info({ reason: stringValue(currentEnvelope.reason) }, "Slack Socket Mode requested disconnect");
          socket?.close();
          scheduleReconnect();
          return;
        }
        if (currentEnvelope.type === "hello") return;
        void handleSlackSocketEnvelope({
          envelope: currentEnvelope,
          ack: sendAck,
          service: slack,
        }).catch((err) => {
          logger.warn({ err }, "Slack Socket Mode interaction failed");
        });
      } catch (err) {
        logger.warn({ err }, "Slack Socket Mode message could not be processed");
      }
    });
    socket.on("error", (err) => {
      logger.warn({ err }, "Slack Socket Mode websocket error");
    });
    socket.on("close", () => {
      if (!stopped) scheduleReconnect();
    });
  };

  void connect();
  return {
    close() {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
}
