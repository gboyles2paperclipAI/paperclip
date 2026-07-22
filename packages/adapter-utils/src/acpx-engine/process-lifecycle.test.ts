import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isKnownCodexAcpCommand,
  isPaperclipOwnedCodexAcpProcess,
  readProcessGroupRssBytes,
  reapOrphanedCodexAcpProcesses,
  startCodexAcpMemoryGuard,
  terminateCodexAcpProcessGroup,
  type CodexAcpProcessMetadata,
} from "./process-lifecycle.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
});

async function spawnIsolatedGroup(): Promise<{ child: ChildProcess; metadata: CodexAcpProcessMetadata }> {
  const child = spawn("setsid", ["bash", "-c", "sleep 60 & wait"], {
    stdio: "ignore",
  });
  children.push(child);
  if (!child.pid) throw new Error("fixture process did not publish a pid");
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  const stat = await import("node:fs/promises").then((fs) => fs.readFile(`/proc/${child.pid}/stat`, "utf8"));
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return {
    child,
    metadata: {
      pid: child.pid,
      processGroupId: child.pid,
      startTimeTicks: Number.parseInt(fields[19]!, 10),
      startedAt: new Date().toISOString(),
    },
  };
}

describe.skipIf(process.platform !== "linux")("Codex ACP process lifecycle", () => {
  it("terminates the complete isolated process group", async () => {
    const { child, metadata } = await spawnIsolatedGroup();
    expect(await readProcessGroupRssBytes(metadata.processGroupId)).toBeGreaterThan(0);

    const exited = once(child, "exit");
    const result = await terminateCodexAcpProcessGroup(metadata, 250);
    await exited;

    expect(["sigterm", "sigkill"]).toContain(result);
    expect(() => process.kill(-metadata.processGroupId, 0)).toThrow();
  });

  it("fires the aggregate RSS guard and lets the caller end the group", async () => {
    const { child, metadata } = await spawnIsolatedGroup();
    const exceeded = new Promise<number>((resolve) => {
      startCodexAcpMemoryGuard({
        metadata,
        limitMb: 0.001,
        pollMs: 25,
        onExceeded: async (event) => {
          resolve(event.rssBytes);
          await terminateCodexAcpProcessGroup(metadata, 100);
        },
      });
    });

    expect(await exceeded).toBeGreaterThan(1024);
    await once(child, "exit");
  });
});

describe("Codex ACP orphan matching", () => {
  it("matches only known executable and package paths", () => {
    expect(isKnownCodexAcpCommand(["/usr/local/bin/codex-acp"])).toBe(true);
    expect(
      isKnownCodexAcpCommand([
        "node",
        "/app/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
      ]),
    ).toBe(true);
    expect(isKnownCodexAcpCommand(["node", "/app/server/dist/index.js"])).toBe(false);
    expect(isKnownCodexAcpCommand(["bash", "-c", "echo codex-acp"])).toBe(false);
    expect(isKnownCodexAcpCommand(["node", "/app/server.js", "/usr/bin/codex-acp"])).toBe(false);
  });

  it("requires Paperclip ownership markers scoped to the current instance", () => {
    const processInfo = {
      commandLine: ["node", "/app/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
      paperclipManaged: true,
      paperclipRunId: "run-1",
      paperclipAcpStateDir: "/paperclip/instances/default/companies/company-1/acp-engine/agent-1",
      instanceRoot: "/paperclip/instances/default",
    };
    expect(isPaperclipOwnedCodexAcpProcess(processInfo)).toBe(true);
    expect(isPaperclipOwnedCodexAcpProcess({ ...processInfo, paperclipManaged: false })).toBe(false);
    expect(isPaperclipOwnedCodexAcpProcess({ ...processInfo, paperclipRunId: null })).toBe(false);
    expect(
      isPaperclipOwnedCodexAcpProcess({
        ...processInfo,
        instanceRoot: "/paperclip/instances/another",
      }),
    ).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "reaps an orphan only when it carries current-instance ownership markers",
    async () => {
      const instanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-reaper-"));
      const stateDir = path.join(instanceRoot, "companies", "company-1", "acp-engine", "agent-1");
      const launcher = spawn(
        "setsid",
        [
          "-f",
          "env",
          "PAPERCLIP_ACP_MANAGED=1",
          "PAPERCLIP_RUN_ID=reaper-test-run",
          `PAPERCLIP_ACP_STATE_DIR=${stateDir}`,
          "bash",
          "-c",
          "exec -a codex-acp sleep 60",
        ],
        { stdio: "ignore" },
      );
      try {
        await once(launcher, "exit");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const result = await reapOrphanedCodexAcpProcesses(instanceRoot, 50);
        expect(result.reapedPids.length).toBeGreaterThan(0);
        for (const pid of result.reapedPids) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        await fs.rm(instanceRoot, { recursive: true, force: true });
      }
    },
  );
});
