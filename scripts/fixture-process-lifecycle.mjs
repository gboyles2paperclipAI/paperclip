import { randomBytes as defaultRandomBytes } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const runTokenEnvName = "PAPERCLIP_VITEST_RUN_ID";
export const ownerManifestName = ".paperclip-vitest-owner.json";

const defaultDeps = {
  chmodSync,
  getuid: () => process.getuid?.() ?? 0,
  kill: (pid, signal) => process.kill(pid, signal),
  now: () => Date.now(),
  onError: (message) => console.error(message),
  onLog: (message) => console.log(message),
  pid: process.pid,
  platform: process.platform,
  randomBytes: defaultRandomBytes,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
  writeFileSync,
};

export function createFixtureLifecycle(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const activeRuns = new Set();
  const sweptTempParents = new Set();

  function isLiveProcess(pid) {
    if (deps.platform === "linux") {
      const identity = readProcIdentity(pid);
      return identity !== null && identity.state !== "Z";
    }

    try {
      deps.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  function listProcessIds() {
    if (deps.platform !== "linux") return [];
    if (deps.listProcessIds) return deps.listProcessIds();

    try {
      return deps
        .readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => Number(entry))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  function parseProcStat(pid, statText) {
    const closeParenIndex = statText.lastIndexOf(") ");
    if (closeParenIndex === -1) return null;
    const fields = statText.slice(closeParenIndex + 2).trim().split(/\s+/);
    const state = fields[0];
    const ppid = Number(fields[1]);
    const startTicks = fields[19];
    if (!state || !Number.isSafeInteger(ppid) || !startTicks) return null;
    return { pid, ppid, state, startTicks };
  }

  function parseProcUid(statusText) {
    const match = /^Uid:\s+(\d+)\s+/m.exec(statusText);
    if (!match) return null;
    const uid = Number(match[1]);
    return Number.isSafeInteger(uid) ? uid : null;
  }

  function readProcIdentity(pid) {
    if (deps.platform !== "linux") return null;
    if (deps.readProcIdentity) return deps.readProcIdentity(pid);

    try {
      const stat = parseProcStat(pid, deps.readFileSync(path.join("/proc", String(pid), "stat"), "utf8"));
      if (!stat) return null;
      const uid = parseProcUid(deps.readFileSync(path.join("/proc", String(pid), "status"), "utf8"));
      if (uid === null) return null;
      return { ...stat, uid };
    } catch {
      return null;
    }
  }

  function identityKey(identity) {
    return `${identity.pid}:${identity.startTicks}`;
  }

  function sameIdentity(a, b) {
    return (
      a !== null &&
      b !== null &&
      a.pid === b.pid &&
      a.uid === b.uid &&
      a.startTicks === b.startTicks
    );
  }

  function readProcEnvironEntries(pid) {
    if (deps.readProcEnvironEntries) return deps.readProcEnvironEntries(pid);

    try {
      return deps
        .readFileSync(path.join("/proc", String(pid), "environ"))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  function hasExactRunToken(pid, runToken) {
    if (deps.hasExactRunToken) return deps.hasExactRunToken(pid, runToken);
    const entries = readProcEnvironEntries(pid);
    if (!entries) return false;
    return entries.includes(`${runTokenEnvName}=${runToken}`);
  }

  function generateRunToken() {
    return deps.randomBytes(24).toString("hex");
  }

  function assertLinuxProcReady(fail) {
    if (deps.platform !== "linux") return;

    const self = readProcIdentity(deps.pid);
    const selfEnv = readProcEnvironEntries(deps.pid);
    if (!self || !self.startTicks || !selfEnv) {
      fail("Linux /proc identity/environ reads are unavailable; refusing detached fixture cleanup.");
    }
  }

  function registerOwnedIdentity(runState, identity) {
    if (!identity || identity.pid === deps.pid || identity.state === "Z") return false;
    const key = identityKey(identity);
    if (runState.owned.has(key)) return false;
    runState.owned.set(key, identity);
    persistOwnerManifest(runState);
    return true;
  }

  function discoverOwnedProcesses(runState) {
    if (deps.platform !== "linux") return 0;

    let added = 0;
    const processes = new Map();
    for (const pid of listProcessIds()) {
      const identity = readProcIdentity(pid);
      if (identity && identity.state !== "Z") {
        processes.set(pid, identity);
      }
    }

    if (runState.runnerIdentity) {
      const currentRunner = processes.get(runState.runnerIdentity.pid) ?? null;
      if (sameIdentity(runState.runnerIdentity, currentRunner)) {
        added += registerOwnedIdentity(runState, currentRunner) ? 1 : 0;
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      const ownedParentKeys = new Set(runState.owned.keys());
      for (const identity of processes.values()) {
        if (runState.owned.has(identityKey(identity))) continue;

        const parent = processes.get(identity.ppid);
        const isOwnedDescendant = parent ? ownedParentKeys.has(identityKey(parent)) : false;
        const hasToken = hasExactRunToken(identity.pid, runState.runToken);
        if (isOwnedDescendant || hasToken) {
          changed = registerOwnedIdentity(runState, identity);
          if (changed) added += 1;
        }
      }
    }

    return added;
  }

  function discoverOwnedProcessesToFixedPoint(runState) {
    let total = 0;
    let added = 0;
    do {
      added = discoverOwnedProcesses(runState);
      total += added;
    } while (added > 0);
    return total;
  }

  function isRevalidatedOwnedForSignal(runState, originalIdentity) {
    const current = readProcIdentity(originalIdentity.pid);
    if (!sameIdentity(originalIdentity, current) || current.state === "Z") return false;
    if (!runState.owned.has(identityKey(current))) return false;
    return true;
  }

  function signalOwnedIdentity(runState, identity, signal) {
    if (!isRevalidatedOwnedForSignal(runState, identity)) return false;
    try {
      deps.kill(identity.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForOwnedProcessesToExit(runState, timeoutMs) {
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      discoverOwnedProcessesToFixedPoint(runState);
      if (getLiveOwnedIdentities(runState).length === 0) return true;
      await deps.sleep(50);
    }
    discoverOwnedProcessesToFixedPoint(runState);
    return getLiveOwnedIdentities(runState).length === 0;
  }

  function getLiveOwnedIdentities(runState) {
    const live = [];
    for (const identity of runState.owned.values()) {
      const current = readProcIdentity(identity.pid);
      if (sameIdentity(identity, current) && current.state !== "Z") {
        live.push(identity);
      }
    }
    return live;
  }

  function findRunTokenProcesses(runToken) {
    if (deps.platform !== "linux") return [];

    const identities = [];
    for (const pid of listProcessIds()) {
      if (pid === deps.pid) continue;
      const identity = readProcIdentity(pid);
      if (identity && identity.state !== "Z" && hasExactRunToken(pid, runToken)) {
        identities.push(identity);
      }
    }
    return identities;
  }

  async function terminateOwnedProcesses(runState) {
    discoverOwnedProcessesToFixedPoint(runState);
    let live = getLiveOwnedIdentities(runState);
    if (live.length === 0) return { terminated: 0, killed: 0 };

    let terminated = 0;
    for (const identity of live) {
      if (signalOwnedIdentity(runState, identity, "SIGTERM")) {
        terminated += 1;
      }
    }

    let killed = 0;
    if (!(await waitForOwnedProcessesToExit(runState, 2_000))) {
      discoverOwnedProcessesToFixedPoint(runState);
      live = getLiveOwnedIdentities(runState);
      for (const identity of live) {
        if (signalOwnedIdentity(runState, identity, "SIGKILL")) {
          killed += 1;
        }
      }
      await waitForOwnedProcessesToExit(runState, 1_000);
    }

    return { terminated, killed };
  }

  function trimDeletedProcTarget(target) {
    return target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target;
  }

  function isPathWithin(childPath, parentPath) {
    const relative = path.relative(parentPath, trimDeletedProcTarget(childPath));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  function readProcLink(pid, entryName) {
    if (deps.readProcLink) return deps.readProcLink(pid, entryName);

    try {
      return deps.readlinkSync(path.join("/proc", String(pid), entryName));
    } catch {
      return null;
    }
  }

  function readProcCmdlineEntries(pid) {
    if (deps.readProcCmdlineEntries) return deps.readProcCmdlineEntries(pid);

    try {
      return deps
        .readFileSync(path.join("/proc", String(pid), "cmdline"))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function processHasRootAssociation(pid, testRoot) {
    const cwd = readProcLink(pid, "cwd");
    if (cwd && isPathWithin(cwd, testRoot)) return true;

    for (const arg of readProcCmdlineEntries(pid)) {
      if (arg.startsWith(testRoot + path.sep) || arg === testRoot) return true;
    }

    try {
      for (const fdName of deps.readdirSync(path.join("/proc", String(pid), "fd"))) {
        const fdTarget = readProcLink(pid, path.join("fd", fdName));
        if (fdTarget && isPathWithin(fdTarget, testRoot)) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  function findUnownedLiveRootAssociations(runState) {
    if (deps.platform !== "linux") return [];

    const associated = [];
    for (const pid of listProcessIds()) {
      if (pid === deps.pid) continue;
      const identity = readProcIdentity(pid);
      if (!identity || identity.state === "Z") continue;
      if (runState.owned.has(identityKey(identity))) continue;
      if (hasExactRunToken(pid, runState.runToken)) continue;
      if (processHasRootAssociation(pid, runState.testRoot)) {
        associated.push(identity);
      }
    }
    return associated;
  }

  function captureChildIdentity(runState) {
    if (deps.platform !== "linux" || !runState.child?.pid) return false;
    const childIdentity = readProcIdentity(runState.child.pid);
    if (!childIdentity) return false;
    runState.runnerIdentity ??= childIdentity;
    return registerOwnedIdentity(runState, childIdentity);
  }

  function createRunState(testRoot, runToken, invocationId, child = null) {
    return {
      child,
      cleanupError: null,
      forceSettle: null,
      invocationId,
      manifestCreatedAt: null,
      manifestWritten: false,
      manifestPath: path.join(testRoot, ownerManifestName),
      owned: new Map(),
      runnerIdentity: null,
      runToken,
      shutdownPromise: null,
      stopRequested: false,
      stopSignal: null,
      testRoot,
    };
  }

  function serializableIdentity(identity) {
    return {
      pid: identity.pid,
      ppid: identity.ppid,
      uid: identity.uid,
      state: identity.state,
      startTicks: identity.startTicks,
    };
  }

  function writeOwnerManifest(runState) {
    if (!runState.runnerIdentity) return;
    runState.manifestCreatedAt ??= new Date(deps.now()).toISOString();
    const manifest = {
      invocationId: runState.invocationId,
      createdAt: runState.manifestCreatedAt,
      runToken: runState.runToken,
      runnerIdentity: serializableIdentity(runState.runnerIdentity),
      ownedIdentities: [...runState.owned.values()].map(serializableIdentity),
    };
    deps.writeFileSync(runState.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    deps.chmodSync(runState.manifestPath, 0o600);
    runState.manifestWritten = true;
  }

  function persistOwnerManifest(runState) {
    if (!runState.manifestWritten) return;
    writeOwnerManifest(runState);
  }

  async function waitForDirectChildExit(child, timeoutMs) {
    if (!child?.pid) return true;
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      if (!isLiveProcess(child.pid)) return true;
      await deps.sleep(50);
    }
    return !isLiveProcess(child.pid);
  }

  async function cleanupRunState(runState) {
    if (!activeRuns.has(runState)) return;

    activeRuns.delete(runState);
    let cleanupError = null;
    if (deps.platform === "linux") {
      let result = { terminated: 0, killed: 0 };
      try {
        result = await terminateOwnedProcesses(runState);
      } catch (error) {
        cleanupError = error;
      }

      let live = [];
      let tokenProcesses = [];
      let rootAssociations = [];
      try {
        live = getLiveOwnedIdentities(runState);
        tokenProcesses = findRunTokenProcesses(runState.runToken);
        rootAssociations = findUnownedLiveRootAssociations(runState);
      } catch (error) {
        cleanupError ??= error;
      }

      if (live.length > 0 || tokenProcesses.length > 0 || rootAssociations.length > 0) {
        cleanupError ??= new Error(
          `owned fixture cleanup left ${live.length} registered process${live.length === 1 ? "" : "es"}, ${tokenProcesses.length} token process${tokenProcesses.length === 1 ? "" : "es"}, and ${rootAssociations.length} unverifiable root-associated process${rootAssociations.length === 1 ? "" : "es"} alive; retaining ${runState.testRoot}`,
        );
      } else if (result.terminated > 0 || result.killed > 0) {
        deps.onLog(
          `[test:run] terminated ${result.terminated} owned fixture process${result.terminated === 1 ? "" : "es"} for ${runState.testRoot}` +
            (result.killed > 0 ? ` (${result.killed} required SIGKILL)` : ""),
        );
      }
    } else if (runState.child && runState.child.pid && isLiveProcess(runState.child.pid)) {
      try {
        runState.child.kill("SIGTERM");
        await waitForDirectChildExit(runState.child, 2_000);
        if (isLiveProcess(runState.child.pid)) {
          runState.child.kill("SIGKILL");
          await waitForDirectChildExit(runState.child, 1_000);
        }
        if (isLiveProcess(runState.child.pid)) {
          cleanupError = new Error(`direct child ${runState.child.pid} remained live; retaining ${runState.testRoot}`);
        }
      } catch (error) {
        cleanupError = error;
      }
    }

    if (cleanupError) {
      throw cleanupError;
    }

    try {
      deps.rmSync(runState.testRoot, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Failed to remove temp dir ${runState.testRoot}: ${error.message}`);
    }
  }

  async function cleanupActiveRuns() {
    for (const runState of [...activeRuns]) {
      await cleanupRunState(runState);
    }
  }

  function readOwnerManifest(testRoot) {
    try {
      const manifest = JSON.parse(deps.readFileSync(path.join(testRoot, ownerManifestName), "utf8"));
      if (
        typeof manifest?.runToken !== "string" ||
        typeof manifest?.runnerIdentity?.pid !== "number" ||
        typeof manifest?.runnerIdentity?.startTicks !== "string" ||
        typeof manifest?.runnerIdentity?.uid !== "number"
      ) {
        return null;
      }
      if (
        manifest.ownedIdentities !== undefined &&
        !Array.isArray(manifest.ownedIdentities)
      ) {
        return null;
      }
      return manifest;
    } catch {
      return null;
    }
  }

  async function sweepOrphanedPcvtTempDirs(tempRootParent, options = {}) {
    if (!options.force && sweptTempParents.has(tempRootParent)) {
      return { removed: 0, failed: 0, retainedAmbiguous: 0, skipped: true };
    }

    sweptTempParents.add(tempRootParent);
    let removed = 0;
    let failed = 0;
    let retainedAmbiguous = 0;
    const prefixPattern = /^pcvt-/;

    let entries;
    try {
      entries = deps.readdirSync(tempRootParent, { withFileTypes: true });
    } catch (error) {
      deps.onError(`[test:run] Failed to scan temp dir ${tempRootParent}: ${error.message}`);
      return { removed, failed, retainedAmbiguous, skipped: false };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (!prefixPattern.test(entry.name)) continue;
      const testRoot = path.join(tempRootParent, entry.name);
      const manifest = readOwnerManifest(testRoot);
      if (!manifest) {
        retainedAmbiguous += 1;
        continue;
      }

      const currentRunner = readProcIdentity(manifest.runnerIdentity.pid);
      if (sameIdentity(manifest.runnerIdentity, currentRunner)) continue;

      const runState = createRunState(testRoot, manifest.runToken, manifest.invocationId ?? "orphan-sweep");
      runState.manifestCreatedAt = manifest.createdAt ?? null;
      runState.runnerIdentity = manifest.runnerIdentity;
      for (const identity of manifest.ownedIdentities ?? []) {
        if (
          typeof identity?.pid === "number" &&
          typeof identity?.ppid === "number" &&
          typeof identity?.uid === "number" &&
          typeof identity?.startTicks === "string" &&
          typeof identity?.state === "string"
        ) {
          runState.owned.set(identityKey(identity), identity);
        }
      }

      try {
        activeRuns.add(runState);
        await cleanupRunState(runState);
        removed += 1;
      } catch {
        activeRuns.delete(runState);
        failed += 1;
      }
    }

    if (removed > 0 || failed > 0 || retainedAmbiguous > 0) {
      deps.onLog(
        `[test:run] swept ${removed} orphaned pcvt temp dirs from ${tempRootParent}` +
          (failed > 0 ? ` (${failed} failed)` : "") +
          (retainedAmbiguous > 0 ? ` (${retainedAmbiguous} ambiguous retained)` : ""),
      );
    }

    return { removed, failed, retainedAmbiguous, skipped: false };
  }

  function resetSweepGuard(tempRootParent = null) {
    if (tempRootParent === null) {
      sweptTempParents.clear();
      return;
    }
    sweptTempParents.delete(tempRootParent);
  }

  function requestOwnedRunShutdown(runState, signal, status, timedOut = false) {
    if (!runState.child) return;
    if (runState.stopRequested) return;
    runState.stopRequested = true;
    runState.stopSignal = signal;
    runState.shutdownPromise = (async () => {
      let cleanupError = null;
      try {
        if (deps.platform === "linux") {
          captureChildIdentity(runState);
          await terminateOwnedProcesses(runState);
        } else if (runState.child && !runState.child.killed) {
          runState.child.kill(signal);
          await waitForDirectChildExit(runState.child, 2_000);
          if (runState.child.pid && isLiveProcess(runState.child.pid)) {
            runState.child.kill("SIGKILL");
            await waitForDirectChildExit(runState.child, 1_000);
          }
        }
      } catch (error) {
        cleanupError = error;
        runState.cleanupError = error;
      } finally {
        runState.forceSettle?.({ status, signal: null, timedOut });
      }
      if (cleanupError) {
        throw cleanupError;
      }
    })();
    runState.shutdownPromise.catch(() => {});
  }

  return {
    activeRuns,
    assertLinuxProcReady,
    captureChildIdentity,
    cleanupActiveRuns,
    cleanupRunState,
    createRunState,
    discoverOwnedProcessesToFixedPoint,
    findRunTokenProcesses,
    generateRunToken,
    getLiveOwnedIdentities,
    identityKey,
    isLiveProcess,
    readProcIdentity,
    requestOwnedRunShutdown,
    resetSweepGuard,
    sameIdentity,
    signalOwnedIdentity,
    sleep: deps.sleep,
    sweepOrphanedPcvtTempDirs,
    terminateOwnedProcesses,
    writeOwnerManifest,
  };
}
