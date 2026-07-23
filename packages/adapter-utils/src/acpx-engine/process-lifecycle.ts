import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CODEX_ACP_MEMORY_LIMIT_MB = 4096;
export const DEFAULT_CODEX_ACP_MEMORY_POLL_MS = 2000;
export const DEFAULT_CODEX_ACP_TERMINATION_GRACE_MS = 5000;

export interface CodexAcpProcessMetadata {
  pid: number;
  processGroupId: number;
  startTimeTicks: number;
  startedAt: string;
}

export interface CodexAcpMemoryLimitEvent extends CodexAcpProcessMetadata {
  rssBytes: number;
  limitBytes: number;
}

interface ProcIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startTimeTicks: number;
  state: string;
  commandLine: string[];
  paperclipManaged: boolean;
  paperclipRunId: string | null;
  paperclipAcpStateDir: string | null;
}

export function safeRunProcessFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return safe || "run";
}

export function codexAcpProcessMetadataPath(stateDir: string, runId: string): string {
  return path.join(stateDir, "run-processes", `${safeRunProcessFileName(runId)}.json`);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export async function readCodexAcpProcessMetadata(
  metadataPath: string,
): Promise<CodexAcpProcessMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
    if (
      !isPositiveInteger(parsed.pid) ||
      !isPositiveInteger(parsed.processGroupId) ||
      !isPositiveInteger(parsed.startTimeTicks)
    ) return null;
    if (typeof parsed.startedAt !== "string" || !parsed.startedAt) return null;
    return {
      pid: parsed.pid,
      processGroupId: parsed.processGroupId,
      startTimeTicks: parsed.startTimeTicks,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export async function waitForCodexAcpProcessMetadata(
  metadataPath: string,
  timeoutMs = 750,
): Promise<CodexAcpProcessMetadata | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const metadata = await readCodexAcpProcessMetadata(metadataPath);
    if (metadata) return metadata;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (true);
}

async function readProcIdentity(pid: number): Promise<ProcIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const parentPid = Number.parseInt(fields[1] ?? "", 10);
    const processGroupId = Number.parseInt(fields[2] ?? "", 10);
    const startTimeTicks = Number.parseInt(fields[19] ?? "", 10);
    if (!isPositiveInteger(parentPid) && parentPid !== 0) return null;
    if (!isPositiveInteger(processGroupId)) return null;
    if (!isPositiveInteger(startTimeTicks)) return null;
    const commandLineRaw = await fs.readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0));
    const commandLine = commandLineRaw
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const environmentRaw = await fs.readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0));
    const environment = environmentRaw.toString("utf8").split("\0").filter(Boolean);
    const environmentValue = (key: string) =>
      environment.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
    return {
      pid,
      parentPid,
      processGroupId,
      startTimeTicks,
      state: fields[0] ?? "",
      commandLine,
      paperclipManaged: environmentValue("PAPERCLIP_ACP_MANAGED") === "1",
      paperclipRunId: environmentValue("PAPERCLIP_RUN_ID"),
      paperclipAcpStateDir: environmentValue("PAPERCLIP_ACP_STATE_DIR"),
    };
  } catch {
    return null;
  }
}

async function listProcIdentities(): Promise<ProcIdentity[]> {
  if (process.platform !== "linux") return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10));
  const identities = await Promise.all(pids.map((pid) => readProcIdentity(pid)));
  return identities.filter((identity): identity is ProcIdentity => identity !== null);
}

export async function readProcessGroupRssBytes(processGroupId: number): Promise<number> {
  if (process.platform !== "linux" || !isPositiveInteger(processGroupId)) return 0;
  const identities = await listProcIdentities();
  const members = identities.filter(
    (identity) => identity.processGroupId === processGroupId && identity.state !== "Z",
  );
  const rssValues = await Promise.all(
    members.map(async ({ pid }) => {
      try {
        const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
        return match ? Number.parseInt(match[1]!, 10) * 1024 : 0;
      } catch {
        return 0;
      }
    }),
  );
  return rssValues.reduce((total, value) => total + value, 0);
}

function processGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32" || !isPositiveInteger(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupAlive(processGroupId) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !processGroupAlive(processGroupId);
}

export async function terminateCodexAcpProcessGroup(
  metadata: CodexAcpProcessMetadata,
  graceMs = DEFAULT_CODEX_ACP_TERMINATION_GRACE_MS,
): Promise<"already_exited" | "sigterm" | "sigkill"> {
  if (process.platform === "win32" || !processGroupAlive(metadata.processGroupId)) {
    return "already_exited";
  }
  // The wrapper creates a fresh session with setsid, so its PID must own the
  // group. Refuse a broad signal if stale or forged metadata names a group the
  // recorded process did not create.
  if (metadata.pid !== metadata.processGroupId) return "already_exited";
  const current = await readProcIdentity(metadata.pid);
  if (
    !current ||
    current.processGroupId !== metadata.processGroupId ||
    current.startTimeTicks !== metadata.startTimeTicks
  ) return "already_exited";
  try {
    process.kill(-metadata.processGroupId, "SIGTERM");
  } catch {
    return "already_exited";
  }
  if (await waitForProcessGroupExit(metadata.processGroupId, graceMs)) return "sigterm";
  try {
    process.kill(-metadata.processGroupId, "SIGKILL");
  } catch {
    return "sigterm";
  }
  await waitForProcessGroupExit(metadata.processGroupId, 1000);
  return "sigkill";
}

export function startCodexAcpMemoryGuard(input: {
  metadata: CodexAcpProcessMetadata;
  limitMb: number;
  pollMs?: number;
  onExceeded: (event: CodexAcpMemoryLimitEvent) => void | Promise<void>;
}): { stop: () => void } {
  const limitBytes = Math.max(0, input.limitMb) * 1024 * 1024;
  if (limitBytes === 0 || process.platform !== "linux") return { stop: () => {} };
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const rssBytes = await readProcessGroupRssBytes(input.metadata.processGroupId);
      if (!stopped && rssBytes > limitBytes) {
        stopped = true;
        clearInterval(timer);
        await input.onExceeded({ ...input.metadata, rssBytes, limitBytes });
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(
    () => void check().catch(() => {}),
    Math.max(100, input.pollMs ?? DEFAULT_CODEX_ACP_MEMORY_POLL_MS),
  );
  timer.unref?.();
  void check().catch(() => {});
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function isKnownCodexAcpCommand(commandLine: string[]): boolean {
  return commandLine.slice(0, 2).some((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return (
      path.basename(normalized) === "codex-acp" ||
      normalized.includes("/@agentclientprotocol/codex-acp/") ||
      normalized.includes("/@agentclientprotocol+codex-acp@") ||
      normalized.includes("/codex-acp/dist/index.js")
    );
  });
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isPaperclipOwnedCodexAcpProcess(input: {
  commandLine: string[];
  paperclipManaged: boolean;
  paperclipRunId: string | null;
  paperclipAcpStateDir: string | null;
  instanceRoot: string;
}): boolean {
  return Boolean(
    input.paperclipManaged &&
    input.paperclipRunId &&
    input.paperclipAcpStateDir &&
    pathIsWithin(input.instanceRoot, input.paperclipAcpStateDir) &&
    isKnownCodexAcpCommand(input.commandLine),
  );
}

async function signalPidIfUnchanged(identity: ProcIdentity, signal: NodeJS.Signals): Promise<boolean> {
  const current = await readProcIdentity(identity.pid);
  if (!current || current.startTimeTicks !== identity.startTimeTicks) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    // The process may have exited between the /proc snapshot and the signal.
    return false;
  }
}

export interface CodexAcpOrphanReapResult {
  scanned: number;
  reapedPids: number[];
}

export async function reapOrphanedCodexAcpProcesses(
  instanceRoot: string,
  graceMs = DEFAULT_CODEX_ACP_TERMINATION_GRACE_MS,
): Promise<CodexAcpOrphanReapResult> {
  const identities = await listProcIdentities();
  const orphans = identities.filter(
    (identity) =>
      identity.parentPid === 1 &&
      identity.state !== "Z" &&
      isPaperclipOwnedCodexAcpProcess({ ...identity, instanceRoot }),
  );
  const reaped = new Set<number>();
  const handledRuns = new Set<string>();
  for (const orphan of orphans) {
    const runKey = `${orphan.paperclipAcpStateDir}\0${orphan.paperclipRunId}`;
    if (handledRuns.has(runKey)) continue;
    handledRuns.add(runKey);
    const belongsToRun = (identity: ProcIdentity) =>
      identity.paperclipManaged &&
      identity.paperclipRunId === orphan.paperclipRunId &&
      identity.paperclipAcpStateDir === orphan.paperclipAcpStateDir;
    const initialTargets = identities.filter(belongsToRun);
    const currentOrphan = await readProcIdentity(orphan.pid);
    if (
      currentOrphan &&
      currentOrphan.startTimeTicks === orphan.startTimeTicks &&
      orphan.processGroupId === orphan.pid
    ) {
      try {
        process.kill(-orphan.processGroupId, "SIGTERM");
        for (const identity of initialTargets) reaped.add(identity.pid);
      } catch {
        for (const identity of initialTargets) {
          if (await signalPidIfUnchanged(identity, "SIGTERM")) reaped.add(identity.pid);
        }
      }
    } else {
      for (const identity of initialTargets) {
        if (await signalPidIfUnchanged(identity, "SIGTERM")) reaped.add(identity.pid);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, graceMs)));
    // Rescan by the inherited ownership markers so descendants created after
    // the first snapshot are included and stale/reused PIDs are never used.
    for (let pass = 0; pass < 2; pass += 1) {
      const liveTargets = (await listProcIdentities()).filter(
        (identity) => identity.state !== "Z" && belongsToRun(identity),
      );
      for (const identity of liveTargets) {
        if (await signalPidIfUnchanged(identity, "SIGKILL")) reaped.add(identity.pid);
      }
      if (pass === 0 && liveTargets.length > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  return { scanned: identities.length, reapedPids: [...reaped].sort((a, b) => a - b) };
}
