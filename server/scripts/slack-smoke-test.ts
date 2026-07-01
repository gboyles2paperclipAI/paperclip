#!/usr/bin/env -S pnpm exec tsx
import fs from "node:fs";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { companySecrets, createDb } from "@paperclipai/db";
import { secretService } from "../src/services/secrets.js";

const INSTANCE_ROOT = process.env.PAPERCLIP_INSTANCE_ROOT ?? `${process.env.HOME ?? "."}/.paperclip/instances/default`;
const CONFIG_PATH = process.env.PAPERCLIP_CONFIG_PATH ?? `${INSTANCE_ROOT}/config.json`;
const ENV_PATH = process.env.PAPERCLIP_ENV_PATH ?? `${INSTANCE_ROOT}/.env`;

function readConnectionString(): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;
    const value =
      config?.database?.connectionString ??
      config?.db?.connectionString ??
      config?.connectionString;
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {}

  try {
    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, "").trim();
    }
  } catch {}

  return null;
}

async function resolveSecretSetting(key: string): Promise<string | null> {
  const envValue = process.env[key]?.trim();
  if (envValue) return envValue;

  const connectionString = readConnectionString();
  if (!connectionString) return null;

  const db = createDb(connectionString);
  const keys = Array.from(new Set([key, key.toLowerCase()]));
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(
      ne(companySecrets.status, "deleted"),
      or(inArray(companySecrets.key, keys), inArray(companySecrets.name, keys)),
    ))
    .orderBy(desc(companySecrets.createdAt))
    .limit(1);
  const secret = rows[0];
  if (!secret) return null;
  return secretService(db).resolveSecretValue(secret.companyId, secret.id, "latest").catch(() => null);
}

async function postChannel(label: string, channelKey: string, botToken: string) {
  const channel = await resolveSecretSetting(channelKey);
  if (!channel) {
    console.log(`${label}: skipped (missing ${channelKey})`);
    process.exitCode = 1;
    return;
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: `Paperclip Slack smoke test: ${label} channel`,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (response.ok && body.ok) {
    console.log(`${label}: ok`);
  } else {
    console.log(`${label}: failed (${body.error ?? `http_${response.status}`})`);
    process.exitCode = 1;
  }
}

async function verifySocketModeToken() {
  const appToken = await resolveSecretSetting("SLACK_APP_TOKEN");
  if (!appToken) {
    console.log("socket_mode: skipped (missing SLACK_APP_TOKEN)");
    process.exitCode = 1;
    return;
  }
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; url?: string };
  if (response.ok && body.ok && typeof body.url === "string") {
    console.log("socket_mode: ok");
  } else {
    console.log(`socket_mode: failed (${body.error ?? `http_${response.status}`})`);
    process.exitCode = 1;
  }
}

const botToken = await resolveSecretSetting("SLACK_BOT_TOKEN");
if (!botToken) {
  console.error("Missing SLACK_BOT_TOKEN");
  process.exitCode = 1;
} else {
  await postChannel("approvals", "SLACK_APPROVALS_CHANNEL_ID", botToken);
  await postChannel("alerts", "SLACK_ALERTS_CHANNEL_ID", botToken);
  await postChannel("tickets", "SLACK_TICKETS_CHANNEL_ID", botToken);
}
await verifySocketModeToken();
process.exit(process.exitCode ?? 0);
