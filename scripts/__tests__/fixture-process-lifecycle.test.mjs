import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureLifecycle } from "../fixture-process-lifecycle.mjs";

function identity(pid, overrides = {}) {
  return {
    pid,
    ppid: overrides.ppid ?? 1,
    uid: overrides.uid ?? 1000,
    state: overrides.state ?? "S",
    startTicks: overrides.startTicks ?? String(pid * 10),
  };
}

test("shutdown force-settles before surfacing discovery failures", async () => {
  const lifecycle = createFixtureLifecycle({
    listProcessIds() {
      throw new Error("discovery failed");
    },
    onError() {},
    onLog() {},
    pid: 999,
    platform: "linux",
    readProcEnvironEntries: () => [],
    readProcIdentity: (pid) => identity(pid),
    sleep: async () => {},
  });
  const runState = lifecycle.createRunState("/tmp/pcvt-test", "token", "invocation", { pid: 10 });
  const settled = new Promise((resolve) => {
    runState.forceSettle = resolve;
  });

  lifecycle.requestOwnedRunShutdown(runState, "SIGTERM", 124, true);

  assert.deepEqual(await settled, { status: 124, signal: null, timedOut: true });
  await assert.rejects(runState.shutdownPromise, /discovery failed/);
});

test("shutdown force-settles before surfacing manifest persistence failures", async () => {
  const lifecycle = createFixtureLifecycle({
    chmodSync() {},
    listProcessIds: () => [],
    onError() {},
    onLog() {},
    pid: 999,
    platform: "linux",
    readProcEnvironEntries: () => [],
    readProcIdentity: (pid) => identity(pid),
    sleep: async () => {},
    writeFileSync() {
      throw new Error("manifest write failed");
    },
  });
  const runState = lifecycle.createRunState("/tmp/pcvt-test", "token", "invocation", { pid: 10 });
  runState.manifestWritten = true;
  const settled = new Promise((resolve) => {
    runState.forceSettle = resolve;
  });

  lifecycle.requestOwnedRunShutdown(runState, "SIGTERM", 143, false);

  assert.deepEqual(await settled, { status: 143, signal: null, timedOut: false });
  await assert.rejects(runState.shutdownPromise, /manifest write failed/);
});

test("PID reuse revalidation prevents TERM and KILL", async () => {
  const killCalls = [];
  const lifecycle = createFixtureLifecycle({
    hasExactRunToken: () => false,
    kill(pid, signal) {
      killCalls.push({ pid, signal });
    },
    listProcessIds: () => [10],
    onError() {},
    onLog() {},
    pid: 999,
    platform: "linux",
    readProcIdentity: (pid) => identity(pid, { startTicks: "new-owner" }),
    sleep: async () => {},
  });
  const oldIdentity = identity(10, { startTicks: "old-owner" });
  const runState = lifecycle.createRunState("/tmp/pcvt-test", "token", "invocation");
  runState.owned.set(lifecycle.identityKey(oldIdentity), oldIdentity);

  assert.equal(lifecycle.signalOwnedIdentity(runState, oldIdentity, "SIGTERM"), false);
  await lifecycle.terminateOwnedProcesses(runState);

  assert.deepEqual(killCalls, []);
});

test("manifest createdAt remains stable across identity updates", () => {
  const manifests = [];
  let now = 1_000;
  const lifecycle = createFixtureLifecycle({
    chmodSync() {},
    now: () => {
      now += 1_000;
      return now;
    },
    onError() {},
    onLog() {},
    pid: 999,
    writeFileSync(_file, contents) {
      manifests.push(JSON.parse(contents));
    },
  });
  const runState = lifecycle.createRunState("/tmp/pcvt-test", "token", "invocation");
  runState.runnerIdentity = identity(10);
  runState.owned.set(lifecycle.identityKey(identity(10)), identity(10));

  lifecycle.writeOwnerManifest(runState);
  runState.owned.set(lifecycle.identityKey(identity(11)), identity(11));
  lifecycle.writeOwnerManifest(runState);

  assert.equal(manifests.length, 2);
  assert.equal(manifests[0].createdAt, manifests[1].createdAt);
  assert.equal(manifests[1].ownedIdentities.length, 2);
});
