#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import {
  runFixtureCleanupRunnerSettlementTarget,
  runFixtureCleanupSelfTest,
  runFixtureCleanupSignalTarget,
} from "./fixture-cleanup-self-test.mjs";
import { createFixtureLifecycle, runTokenEnvName } from "./fixture-process-lifecycle.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { selectVitestTempRootParent } from "./vitest-stable-temp.mjs";

const repoRoot = process.cwd();
const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/decision-freeze-guards.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/replay-decision-revision-roundtrip.test.ts",
  "server/src/__tests__/replay-ful20229-approval-race.test.ts",
  "server/src/__tests__/replay-ful20244-stale-blocker.test.ts",
  "server/src/__tests__/routine-tracking-modes.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
const continueOnFailure =
  process.env.PAPERCLIP_VITEST_CONTINUE_ON_FAILURE === "1" ||
  process.env.PAPERCLIP_VITEST_CONTINUE_ON_FAILURE === "true";
const failures = [];
let shutdownExitCode = null;
let shutdownRequested = false;
let shutdownSignal = null;

const lifecycle = createFixtureLifecycle();
const {
  activeRuns,
  assertLinuxProcReady,
  captureChildIdentity,
  cleanupActiveRuns,
  cleanupRunState,
  createRunState,
  discoverOwnedProcessesToFixedPoint,
  generateRunToken,
  requestOwnedRunShutdown,
  sweepOrphanedPcvtTempDirs,
  writeOwnerManifest,
} = lifecycle;

function shutdownStatusForSignal(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function requestShutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownExitCode = shutdownStatusForSignal(signal);
  shutdownSignal = signal;
  for (const runState of activeRuns) {
    requestOwnedRunShutdown(runState, signal, shutdownExitCode, false);
  }
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;
  let fixtureCleanupSelfTest = false;
  let fixtureCleanupSignalTarget = null;
  let fixtureCleanupSignalEarly = false;
  let fixtureCleanupRunnerSettlementTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--fixture-cleanup-self-test") {
      fixtureCleanupSelfTest = true;
      continue;
    }

    if (arg === "--fixture-cleanup-signal-target") {
      fixtureCleanupSignalTarget = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--fixture-cleanup-signal-target=")) {
      fixtureCleanupSignalTarget = arg.slice("--fixture-cleanup-signal-target=".length);
      continue;
    }

    if (arg === "--fixture-cleanup-signal-early") {
      fixtureCleanupSignalEarly = true;
      continue;
    }

    if (arg === "--fixture-cleanup-runner-settlement-target") {
      fixtureCleanupRunnerSettlementTarget = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (fixtureCleanupSignalTarget !== null && !["SIGINT", "SIGTERM"].includes(fixtureCleanupSignalTarget)) {
    fail("--fixture-cleanup-signal-target must be SIGINT or SIGTERM.");
  }

  if (fixtureCleanupSignalEarly && fixtureCleanupSignalTarget === null) {
    fail("--fixture-cleanup-signal-early requires --fixture-cleanup-signal-target.");
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
      fixtureCleanupSelfTest,
      fixtureCleanupSignalTarget,
      fixtureCleanupSignalEarly,
      fixtureCleanupRunnerSettlementTarget,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
    fixtureCleanupSelfTest,
    fixtureCleanupSignalTarget,
    fixtureCleanupSignalEarly,
    fixtureCleanupRunnerSettlementTarget,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  return routeTests.filter((_, index) => index % shardCount === shardIndex);
}

async function runOwnedCommand(command, args, options) {
  const {
    label,
    env: extraEnv = {},
    cwd = repoRoot,
    stdio = "inherit",
    timeoutMs = null,
    beforeStart = null,
    afterSpawnBeforeOwnership = null,
    afterOwnershipReady = null,
    beforeCleanup = null,
    cleanupRunStateFn = cleanupRunState,
    discoverOwnedProcessesToFixedPointFn = discoverOwnedProcessesToFixedPoint,
    requestOwnedRunShutdownFn = requestOwnedRunShutdown,
  } = options;

  invocationIndex += 1;
  if (process.platform === "linux") {
    assertLinuxProcReady(fail);
  }
  const tempRootParent = selectVitestTempRootParent();
  mkdirSync(tempRootParent, { recursive: true });
  await sweepOrphanedPcvtTempDirs(tempRootParent);
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  const runToken = generateRunToken();
  const runState = createRunState(testRoot, runToken, `${process.pid}-${invocationIndex}`);
  activeRuns.add(runState);
  console.log(`\n[test:run] ${label}`);

  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    ...extraEnv,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    [runTokenEnvName]: runToken,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });

  if (beforeStart) {
    await beforeStart({ env, runState, testRoot });
  }

  const child = spawn(command, args, { cwd, env, stdio });
  runState.child = child;
  if (afterSpawnBeforeOwnership) {
    await afterSpawnBeforeOwnership({ env, runState, testRoot, child });
  }

  let timedOut = false;
  let timer = null;
  let poller = null;
  let pollerError = null;
  try {
    if (process.platform === "linux") {
      if (!child.pid) throw new Error(`Failed to start ${label}: child pid unavailable`);
      if (!captureChildIdentity(runState) && !runState.runnerIdentity) {
        throw new Error(`Failed to start ${label}: child /proc identity unavailable`);
      }
      writeOwnerManifest(runState);
      poller = setInterval(() => {
        try {
          discoverOwnedProcessesToFixedPointFn(runState);
        } catch (error) {
          pollerError ??= error;
          requestOwnedRunShutdownFn(runState, "SIGTERM", 1, false);
        }
      }, 200);
    }

    if (afterOwnershipReady) {
      await afterOwnershipReady({ env, runState, testRoot, child });
    }

    const result = await new Promise((resolve, reject) => {
      runState.forceSettle = resolve;
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          timedOut = true;
          requestOwnedRunShutdownFn(runState, "SIGTERM", 124, true);
        }, timeoutMs);
      }
      if (shutdownRequested && shutdownExitCode !== null) {
        requestOwnedRunShutdownFn(runState, shutdownSignal ?? "SIGTERM", shutdownExitCode, false);
      }
    });

    if (beforeCleanup) {
      await beforeCleanup({ env, runState, testRoot });
    }
    let shutdownError = null;
    if (runState.shutdownPromise) {
      try {
        await runState.shutdownPromise;
      } catch (error) {
        shutdownError = error;
      }
    }
    let cleanupError = null;
    try {
      await cleanupRunStateFn(runState);
    } catch (error) {
      cleanupError = error;
    }
    if (pollerError) throw pollerError;
    if (shutdownError) throw shutdownError;
    if (cleanupError) throw cleanupError;
    if (timedOut) return { status: 124, signal: null, timedOut: true };
    return { ...result, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
    if (poller) clearInterval(poller);
    runState.forceSettle = null;
    if (activeRuns.has(runState)) {
      await cleanupRunState(runState);
    }
  }
}

async function runVitest(args, label) {
  const result = await runOwnedCommand("pnpm", ["exec", "vitest", "run", ...args], { label });
  const status = result.status ?? (result.signal ? 1 : 0);
  if (status !== 0) {
    if (continueOnFailure && !shutdownRequested) {
      failures.push({ label, status });
      return;
    }
    process.exitCode = status;
    throw new Error(`${label} failed with exit ${status}`);
  }
}

function exitWithFailureSummary() {
  if (failures.length === 0) return;
  console.error("\n[test:run] Failing suites:");
  for (const failure of failures) {
    console.error(`[test:run] - ${failure.label} (exit ${failure.status})`);
  }
  process.exitCode = 1;
}

async function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    if (shutdownRequested) return;
    await runGeneralGroup(routeTests, groupName);
  }
}

async function runProjectGroup(projects, groupName) {
  for (const project of projects) {
    if (shutdownRequested) return;
    await runVitest(["--project", project], `${groupName} project ${project}`);
  }
}

async function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        generalServerTestFiles,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      await runVitest(
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    await runProjectGroup(generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    await runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

async function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  for (const routeTest of shardTests) {
    if (shutdownRequested) return;
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        routeTest.repoPath,
        "--pool=forks",
        "--isolate",
      ],
      routeTest.repoPath,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. Sharding this list across runners is what keeps
// the general-server lane from becoming the PR critical path: the server vitest
// config pins maxWorkers to 1, so the only way to parallelize is across jobs.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const generalServerTestFiles = walk(serverSrcDir)
  .map((file) => toRepoPath(file))
  .filter((repoPath) => repoPath.endsWith(".test.ts"))
  .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
  .sort((a, b) => a.localeCompare(b));

function fixtureCleanupContext() {
  return {
    getShutdownExitCode: () => shutdownExitCode,
    lifecycle,
    repoRoot,
    runOwnedCommand,
    scriptPath,
  };
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.fixtureCleanupSignalTarget) {
    await runFixtureCleanupSignalTarget(
      fixtureCleanupContext(),
      options.fixtureCleanupSignalTarget,
      options.fixtureCleanupSignalEarly,
    );
    return;
  }

  if (options.fixtureCleanupRunnerSettlementTarget) {
    await runFixtureCleanupRunnerSettlementTarget(fixtureCleanupContext());
    return;
  }

  if (options.fixtureCleanupSelfTest) {
    await runFixtureCleanupSelfTest(fixtureCleanupContext());
    return;
  }

  if (options.dryRun) {
    const serializedSuites =
      options.mode === serializedModeName
        ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
        : routeTests;
    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          shardIndex: options.shardIndex,
          shardCount: options.shardCount,
          group: options.group,
          availableGeneralGroups: generalGroupNames,
          serializedSuiteCount: routeTests.length,
          selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
          generalServerSuiteCount: generalServerTestFiles.length,
          selectedGeneralServerSuites:
            options.mode === generalModeName &&
            options.group === generalServerGroupName &&
            options.shardCount !== null
              ? selectGeneralServerShard(
                  generalServerTestFiles,
                  options.shardIndex,
                  options.shardCount,
                  generalServerShardDurations,
                )
              : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.mode === generalModeName || options.mode === allModeName) {
    if (options.group) {
      await runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
    } else {
      await runGeneralSuites(routeTests);
    }
  }

  if (!shutdownRequested && (options.mode === serializedModeName || options.mode === allModeName)) {
    await runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
  }

  exitWithFailureSummary();
  if (shutdownExitCode !== null) {
    process.exitCode = shutdownExitCode;
  }
}

main().catch(async (error) => {
  try {
    await cleanupActiveRuns();
  } catch (cleanupError) {
    console.error(`[test:run] ${cleanupError.message}`);
  }
  console.error(`[test:run] ${error.message}`);
  process.exitCode = shutdownExitCode ?? process.exitCode ?? 1;
});
