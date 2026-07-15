import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isPidAlive, terminateLocalService } from "../services/local-service-supervisor.ts";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

async function waitForChildPid(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for detached child pid")), 5_000);
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      const firstLine = output.split("\n")[0]?.trim() ?? "";
      const pid = Number.parseInt(firstLine, 10);
      if (!Number.isInteger(pid) || pid <= 0) return;
      clearTimeout(timeout);
      resolve(pid);
    });
  });
}

async function waitForPidExit(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after termination`);
}

function forceCleanup(pid: number | null | undefined, processGroup = false) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(processGroup ? -pid : pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for an already-exited synthetic process.
  }
}

describeLinux("terminateLocalService", () => {
  it("terminates detached descendants outside the root process group", async () => {
    const rootScript = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      "console.log(child.pid);",
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const root = spawn(process.execPath, ["-e", rootScript], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rootPid = root.pid;
    expect(rootPid).toBeTypeOf("number");
    const childPid = await waitForChildPid(root);

    try {
      expect(isPidAlive(rootPid)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      await terminateLocalService(
        { pid: rootPid!, processGroupId: rootPid! },
        { forceAfterMs: 100 },
      );

      await Promise.all([waitForPidExit(rootPid!), waitForPidExit(childPid)]);
    } finally {
      forceCleanup(childPid);
      forceCleanup(rootPid, true);
    }
  });
});
