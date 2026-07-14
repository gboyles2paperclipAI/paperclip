import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { runTokenEnvName } from "./fixture-process-lifecycle.mjs";

function isPortListening(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, timeout: 500 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function isTcpListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => response.end("ok"));
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => response.end("ok"));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function resolveCommandPath(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const resolved = result.stdout.trim();
  return resolved === "" ? null : resolved;
}

function waitForLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child readiness"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        cleanup();
        resolve(line);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };
    stream.on("data", onData);
  });
}

function listenerKey(listener) {
  return `${listener.kind}:${listener.label}:${listener.port}`;
}

function parseReadyListeners(portFile) {
  if (!existsSync(portFile)) return [];
  const lines = readFileSync(portFile, "utf8").trim().split("\n").filter(Boolean);
  const listeners = [];
  for (const line of lines) {
    const [kind, labelOrPort, maybePort] = line.split(/\s+/, 3);
    const label = maybePort === undefined ? kind : labelOrPort;
    const port = Number(maybePort ?? labelOrPort);
    if ((kind === "http" || kind === "ssh") && Number.isSafeInteger(port)) {
      listeners.push({ kind, label, port });
    }
  }
  return listeners;
}

async function waitForExpectedListenerReadiness(portFile, expectedListeners, lifecycle, timeoutMs = 5_000) {
  const expectedKeys = new Set(expectedListeners.map(listenerKey));
  const deadline = Date.now() + timeoutMs;
  let ready = [];
  while (Date.now() < deadline) {
    const emitted = new Set(parseReadyListeners(portFile).map(listenerKey));
    ready = [];
    for (const listener of expectedListeners) {
      const emittedReady = listener.kind === "ssh" || emitted.has(listenerKey(listener));
      const probeReady = listener.kind === "ssh"
        ? await isTcpListening(listener.port)
        : await isPortListening(listener.port);
      if (emittedReady && probeReady) {
        ready.push(listener);
      }
    }
    if (
      ready.length === expectedListeners.length &&
      ready.every((listener) => expectedKeys.has(listenerKey(listener)))
    ) {
      return ready;
    }
    await lifecycle.sleep(50);
  }

  const readyKeys = ready.map(listenerKey).sort().join(", ") || "none";
  const expected = [...expectedKeys].sort().join(", ");
  throw new Error(`timed out waiting for fixture listener readiness; expected ${expected}; ready ${readyKeys}`);
}

async function startNonOwnedSentinel() {
  const env = { ...process.env };
  delete env[runTokenEnvName];
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const http=require('node:http'); const server=http.createServer((req,res)=>res.end('sentinel')); server.listen(0,'127.0.0.1',()=>console.log(server.address().port)); setInterval(()=>{},1000);",
    ],
    {
      cwd: os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const port = Number(await waitForLine(child.stdout, 2_000));
  if (!Number.isSafeInteger(port)) {
    child.kill("SIGKILL");
    throw new Error("sentinel did not report a port");
  }
  return { child, port };
}

async function stopSentinel(sentinel, lifecycle) {
  if (!sentinel?.child?.pid) return;
  sentinel.child.kill("SIGTERM");
  await lifecycle.sleep(100);
  if (lifecycle.isLiveProcess(sentinel.child.pid)) {
    sentinel.child.kill("SIGKILL");
  }
}

const fixtureChildScript = `
const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const scenario = process.argv[1];
if (scenario === "timeout" || scenario === "signal") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
const root = process.env.TMPDIR;
const childCwd = path.join(root, "owned-cwd");
mkdirSync(childCwd, { recursive: true });
const portFile = path.join(process.env.PAPERCLIP_HOME, "fixture-ports.txt");
const httpPorts = (process.env.PAPERCLIP_FIXTURE_HTTP_PORTS || "").split(",").map((value) => Number(value));
const httpListenerScript = [
  "const { appendFileSync } = require('node:fs');",
  "const http = require('node:http');",
  "const port = Number(process.env.PAPERCLIP_FIXTURE_HTTP_PORT);",
  "const label = process.env.PAPERCLIP_FIXTURE_HTTP_LABEL;",
  "const portFile = process.env.PAPERCLIP_FIXTURE_PORT_FILE;",
  "const server = http.createServer((req, res) => res.end(label));",
  "server.listen(port, '127.0.0.1', () => appendFileSync(portFile, 'http ' + label + ' ' + port + String.fromCharCode(10)));",
  "setInterval(() => {}, 1000);",
].join(" ");
const listener = spawn(process.execPath, ["-e", httpListenerScript], {
  cwd: childCwd,
  detached: true,
  env: {
    ...process.env,
    PAPERCLIP_FIXTURE_HTTP_LABEL: "one",
    PAPERCLIP_FIXTURE_HTTP_PORT: String(httpPorts[0]),
    PAPERCLIP_FIXTURE_PORT_FILE: portFile,
  },
  stdio: "ignore",
});
listener.unref();
const wrapper = spawn(process.execPath, ["-e", httpListenerScript], {
  cwd: childCwd,
  detached: true,
  env: {
    ...process.env,
    PAPERCLIP_FIXTURE_HTTP_LABEL: "two",
    PAPERCLIP_FIXTURE_HTTP_PORT: String(httpPorts[1]),
    PAPERCLIP_FIXTURE_PORT_FILE: portFile,
  },
  stdio: "ignore",
});
wrapper.unref();
setTimeout(() => {
  const late = spawn(process.execPath, ["-e", httpListenerScript], {
    cwd: childCwd,
    detached: true,
    env: {
      ...process.env,
      PAPERCLIP_FIXTURE_HTTP_LABEL: "late",
      PAPERCLIP_FIXTURE_HTTP_PORT: String(httpPorts[2]),
      PAPERCLIP_FIXTURE_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  late.unref();
}, 250);
if (process.env.PAPERCLIP_FIXTURE_WITH_SSHD === "1") {
  const keyPath = path.join(childCwd, "ssh_host_ed25519_key");
  const configPath = path.join(childCwd, "sshd_config");
  const logPath = path.join(childCwd, "sshd.log");
  const pidPath = path.join(childCwd, "sshd.pid");
  const sshPort = Number(process.env.PAPERCLIP_FIXTURE_SSH_PORT);
  const keygen = spawnSync(process.env.PAPERCLIP_FIXTURE_SSH_KEYGEN_PATH, ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], { stdio: "ignore" });
  if (keygen.status === 0 && Number.isSafeInteger(sshPort)) {
    writeFileSync(configPath, [
      "ListenAddress 127.0.0.1",
      "Port " + sshPort,
      "HostKey " + keyPath,
      "PidFile " + pidPath,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin no",
      "UsePAM no",
      "LogLevel QUIET",
      ""
    ].join(String.fromCharCode(10)));
    const sshd = spawn(process.env.PAPERCLIP_FIXTURE_SSHD_PATH, ["-D", "-f", configPath, "-E", logPath], {
      cwd: childCwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    sshd.unref();
    appendFileSync(portFile, "ssh " + sshPort + String.fromCharCode(10));
  }
}
writeFileSync(path.join(process.env.PAPERCLIP_HOME, "fixture-pids.json"), JSON.stringify([listener.pid, wrapper.pid]));
if (scenario === "failure") setTimeout(() => process.exit(7), 750);
else if (scenario === "timeout" || scenario === "signal") setInterval(() => {}, 1000);
else setTimeout(() => process.exit(0), 750);
`;

async function assertNoRunTokenProcesses(runToken, lifecycle) {
  const tokenProcesses = lifecycle.findRunTokenProcesses(runToken);
  if (tokenProcesses.length > 0) {
    throw new Error(`fixture cleanup self-test left ${tokenProcesses.length} token process${tokenProcesses.length === 1 ? "" : "es"} alive`);
  }
}

async function runFixtureCleanupScenario(context, scenario) {
  const {
    name,
    expectedStatus,
    signal = null,
    signalBeforeChildRegistration = false,
    requireFullStartupBeforeSignal = false,
    timeoutMs = null,
  } = scenario;
  const { lifecycle, runOwnedCommand } = context;
  let sentinel = null;
  let runToken = null;
  let testRoot = null;
  const listenerPorts = [];
  const expectedReadyListeners = [];
  const sshdPath = resolveCommandPath("sshd");
  const sshKeygenPath = resolveCommandPath("ssh-keygen");
  const sshdAvailable = sshdPath !== null && sshKeygenPath !== null;
  try {
    const result = await runOwnedCommand(process.execPath, ["-e", fixtureChildScript, name], {
      label: `fixture cleanup self-test ${signal ? signal.toLowerCase() : name}`,
      env: sshdAvailable ? { PAPERCLIP_FIXTURE_WITH_SSHD: "1" } : {},
      timeoutMs,
      stdio: "ignore",
      beforeStart: async ({ env, runState, testRoot: root }) => {
        runToken = runState.runToken;
        testRoot = root;
        const firstHttpPort = await allocatePort();
        const secondHttpPort = await allocatePort();
        const lateHttpPort = await allocatePort();
        listenerPorts.push(
          { kind: "http", label: "one", port: firstHttpPort },
          { kind: "http", label: "two", port: secondHttpPort },
          { kind: "http", label: "late", port: lateHttpPort },
        );
        expectedReadyListeners.push(
          { kind: "http", label: "one", port: firstHttpPort },
          { kind: "http", label: "two", port: secondHttpPort },
          { kind: "http", label: "late", port: lateHttpPort },
        );
        env.PAPERCLIP_FIXTURE_HTTP_PORTS = `${firstHttpPort},${secondHttpPort},${lateHttpPort}`;
        if (sshdAvailable) {
          const sshPort = await allocatePort();
          env.PAPERCLIP_FIXTURE_SSH_PORT = String(sshPort);
          env.PAPERCLIP_FIXTURE_SSHD_PATH = sshdPath;
          env.PAPERCLIP_FIXTURE_SSH_KEYGEN_PATH = sshKeygenPath;
          listenerPorts.push({ kind: "ssh", label: "sshd", port: sshPort });
          expectedReadyListeners.push({ kind: "ssh", label: "sshd", port: sshPort });
        }
        runState.httpPorts = [firstHttpPort, secondHttpPort, lateHttpPort];
        sentinel = await startNonOwnedSentinel();
      },
      afterSpawnBeforeOwnership: signalBeforeChildRegistration
        ? () => {
            process.kill(process.pid, signal);
          }
        : null,
      afterOwnershipReady:
        signal && requireFullStartupBeforeSignal
          ? async ({ env }) => {
              const portFile = path.join(env.PAPERCLIP_HOME, "fixture-ports.txt");
              const ready = await waitForExpectedListenerReadiness(portFile, expectedReadyListeners, lifecycle);
              const readyKeys = ready.map(listenerKey).sort().join(",");
              const expectedKeys = expectedReadyListeners.map(listenerKey).sort().join(",");
              if (readyKeys !== expectedKeys) {
                throw new Error(`fixture listener readiness mismatch: expected ${expectedKeys}; got ${readyKeys}`);
              }
              process.kill(process.pid, signal);
            }
          : null,
    });

    if (result.status !== expectedStatus) {
      throw new Error(`fixture cleanup self-test ${name} exited ${result.status}; expected ${expectedStatus}`);
    }
    await assertNoRunTokenProcesses(runToken, lifecycle);
    if (existsSync(testRoot)) {
      throw new Error(`fixture cleanup self-test ${name} left temp root behind: ${testRoot}`);
    }
    if (!(await isPortListening(sentinel.port))) {
      throw new Error(`fixture cleanup self-test ${name} killed the non-owned sentinel`);
    }
    if (listenerPorts.filter((entry) => entry.kind === "http").length < 3) {
      throw new Error(
        `fixture cleanup self-test ${name} recorded ${listenerPorts.filter((entry) => entry.kind === "http").length} HTTP listener port${listenerPorts.filter((entry) => entry.kind === "http").length === 1 ? "" : "s"}`,
      );
    }
    for (const listener of listenerPorts) {
      if (!(await canBindPort(listener.port))) {
        throw new Error(`fixture cleanup self-test ${name} left ${listener.kind} port ${listener.port} bound`);
      }
    }
  } finally {
    await stopSentinel(sentinel, lifecycle);
  }
}

function assertPidReuseRevalidationRefusesSignal(lifecycle) {
  const runState = lifecycle.createRunState(os.tmpdir(), "fake-token", "fake-pid-reuse");
  const identity = { pid: process.pid, ppid: 1, uid: process.getuid?.() ?? 0, state: "S", startTicks: "0" };
  runState.owned.set(lifecycle.identityKey(identity), identity);
  if (lifecycle.signalOwnedIdentity(runState, identity, "SIGTERM")) {
    throw new Error("PID reuse revalidation allowed a signal for mismatched start ticks");
  }
}

async function waitForLiveProcess(pid, lifecycle, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle.isLiveProcess(pid)) return true;
    await lifecycle.sleep(50);
  }
  return lifecycle.isLiveProcess(pid);
}

async function waitForProcessExit(pid, lifecycle, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!lifecycle.isLiveProcess(pid)) return true;
    await lifecycle.sleep(50);
  }
  return !lifecycle.isLiveProcess(pid);
}

async function killFixtureProcess(pid, lifecycle) {
  if (!pid || !lifecycle.isLiveProcess(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (await waitForProcessExit(pid, lifecycle, 500)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitForProcessExit(pid, lifecycle, 2_000);
}

async function assertTokenlessRootAssociationRetainsRoot(lifecycle) {
  const tempRootParent = process.env.TMPDIR || (process.platform === "win32" ? os.tmpdir() : "/tmp");
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-tokenless-${process.pid}-`));
  const childCwd = path.join(testRoot, "tokenless-cwd");
  mkdirSync(childCwd, { recursive: true });
  const env = { ...process.env };
  delete env[runTokenEnvName];
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.chdir(process.argv[1]); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
      childCwd,
    ],
    {
      cwd: childCwd,
      detached: true,
      env,
      stdio: "ignore",
    },
  );
  child.unref();
  try {
    if (!(await waitForLiveProcess(child.pid, lifecycle))) {
      throw new Error("tokenless root association child did not start");
    }
    const runState = lifecycle.createRunState(testRoot, lifecycle.generateRunToken(), "tokenless-root-retain");
    runState.runnerIdentity = { pid: 1, ppid: 0, uid: process.getuid?.() ?? 0, state: "S", startTicks: "0" };
    lifecycle.writeOwnerManifest(runState);
    lifecycle.resetSweepGuard(tempRootParent);
    const sweepResult = await lifecycle.sweepOrphanedPcvtTempDirs(tempRootParent, { force: true });
    if (sweepResult.failed < 1) {
      throw new Error("orphan sweep did not exercise the retained-root failure path");
    }
    if (!existsSync(testRoot)) {
      throw new Error("orphan sweep deleted a root with a tokenless live process association");
    }
  } finally {
    await killFixtureProcess(child.pid, lifecycle);
    rmSync(testRoot, { recursive: true, force: true });
    lifecycle.resetSweepGuard(tempRootParent);
  }
}

function runFixtureCleanupSignalSelfTest(context, signal, expectedStatus, early = false) {
  const args = [context.scriptPath, "--fixture-cleanup-signal-target", signal];
  if (early) {
    args.push("--fixture-cleanup-signal-early");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: context.repoRoot,
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `fixture cleanup self-test ${signal}${early ? " early" : ""} exited ${result.status}; expected ${expectedStatus}. ${result.stderr || result.stdout}`,
    );
  }
}

async function startTokenlessRootAssociation(testRoot, lifecycle) {
  const childCwd = path.join(testRoot, "tokenless-cwd");
  mkdirSync(childCwd, { recursive: true });
  const env = { ...process.env };
  delete env[runTokenEnvName];
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.chdir(process.argv[1]); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
      childCwd,
    ],
    {
      cwd: childCwd,
      detached: true,
      env,
      stdio: "ignore",
    },
  );
  child.unref();
  if (!(await waitForLiveProcess(child.pid, lifecycle))) {
    throw new Error("runner settlement tokenless child did not start");
  }
  return child;
}

export async function runFixtureCleanupRunnerSettlementTarget(context) {
  const { lifecycle, runOwnedCommand } = context;
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  let retainedRoot = null;
  let tokenlessChild = null;
  const startedAt = Date.now();
  try {
    let sawExpectedError = false;
    try {
      await runOwnedCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"],
        {
          label: "fixture cleanup runner settlement target",
          stdio: "ignore",
          discoverOwnedProcessesToFixedPointFn() {
            throw new Error("injected poller discovery failure");
          },
          requestOwnedRunShutdownFn(runState, _signal, status, timedOut) {
            runState.shutdownPromise = Promise.reject(new Error("injected shutdown rejection"));
            runState.shutdownPromise.catch(() => {});
            runState.forceSettle?.({ status, signal: null, timedOut });
          },
          beforeCleanup: async ({ testRoot }) => {
            retainedRoot = testRoot;
            tokenlessChild = await startTokenlessRootAssociation(testRoot, lifecycle);
          },
        },
      );
    } catch (error) {
      sawExpectedError = /injected poller discovery failure/.test(error.message);
    }

    await lifecycle.sleep(50);
    if (!sawExpectedError) {
      throw new Error("runner settlement target did not prioritize the poller error");
    }
    if (unhandled.length > 0) {
      throw new Error(`runner settlement target observed ${unhandled.length} unhandled rejection${unhandled.length === 1 ? "" : "s"}`);
    }
    if (Date.now() - startedAt > 5_000) {
      throw new Error("runner settlement target did not settle within the bounded window");
    }
    if (!retainedRoot || !existsSync(retainedRoot)) {
      throw new Error("runner settlement target did not retain the root after cleanup failure");
    }
    console.log("fixture-cleanup-runner-settlement-target ok");
    process.exitCode = 1;
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await killFixtureProcess(tokenlessChild?.pid, lifecycle);
    if (retainedRoot) {
      rmSync(retainedRoot, { recursive: true, force: true });
    }
  }
}

export async function runFixtureCleanupSignalTarget(context, signal, early) {
  const expectedStatus = signal === "SIGINT" ? 130 : 143;
  await runFixtureCleanupScenario(context, {
    name: "signal",
    expectedStatus,
    signal,
    signalBeforeChildRegistration: early,
    requireFullStartupBeforeSignal: !early,
  });
  if (context.getShutdownExitCode() !== null) {
    process.exitCode = context.getShutdownExitCode();
  }
}

export async function runFixtureCleanupSelfTest(context) {
  if (process.platform !== "linux") {
    console.log("fixture-cleanup-self-test skipped: linux-only /proc ownership check");
    return;
  }

  const lifecycleScenarios = [
    { name: "normal", expectedStatus: 0 },
    { name: "failure", expectedStatus: 7 },
    { name: "timeout", expectedStatus: 124, timeoutMs: 1_000 },
  ];
  for (let index = 0; index < 2; index += 1) {
    for (const scenario of lifecycleScenarios) {
      await runFixtureCleanupScenario(context, scenario);
    }
  }
  assertPidReuseRevalidationRefusesSignal(context.lifecycle);
  await assertTokenlessRootAssociationRetainsRoot(context.lifecycle);
  const signalScenarios = [
    { signal: "SIGINT", expectedStatus: 130 },
    { signal: "SIGTERM", expectedStatus: 143 },
  ];
  for (let index = 0; index < 2; index += 1) {
    for (const scenario of signalScenarios) {
      runFixtureCleanupSignalSelfTest(context, scenario.signal, scenario.expectedStatus);
    }
  }
  runFixtureCleanupSignalSelfTest(context, "SIGTERM", 143, true);
  console.log("fixture-cleanup-self-test ok");
}
