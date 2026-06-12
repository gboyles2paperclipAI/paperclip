import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// In-process dedup: key is `${companyId}:${model}`, value is last-alert epoch ms.
const lastAlertAt = new Map<string, number>();

export interface QuotaExhaustionAlertInput {
  companyId: string;
  adapterType: string;
  model: string | null;
  retryNotBefore: string | null;
  errorMessage: string | null;
  db: Db;
}

// Visible for testing
export function parseModelFromQuotaError(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  // Match up to the period that precedes " Switch" — model names may contain dots (e.g. gpt-5.3-codex-spark).
  const match = errorMessage.match(/you(?:'|’)ve hit your usage limit for (.+?)\.\s+switch/i);
  return match?.[1]?.trim() ?? null;
}

export function formatResetWindow(retryNotBefore: string | null): string {
  if (!retryNotBefore) return "unknown";
  const d = new Date(retryNotBefore);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toUTCString();
}

export async function countAffectedCodexAgents(db: Db, companyId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(agents.adapterType, "codex_local"),
        eq(heartbeatRuns.status, "failed"),
        gt(heartbeatRuns.finishedAt, since),
        eq(sql`${heartbeatRuns.resultJson} ->> 'failureType'`, "quota_exhausted"),
      ),
    );
  return rows.length;
}

function buildDiscordPayload(input: {
  model: string;
  resetWindow: string;
  affectedAgentCount: number;
}): string {
  return JSON.stringify({
    embeds: [
      {
        title: "Quota Exhausted: codex_local",
        color: 0xff4444,
        fields: [
          { name: "Adapter Type", value: "codex_local", inline: true },
          { name: "Model", value: input.model, inline: true },
          { name: "Quota Resets", value: input.resetWindow, inline: false },
          {
            name: "Affected Agents (last 24h)",
            value: String(input.affectedAgentCount),
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

export async function fireQuotaExhaustionAlert(input: QuotaExhaustionAlertInput): Promise<void> {
  if (input.adapterType !== "codex_local") return;

  const webhookUrl = process.env.DISCORD_OPS_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const model =
    (input.model && input.model.trim().length > 0 ? input.model.trim() : null)
    ?? parseModelFromQuotaError(input.errorMessage)
    ?? "unknown";

  const dedupKey = `${input.companyId}:${model}`;
  const now = Date.now();
  if (now - (lastAlertAt.get(dedupKey) ?? 0) < ALERT_DEDUP_WINDOW_MS) return;
  lastAlertAt.set(dedupKey, now);

  const [affectedAgentCount, resetWindow] = await Promise.all([
    countAffectedCodexAgents(input.db, input.companyId).catch((err) => {
      logger.warn({ err }, "quota-exhaustion-alert: failed to count affected agents");
      return 0;
    }),
    Promise.resolve(formatResetWindow(input.retryNotBefore)),
  ]);

  const body = buildDiscordPayload({ model, resetWindow, affectedAgentCount });

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "quota-exhaustion-alert: Discord webhook returned non-OK status",
      );
    }
  } catch (err) {
    logger.warn({ err }, "quota-exhaustion-alert: failed to post alert to Discord");
  }
}
