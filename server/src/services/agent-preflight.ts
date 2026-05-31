import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { listAdapterModels } from "../adapters/index.js";

const execFile = promisify(execFileCallback);

// How many consecutive failed runs with the same errorCode before quarantine kicks in.
export const PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

// Adapters that use bwrap sandbox when dangerouslyBypassApprovalsAndSandbox is false.
const BWRAP_SANDBOX_ADAPTERS = new Set(["codex_local"]);

// Default CLI command name per adapter type, used for the PATH check.
const ADAPTER_DEFAULT_COMMANDS: Record<string, string> = {
  acpx_local: "acpx",
  claude_local: "claude",
  codex_local: "codex",
  cursor: "agent",
  gemini_local: "gemini",
  grok_local: "grok",
  opencode_local: "opencode",
  pi_local: "pi",
};

// Adapters with dynamic model lists that are worth validating before each run.
const MODEL_VALIDATABLE_ADAPTERS = new Set(["codex_local", "claude_local"]);

export interface PreflightCheck {
  code: string;
  ok: boolean;
  message: string;
  level: "info" | "warning" | "error";
}

export interface AgentPreflightResult {
  checks: PreflightCheck[];
  /** false when any check has level "error" AND ok=false */
  ok: boolean;
}

export interface AgentPreflightParams {
  db: Db;
  agentId: string;
  companyId: string;
  adapterType: string;
  /** Resolved runtime config for this run (merged adapter config). */
  config: Record<string, unknown>;
  currentRunId: string;
  /** Override the command to check; defaults to ADAPTER_DEFAULT_COMMANDS[adapterType]. */
  commandOverride?: string | null;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkCliAvailable(command: string): Promise<PreflightCheck> {
  try {
    await execFile("which", [command], { timeout: 3_000 });
    return { code: "cli_available", ok: true, message: `CLI in PATH: ${command}`, level: "info" };
  } catch {
    return {
      code: "cli_not_found",
      ok: false,
      message:
        `Required CLI not found in PATH: "${command}". ` +
        "Install it (e.g. npm install -g @openai/codex) or set a custom command path in the adapter config.",
      level: "error",
    };
  }
}

async function checkModelValid(
  adapterType: string,
  configuredModel: string,
): Promise<PreflightCheck | null> {
  if (!MODEL_VALIDATABLE_ADAPTERS.has(adapterType)) return null;
  try {
    const models = await listAdapterModels(adapterType);
    if (models.length === 0) return null;
    const valid = models.some((m) => m.id === configuredModel);
    if (valid) {
      return { code: "model_valid", ok: true, message: `Model available: ${configuredModel}`, level: "info" };
    }
    const sample = models
      .slice(0, 5)
      .map((m) => m.id)
      .join(", ");
    const suffix = models.length > 5 ? ` (${models.length - 5} more)` : "";
    return {
      code: "model_invalid",
      ok: false,
      message:
        `Configured model "${configuredModel}" is not in the available models list. ` +
        `Detected: ${sample}${suffix}. Update the adapter config to a valid model id.`,
      level: "error",
    };
  } catch {
    // Best-effort — skip if model list is unavailable.
    return null;
  }
}

function checkSandboxConfig(
  adapterType: string,
  config: Record<string, unknown>,
): PreflightCheck | null {
  if (!BWRAP_SANDBOX_ADAPTERS.has(adapterType)) return null;
  const bypass = config.dangerouslyBypassApprovalsAndSandbox;
  const legacyBypass = config.dangerouslyBypassSandbox;
  const sandboxActive = bypass === false || (bypass === undefined && legacyBypass === false);
  if (!sandboxActive) return null;
  return {
    code: "sandbox_bwrap_risk",
    ok: true,
    message:
      "dangerouslyBypassApprovalsAndSandbox is false — bwrap sandbox will be used. " +
      "If bwrap is unavailable in this environment the run will fail with a network permission error. " +
      "Consider setting dangerouslyBypassApprovalsAndSandbox: true when bwrap is not supported.",
    level: "warning",
  };
}

async function checkConsecutiveFailures(
  db: Db,
  agentId: string,
  currentRunId: string,
  threshold: number,
): Promise<PreflightCheck | null> {
  try {
    const recentRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          ne(heartbeatRuns.id, currentRunId),
          notInArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(threshold);

    if (recentRuns.length < threshold) return null;

    const allFailed = recentRuns.every((r) => r.status === "failed");
    if (!allFailed) return null;

    const firstErrorCode = recentRuns[0]?.errorCode ?? null;
    const sameErrorCode =
      firstErrorCode !== null && recentRuns.every((r) => r.errorCode === firstErrorCode);
    if (!sameErrorCode) return null;

    return {
      code: "agent_quarantined",
      ok: false,
      message:
        `Agent has failed ${threshold} consecutive runs with error code "${firstErrorCode}". ` +
        "Halting execution to prevent a run loop. " +
        "Fix the underlying issue (invalid model, missing CLI, misconfigured sandbox, etc.) " +
        "and then trigger a new run.",
      level: "error",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAgentPreflight(params: AgentPreflightParams): Promise<AgentPreflightResult> {
  const { db, agentId, adapterType, config, currentRunId, commandOverride } = params;
  const checks: PreflightCheck[] = [];

  // 1. CLI PATH check — only for adapters with a known default command.
  const configuredCommand =
    typeof config.command === "string" && config.command.trim().length > 0
      ? config.command.trim()
      : null;
  const commandToCheck =
    commandOverride?.trim() ||
    configuredCommand ||
    ADAPTER_DEFAULT_COMMANDS[adapterType] ||
    null;

  if (commandToCheck) {
    // Skip check when the command is an absolute/relative path — `which` cannot resolve those.
    const hasPathSeparator = commandToCheck.includes("/") || commandToCheck.includes("\\");
    if (!hasPathSeparator) {
      checks.push(await checkCliAvailable(commandToCheck));
    }
  }

  // 2. Model validity check — best-effort; skipped if model list is unavailable.
  const configuredModel =
    typeof config.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : null;
  if (configuredModel) {
    const modelCheck = await checkModelValid(adapterType, configuredModel);
    if (modelCheck) checks.push(modelCheck);
  }

  // 3. Sandbox/bwrap compatibility warning.
  const sandboxCheck = checkSandboxConfig(adapterType, config);
  if (sandboxCheck) checks.push(sandboxCheck);

  // 4. Consecutive failure loop detection → quarantine.
  const quarantineCheck = await checkConsecutiveFailures(
    db,
    agentId,
    currentRunId,
    PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD,
  );
  if (quarantineCheck) checks.push(quarantineCheck);

  const ok = checks.every((c) => c.ok || c.level !== "error");
  return { checks, ok };
}
