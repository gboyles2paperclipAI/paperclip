#!/usr/bin/env node

const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY;
const emergencyReason = process.env.PAPERCLIP_RESTART_EMERGENCY_REASON?.trim();
const emergency = process.argv.includes("--emergency") || Boolean(emergencyReason);

function headers(extra = {}) {
  const out = { Accept: "application/json", ...extra };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  return out;
}

async function readJson(response) {
  return await response.json().catch(() => ({}));
}

if (emergency && !emergencyReason) {
  console.error("Emergency restart requires PAPERCLIP_RESTART_EMERGENCY_REASON.");
  process.exit(64);
}

const response = await fetch(`${apiBase}/api/health/dev-server/restart`, {
  method: "POST",
  headers: headers({ "Content-Type": "application/json" }),
  body: JSON.stringify(
    emergency
      ? { emergency: true, emergencyReason }
      : {},
  ),
});
const payload = await readJson(response);

if (!response.ok) {
  console.error(JSON.stringify({
    status: "failed",
    httpStatus: response.status,
    error: payload.error ?? "restart_request_failed",
  }));
  process.exit(1);
}

if (payload.status === "restart_deferred") {
  console.log(JSON.stringify({
    status: "deferred",
    activeRunCount: payload.activeRunCount ?? null,
    oldestRunStartedAt: payload.oldestRunStartedAt ?? null,
    oldestRunAgeMs: payload.oldestRunAgeMs ?? null,
    nextCheckAt: payload.nextCheckAt ?? null,
  }));
  process.exit(75);
}

console.log(JSON.stringify({
  status: payload.status ?? "restart_requested",
  activeRunCount: payload.activeRunCount ?? null,
  oldestRunStartedAt: payload.oldestRunStartedAt ?? null,
  oldestRunAgeMs: payload.oldestRunAgeMs ?? null,
}));
