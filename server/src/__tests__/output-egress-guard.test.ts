import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { guardTextForPersistence, guardValueForPersistence } from "../services/output-egress-guard.js";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";
import { createLocalFileWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";

function syntheticEnvDump() {
  return [
    "PATH=/usr/bin",
    "HOME=/home/example",
    "SHELL=/bin/bash",
    "LANG=C.UTF-8",
    "TERM=xterm",
    "CI=true",
    "PAPERCLIP_API_KEY=synthetic-paperclip-key",
    "DATABASE_URL=postgres://user:pass@example.invalid/db",
    "AUTH_TOKEN=synthetic-auth-token",
  ].join("\n");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-output-egress-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("output egress guard", () => {
  it("redacts credential-shaped free text before persistence", () => {
    const result = guardTextForPersistence("Authorization: Bearer synthetic-bearer-token", {
      surface: "run_log",
    });

    expect(result.action).toBe("allow");
    expect(result.reason).toBe("redacted");
    expect(result.content).toContain("***REDACTED***");
    expect(result.content).not.toContain("synthetic-bearer-token");
  });

  it("quarantines synthetic environment dumps into count-only summaries", () => {
    const result = guardTextForPersistence(syntheticEnvDump(), { surface: "issue_comment" });

    expect(result.action).toBe("quarantine");
    expect(result.reason).toBe("env_dump");
    expect(result.content).toContain("action=quarantined");
    expect(result.content).toContain("assignmentLines=9");
    expect(result.content).toContain("sensitiveKeyLines=3");
    expect(result.content).not.toContain("synthetic-paperclip-key");
    expect(result.content).not.toContain("postgres://");
  });

  it("leaves ordinary output unchanged", () => {
    const input = "Typecheck passed in 42 files\n";
    const result = guardTextForPersistence(input, { surface: "workspace_operation_log" });

    expect(result.action).toBe("allow");
    expect(result.reason).toBeNull();
    expect(result.content).toBe(input);
  });

  it("sanitizes nested tool-result style payload values", () => {
    const result = guardValueForPersistence({
      tool: "direct_exec",
      output: syntheticEnvDump(),
      metadata: {
        Authorization: "Bearer synthetic-bearer-token",
      },
    }, { surface: "work_product" }) as Record<string, unknown>;

    expect(result.output).toContain("reason=env_dump");
    expect(String(result.output)).not.toContain("synthetic-paperclip-key");
    expect(result.metadata).toEqual({ Authorization: "***REDACTED***" });
  });

  it("guards heartbeat run-log appends before file persistence", async () => {
    await withTempDir(async (dir) => {
      const store = createLocalFileRunLogStore(dir);
      const handle = await store.begin({ companyId: "company-1", agentId: "agent-1", runId: "run-1" });

      await store.append(handle, {
        stream: "stdout",
        chunk: syntheticEnvDump(),
        ts: "2026-08-29T00:00:00.000Z",
        seq: 1,
      });

      const read = await store.read(handle);
      expect(read.content).toContain("reason=env_dump");
      expect(read.content).not.toContain("synthetic-paperclip-key");
    });
  });

  it("guards workspace operation log appends before file persistence", async () => {
    await withTempDir(async (dir) => {
      const store = createLocalFileWorkspaceOperationLogStore(dir);
      const handle = await store.begin({ companyId: "company-1", operationId: "operation-1" });

      await store.append(handle, {
        stream: "stderr",
        chunk: "Environment=DATABASE_URL=postgres://user:pass@example.invalid/db",
        ts: "2026-08-29T00:00:00.000Z",
      });

      const read = await store.read(handle);
      expect(read.content).toContain("reason=process_dump");
      expect(read.content).not.toContain("postgres://");
    });
  });
});
