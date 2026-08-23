import type { IssueThreadInteraction, IssueThreadInteractionKind } from "@paperclipai/shared";

export const DEFAULT_INTERACTION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_APPROVAL_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_INTERACTION_TTL_SECONDS = 90 * 24 * 60 * 60;
const NOTIFICATION_TIMEOUT_MS = 5_000;

const APPROVAL_INTERACTION_KINDS = new Set<IssueThreadInteractionKind>([
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
]);

export type InteractionLifecycleConfig = {
  interactionTtlSeconds: number;
  approvalTtlSeconds: number;
  notificationWebhookUrl?: string;
};

function parseTtlSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const seconds = Math.floor(parsed);
  if (seconds === 0) return 0;
  if (seconds < 60 || seconds > MAX_INTERACTION_TTL_SECONDS) return fallback;
  return seconds;
}

function parseWebhookUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function loadInteractionLifecycleConfig(
  env: NodeJS.ProcessEnv = process.env,
): InteractionLifecycleConfig {
  return {
    interactionTtlSeconds: parseTtlSeconds(
      env.PAPERCLIP_INTERACTION_TTL_SECONDS,
      DEFAULT_INTERACTION_TTL_SECONDS,
    ),
    approvalTtlSeconds: parseTtlSeconds(
      env.PAPERCLIP_APPROVAL_TTL_SECONDS,
      DEFAULT_APPROVAL_TTL_SECONDS,
    ),
    notificationWebhookUrl: parseWebhookUrl(
      env.PAPERCLIP_INTERACTION_NOTIFICATION_WEBHOOK_URL,
    ),
  };
}

export function ttlSecondsForInteractionKind(
  kind: IssueThreadInteractionKind,
  config: InteractionLifecycleConfig,
): number {
  return APPROVAL_INTERACTION_KINDS.has(kind)
    ? config.approvalTtlSeconds
    : config.interactionTtlSeconds;
}

export function expiresAtForInteraction(
  kind: IssueThreadInteractionKind,
  createdAt: Date,
  config: InteractionLifecycleConfig,
): Date | null {
  const ttlSeconds = ttlSecondsForInteractionKind(kind, config);
  return ttlSeconds === 0 ? null : new Date(createdAt.getTime() + ttlSeconds * 1_000);
}

export type InteractionLifecycleNotificationEvent =
  | "interaction.created"
  | "interaction.expired"
  | "interaction.resolved";

export async function emitInteractionLifecycleNotification(
  event: InteractionLifecycleNotificationEvent,
  interaction: IssueThreadInteraction,
  options?: {
    config?: InteractionLifecycleConfig;
    fetchImpl?: typeof fetch;
  },
): Promise<boolean> {
  const config = options?.config ?? loadInteractionLifecycleConfig();
  if (!config.notificationWebhookUrl) return false;

  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.notificationWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        occurredAt: new Date().toISOString(),
        companyId: interaction.companyId,
        issueId: interaction.issueId,
        interactionId: interaction.id,
        kind: interaction.kind,
        status: interaction.status,
        title: interaction.title ?? null,
        summary: interaction.summary ?? null,
        expiresAt: interaction.payload.expiresAt ?? null,
        escalated: interaction.payload.escalated === true,
        originalInteractionId: interaction.payload.originalInteractionId ?? null,
      }),
      signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
