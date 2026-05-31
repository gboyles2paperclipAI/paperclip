import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import {
  runAgentPreflight,
  PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD,
} from "../services/agent-preflight.js";
import * as registryModule from "../adapters/index.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  listAdapterModels: vi.fn(),
}));

// Minimal in-memory db stub
function makeDb(runs: Array<{ id: string; status: string; errorCode: string | null; createdAt: Date }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => Promise.resolve(runs.slice(0, n)),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof runAgentPreflight>[0]["db"];
}

const AGENT_ID = "agent-001";
const COMPANY_ID = "company-001";
const RUN_ID = "run-current";

function makeParams(overrides?: Partial<Parameters<typeof runAgentPreflight>[0]>) {
  return {
    db: makeDb([]),
    agentId: AGENT_ID,
    companyId: COMPANY_ID,
    adapterType: "claude_local",
    config: {},
    currentRunId: RUN_ID,
    ...overrides,
  };
}

// Make child_process.execFile behave like promisify would
function mockExecFileSuccess() {
  vi.mocked(childProcess.execFile).mockImplementation(
    (_cmd, _args, _opts, cb: (...args: unknown[]) => void) => {
      cb(null, "", "");
      return {} as never;
    },
  );
}

function mockExecFileFailure() {
  vi.mocked(childProcess.execFile).mockImplementation(
    (_cmd, _args, _opts, cb: (...args: unknown[]) => void) => {
      cb(new Error("not found"), "", "");
      return {} as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(registryModule.listAdapterModels).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// CLI availability checks
// ---------------------------------------------------------------------------

describe("CLI availability", () => {
  it("emits cli_available when command is found", async () => {
    mockExecFileSuccess();
    const result = await runAgentPreflight(
      makeParams({ adapterType: "claude_local", config: {} }),
    );
    const check = result.checks.find((c) => c.code === "cli_available");
    expect(check).toBeDefined();
    expect(check?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("emits cli_not_found when command is missing", async () => {
    mockExecFileFailure();
    const result = await runAgentPreflight(
      makeParams({ adapterType: "claude_local", config: {} }),
    );
    const check = result.checks.find((c) => c.code === "cli_not_found");
    expect(check).toBeDefined();
    expect(check?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("skips CLI check for adapter types with no known default command", async () => {
    const result = await runAgentPreflight(
      makeParams({ adapterType: "openclaw_gateway", config: {} }),
    );
    expect(result.checks.find((c) => c.code === "cli_not_found")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "cli_available")).toBeUndefined();
  });

  it("uses commandOverride instead of default when provided", async () => {
    mockExecFileSuccess();
    const execFileMock = vi.mocked(childProcess.execFile);
    await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: {}, commandOverride: "my-codex" }),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "which",
      ["my-codex"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("skips CLI check when command contains a path separator", async () => {
    const result = await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: { command: "/usr/local/bin/codex" } }),
    );
    expect(result.checks.find((c) => c.code === "cli_not_found")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "cli_available")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Model validity checks
// ---------------------------------------------------------------------------

describe("model validity", () => {
  beforeEach(() => {
    mockExecFileSuccess();
  });

  it("emits model_valid when configured model is in the list", async () => {
    vi.mocked(registryModule.listAdapterModels).mockResolvedValue([
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    ]);
    const result = await runAgentPreflight(
      makeParams({ adapterType: "claude_local", config: { model: "claude-sonnet-4-6" } }),
    );
    const check = result.checks.find((c) => c.code === "model_valid");
    expect(check?.ok).toBe(true);
  });

  it("emits model_invalid when configured model is not in the list", async () => {
    vi.mocked(registryModule.listAdapterModels).mockResolvedValue([
      { id: "gpt-5.4", label: "gpt-5.4" },
      { id: "gpt-5.5", label: "gpt-5.5" },
    ]);
    const result = await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: { model: "gpt-5.3-codex" } }),
    );
    const check = result.checks.find((c) => c.code === "model_invalid");
    expect(check).toBeDefined();
    expect(check?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(check?.message).toContain("gpt-5.3-codex");
    expect(check?.message).toContain("gpt-5.4");
  });

  it("skips model check when no model is configured", async () => {
    const result = await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: {} }),
    );
    expect(result.checks.find((c) => c.code === "model_valid")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "model_invalid")).toBeUndefined();
  });

  it("skips model check for adapters not in MODEL_VALIDATABLE_ADAPTERS", async () => {
    const result = await runAgentPreflight(
      makeParams({ adapterType: "cursor", config: { model: "some-model" } }),
    );
    expect(result.checks.find((c) => c.code === "model_valid")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "model_invalid")).toBeUndefined();
  });

  it("skips model check gracefully when listAdapterModels throws", async () => {
    vi.mocked(registryModule.listAdapterModels).mockRejectedValue(new Error("network error"));
    const result = await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: { model: "gpt-5.5" } }),
    );
    expect(result.checks.find((c) => c.code === "model_valid")).toBeUndefined();
    expect(result.checks.find((c) => c.code === "model_invalid")).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("skips model check gracefully when model list is empty", async () => {
    vi.mocked(registryModule.listAdapterModels).mockResolvedValue([]);
    const result = await runAgentPreflight(
      makeParams({ adapterType: "codex_local", config: { model: "gpt-5.5" } }),
    );
    expect(result.checks.find((c) => c.code === "model_invalid")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sandbox / bwrap checks
// ---------------------------------------------------------------------------

describe("sandbox compatibility", () => {
  beforeEach(() => {
    mockExecFileSuccess();
  });

  it("emits sandbox_bwrap_risk warning when sandbox is active for codex_local", async () => {
    const result = await runAgentPreflight(
      makeParams({
        adapterType: "codex_local",
        config: { dangerouslyBypassApprovalsAndSandbox: false },
      }),
    );
    const check = result.checks.find((c) => c.code === "sandbox_bwrap_risk");
    expect(check).toBeDefined();
    expect(check?.level).toBe("warning");
    // Warning does not fail the preflight
    expect(check?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("does not emit sandbox warning when bypass is true", async () => {
    const result = await runAgentPreflight(
      makeParams({
        adapterType: "codex_local",
        config: { dangerouslyBypassApprovalsAndSandbox: true },
      }),
    );
    expect(result.checks.find((c) => c.code === "sandbox_bwrap_risk")).toBeUndefined();
  });

  it("does not emit sandbox warning for non-bwrap adapters", async () => {
    const result = await runAgentPreflight(
      makeParams({
        adapterType: "claude_local",
        config: { dangerouslyBypassApprovalsAndSandbox: false },
      }),
    );
    expect(result.checks.find((c) => c.code === "sandbox_bwrap_risk")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Consecutive failure / quarantine checks
// ---------------------------------------------------------------------------

describe("consecutive failure quarantine", () => {
  beforeEach(() => {
    mockExecFileSuccess();
  });

  function makeFailed(n: number, errorCode = "adapter_failed") {
    return Array.from({ length: n }, (_, i) => ({
      id: `run-${i}`,
      status: "failed",
      errorCode,
      createdAt: new Date(Date.now() - i * 1000),
    }));
  }

  it("quarantines when last N runs all failed with same errorCode", async () => {
    const db = makeDb(makeFailed(PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD));
    const result = await runAgentPreflight(makeParams({ db }));
    const check = result.checks.find((c) => c.code === "agent_quarantined");
    expect(check).toBeDefined();
    expect(check?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("does not quarantine when fewer than threshold previous runs", async () => {
    const db = makeDb(makeFailed(PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD - 1));
    const result = await runAgentPreflight(makeParams({ db }));
    expect(result.checks.find((c) => c.code === "agent_quarantined")).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("does not quarantine when recent runs have different errorCodes", async () => {
    const db = makeDb([
      { id: "r1", status: "failed", errorCode: "adapter_failed", createdAt: new Date() },
      { id: "r2", status: "failed", errorCode: "process_lost", createdAt: new Date(Date.now() - 1000) },
      { id: "r3", status: "failed", errorCode: "adapter_failed", createdAt: new Date(Date.now() - 2000) },
    ]);
    const result = await runAgentPreflight(makeParams({ db }));
    expect(result.checks.find((c) => c.code === "agent_quarantined")).toBeUndefined();
  });

  it("does not quarantine when a recent run succeeded", async () => {
    const db = makeDb([
      { id: "r1", status: "succeeded", errorCode: null, createdAt: new Date() },
      { id: "r2", status: "failed", errorCode: "adapter_failed", createdAt: new Date(Date.now() - 1000) },
      { id: "r3", status: "failed", errorCode: "adapter_failed", createdAt: new Date(Date.now() - 2000) },
    ]);
    const result = await runAgentPreflight(makeParams({ db }));
    expect(result.checks.find((c) => c.code === "agent_quarantined")).toBeUndefined();
  });

  it("does not quarantine when all recent runs failed but errorCode is null", async () => {
    const db = makeDb(
      makeFailed(PREFLIGHT_CONSECUTIVE_FAILURE_THRESHOLD).map((r) => ({ ...r, errorCode: null })),
    );
    const result = await runAgentPreflight(makeParams({ db }));
    expect(result.checks.find((c) => c.code === "agent_quarantined")).toBeUndefined();
  });

  it("recovers gracefully when DB query throws", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.reject(new Error("db unavailable")),
            }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof runAgentPreflight>[0]["db"];

    const result = await runAgentPreflight(makeParams({ db }));
    expect(result.checks.find((c) => c.code === "agent_quarantined")).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ok flag
// ---------------------------------------------------------------------------

describe("overall ok flag", () => {
  it("is true when all checks pass", async () => {
    mockExecFileSuccess();
    vi.mocked(registryModule.listAdapterModels).mockResolvedValue([
      { id: "claude-sonnet-4-6", label: "Sonnet" },
    ]);
    const result = await runAgentPreflight(
      makeParams({ adapterType: "claude_local", config: { model: "claude-sonnet-4-6" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("is false when any error-level check fails", async () => {
    mockExecFileFailure(); // CLI missing → error
    const result = await runAgentPreflight(makeParams());
    expect(result.ok).toBe(false);
  });

  it("is true when only warning-level checks fire", async () => {
    mockExecFileSuccess();
    const result = await runAgentPreflight(
      makeParams({
        adapterType: "codex_local",
        config: { dangerouslyBypassApprovalsAndSandbox: false },
      }),
    );
    // sandbox_bwrap_risk is warning, not error
    const check = result.checks.find((c) => c.code === "sandbox_bwrap_risk");
    expect(check?.level).toBe("warning");
    expect(result.ok).toBe(true);
  });
});
