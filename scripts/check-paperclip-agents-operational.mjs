#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_COMPANY_ID = "24c167fc-9271-4800-8834-97a660ffa3f4";
const LOCAL_ADAPTERS = new Set(["claude_local", "codex_local", "gemini_local"]);

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.PAPERCLIP_API_URL || DEFAULT_BASE_URL,
    companyId: process.env.PAPERCLIP_COMPANY_ID || DEFAULT_COMPANY_ID,
    outDir: "final/agent-operational",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (arg === "--company-id" && next) {
      args.companyId = next;
      index += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = next;
      index += 1;
    }
  }
  return args;
}

async function fetchJson(baseUrl, route) {
  const response = await fetch(new URL(route, baseUrl));
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}`);
  }
  return response.json();
}

async function pathExists(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isActiveRun(run) {
  return run?.status === "running" || run?.status === "queued";
}

function recentEnough(value, nowMs, maxAgeMs) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && nowMs - parsed <= maxAgeMs;
}

async function evaluateAgent(agent, detail, liveRuns, nowMs) {
  const adapterConfig = readObject(detail.adapterConfig ?? agent.adapterConfig);
  const runtimeConfig = readObject(detail.runtimeConfig ?? agent.runtimeConfig);
  const liveRun = liveRuns.find((run) => run.agentId === agent.id && isActiveRun(run)) ?? null;
  const cwd = typeof adapterConfig.cwd === "string" ? adapterConfig.cwd : null;
  const instructionsFilePath = typeof adapterConfig.instructionsFilePath === "string"
    ? adapterConfig.instructionsFilePath
    : null;
  const checks = [];

  checks.push({
    name: "status",
    status: agent.status === "error" || agent.status === "paused" || agent.status === "terminated" ? "fail" : "pass",
    detail: agent.status,
  });
  checks.push({
    name: "adapter_type",
    status: typeof agent.adapterType === "string" && agent.adapterType.length > 0 ? "pass" : "fail",
    detail: agent.adapterType ?? null,
  });
  checks.push({
    name: "runtime_config",
    status: Object.keys(runtimeConfig).length > 0 ? "pass" : "warn",
    detail: Object.keys(runtimeConfig).length > 0 ? "present" : "missing",
  });

  if (LOCAL_ADAPTERS.has(agent.adapterType)) {
    const cwdExists = await pathExists(cwd);
    checks.push({
      name: "cwd",
      status: cwdExists === true ? "pass" : "fail",
      detail: cwd ?? "missing",
    });
    if (instructionsFilePath) {
      const instructionsExist = await pathExists(instructionsFilePath);
      checks.push({
        name: "instructions_file",
        status: instructionsExist === true ? "pass" : "warn",
        detail: instructionsFilePath,
      });
    }
  }

  if (liveRun) {
    checks.push({
      name: "active_run_progress",
      status: recentEnough(liveRun.lastOutputAt, nowMs, 10 * 60 * 1000) || liveRun.lastOutputSeq === 0 ? "pass" : "warn",
      detail: {
        runId: liveRun.id,
        issueId: liveRun.issueId ?? null,
        lastOutputAt: liveRun.lastOutputAt ?? null,
        lastOutputSeq: liveRun.lastOutputSeq ?? null,
      },
    });
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    adapterType: agent.adapterType,
    urlKey: agent.urlKey ?? null,
    lastHeartbeatAt: agent.lastHeartbeatAt ?? null,
    liveRun: liveRun
      ? {
        id: liveRun.id,
        status: liveRun.status,
        issueId: liveRun.issueId ?? null,
        lastOutputAt: liveRun.lastOutputAt ?? null,
      }
      : null,
    result: failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass",
    checks,
  };
}

function renderText(report) {
  const lines = [
    `Paperclip Agent Operational Smoke - ${report.generatedAt}`,
    `Company: ${report.companyId}`,
    `Base URL: ${report.baseUrl}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.total} total`,
    "",
  ];
  for (const agent of report.agents) {
    lines.push(`${agent.result.toUpperCase()} ${agent.name} (${agent.adapterType}, ${agent.status})`);
    for (const check of agent.checks) {
      const detail = typeof check.detail === "string" ? check.detail : JSON.stringify(check.detail);
      lines.push(`  - ${check.status}: ${check.name}${detail ? ` - ${detail}` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const nowMs = now.getTime();
  const [dashboard, agents, liveRuns] = await Promise.all([
    fetchJson(args.baseUrl, `/api/companies/${args.companyId}/dashboard`),
    fetchJson(args.baseUrl, `/api/companies/${args.companyId}/agents`),
    fetchJson(args.baseUrl, `/api/companies/${args.companyId}/live-runs?limit=200`),
  ]);
  const details = await Promise.all(
    agents.map((agent) =>
      fetchJson(args.baseUrl, `/api/agents/${agent.id}`)
        .catch((error) => ({ id: agent.id, fetchError: error.message })),
    ),
  );
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const evaluated = [];
  for (const agent of agents) {
    evaluated.push(await evaluateAgent(agent, detailById.get(agent.id) ?? {}, liveRuns, nowMs));
  }
  evaluated.sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    total: evaluated.length,
    pass: evaluated.filter((agent) => agent.result === "pass").length,
    warn: evaluated.filter((agent) => agent.result === "warn").length,
    fail: evaluated.filter((agent) => agent.result === "fail").length,
    dashboardAgents: dashboard.agents,
    dashboardTasks: dashboard.tasks,
    pendingApprovals: dashboard.pendingApprovals,
  };
  const report = {
    generatedAt: now.toISOString(),
    baseUrl: args.baseUrl,
    companyId: args.companyId,
    summary,
    agents: evaluated,
  };

  await mkdir(args.outDir, { recursive: true });
  const stamp = isoStamp(now);
  const jsonPath = path.join(args.outDir, `paperclip-agent-operational-${stamp}.json`);
  const txtPath = path.join(args.outDir, `paperclip-agent-operational-${stamp}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(txtPath, renderText(report));

  console.log(`Summary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail, ${summary.total} total`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Text: ${txtPath}`);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
