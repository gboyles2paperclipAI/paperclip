export { execute, ensureCodexSkillsInjected } from "./execute.js";
export * from "./acp.js";
export { getConfigSchema } from "./config-schema.js";
export {
  reconcileManagedCodexHome,
  isManagedCodexHomePath,
  evaluateCodexCredentialReadiness,
  type ReconcileManagedCodexHomeInput,
  type ReconcileManagedCodexHomeResult,
  type ReconcileManagedCodexHomeStatus,
  type CodexCredentialReadiness,
  type CodexCredentialReadinessInput,
  type CodexCredentialAuthMode,
} from "./codex-home.js";
export { listCodexSkills, syncCodexSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { parseCodexJsonl, isCodexProviderQuotaError, isCodexTransientUpstreamError, isCodexUnknownSessionError } from "./parse.js";
export {
  getQuotaWindows,
  readCodexAuthInfo,
  readCodexToken,
  fetchCodexQuota,
  fetchCodexRpcQuota,
  mapCodexRpcQuota,
  secondsToWindowLabel,
  fetchWithTimeout,
  codexHomeDir,
} from "./quota.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";

const TOKENS_PER_MILLION = 1_000_000;

type CodexModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

const CODEX_MODEL_PRICING: Record<string, CodexModelPricing> = {
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.3-codex-spark": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5-mini": { inputUsdPerMillion: 0.25, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
  "gpt-5-nano": { inputUsdPerMillion: 0.05, cachedInputUsdPerMillion: 0.005, outputUsdPerMillion: 0.4 },
};

function normalizeCodexModelForPricing(model: string | null | undefined): string {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  return normalized || "gpt-5.5";
}

export function estimateCodexCostUsd(input: {
  model: string | null | undefined;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}): number | null {
  const pricing = CODEX_MODEL_PRICING[normalizeCodexModelForPricing(input.model)];
  if (!pricing) return null;

  const inputTokens = Math.max(0, Math.floor(input.inputTokens));
  const cachedInputTokens = Math.max(0, Math.floor(input.cachedInputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(input.outputTokens));
  const total =
    (inputTokens * pricing.inputUsdPerMillion +
      cachedInputTokens * pricing.cachedInputUsdPerMillion +
      outputTokens * pricing.outputUsdPerMillion) /
    TOKENS_PER_MILLION;
  return Math.round(total * 1_000_000) / 1_000_000;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return acpxSessionCodec.deserialize(raw);
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return acpxSessionCodec.serialize(params);
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      acpxSessionCodec.getDisplayId?.(params) ??
      null
    );
  },
};
