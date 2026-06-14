import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyStartCommand,
  collectScannableSourceFiles,
  collectRuntimeWorkspacePackages,
  findConflictMarkerOffenses,
  findRuntimeSourceExportOffenses,
  getUnresolvedGitPaths,
  readServerStartScript,
  runRuntimeSourcePreflight,
  scanRuntimeWorkspaceExports,
  scanConflictMarkers,
} from "./runtime-source-preflight.mjs";

function makeTempRepo(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
  return root;
}

let gitChildProcessAvailable;
function canUseGitChildProcess() {
  if (gitChildProcessAvailable !== undefined) return gitChildProcessAvailable;

  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-preflight-git-check-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    gitChildProcessAvailable = true;
  } catch {
    gitChildProcessAvailable = false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return gitChildProcessAvailable;
}

test("findConflictMarkerOffenses reports marker line numbers without line content", () => {
  const offenses = findConflictMarkerOffenses("const ok = 1;\n<<<<<<< ours\nsecret\n=======\n>>>>>>> theirs\n");
  assert.deepEqual(offenses, [
    { lineNumber: 2 },
    { lineNumber: 4 },
    { lineNumber: 5 },
  ]);
});

test("scanConflictMarkers scans source files and ignores backup suffixes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-preflight-markers-"));
  try {
    mkdirSync(path.join(root, "server/src/services"), { recursive: true });
    writeFileSync(path.join(root, "server/src/services/active.ts"), "const x = 1;\n<<<<<<< ours\n");
    writeFileSync(path.join(root, "server/src/services/old.ts.conflict-backup"), "<<<<<<< ours\n");

    assert.deepEqual(
      collectScannableSourceFiles({ repoRoot: root }).map((file) => file.relativePath),
      ["server/src/services/active.ts"],
    );
    assert.deepEqual(scanConflictMarkers({ repoRoot: root }), [
      { relativePath: "server/src/services/active.ts", lineNumber: 2 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRuntimeSourcePreflight prints only paths and line numbers for conflict markers", (t) => {
  if (!canUseGitChildProcess()) {
    t.skip("Node child_process cannot spawn git in this sandbox");
    return;
  }

  const root = makeTempRepo("runtime-preflight-output-");
  try {
    mkdirSync(path.join(root, "server/src"), { recursive: true });
    writeFileSync(path.join(root, "server/package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(path.join(root, "server/src/heartbeat.ts"), "const token = 'do-not-print';\n=======\n");

    const logs = [];
    const errors = [];
    const code = runRuntimeSourcePreflight({
      repoRoot: root,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("server/src/heartbeat.ts:2")));
    assert.ok(!errors.join("\n").includes("do-not-print"));
    assert.equal(logs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getUnresolvedGitPaths reports unmerged paths", (t) => {
  if (!canUseGitChildProcess()) {
    t.skip("Node child_process cannot spawn git in this sandbox");
    return;
  }

    const root = makeTempRepo("runtime-preflight-git-");
  try {
    writeFileSync(path.join(root, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "other"], { cwd: root, stdio: "ignore" });
    writeFileSync(path.join(root, "file.txt"), "other\n");
    execFileSync("git", ["commit", "-am", "other"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "-"], { cwd: root, stdio: "ignore" });
    writeFileSync(path.join(root, "file.txt"), "main\n");
    execFileSync("git", ["commit", "-am", "main"], { cwd: root, stdio: "ignore" });

    try {
      execFileSync("git", ["merge", "other"], { cwd: root, stdio: "ignore" });
    } catch {
      // Expected merge conflict.
    }

    const result = getUnresolvedGitPaths({ repoRoot: root });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths, ["file.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRuntimeSourcePreflight passes on clean source and clean git index", (t) => {
  if (!canUseGitChildProcess()) {
    t.skip("Node child_process cannot spawn git in this sandbox");
    return;
  }

  const root = makeTempRepo("runtime-preflight-pass-");
  try {
    mkdirSync(path.join(root, "server/src"), { recursive: true });
    writeFileSync(path.join(root, "server/package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(path.join(root, "server/src/index.ts"), "export const ok = true;\n");
    const logs = [];
    const errors = [];
    const code = runRuntimeSourcePreflight({
      repoRoot: root,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => line.includes("Runtime source preflight passed")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findRuntimeSourceExportOffenses ignores explicit development-only source exports", () => {
  assert.deepEqual(findRuntimeSourceExportOffenses({
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      development: "./src/index.ts",
    },
  }), []);

  assert.deepEqual(findRuntimeSourceExportOffenses({
    ".": {
      import: "./src/index.ts",
    },
  }), [
    {
      exportPath: ".",
      conditions: ["import"],
      target: "./src/index.ts",
    },
  ]);
});

test("scanRuntimeWorkspaceExports follows server workspace runtime dependencies", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-preflight-exports-"));
  try {
    mkdirSync(path.join(root, "server"), { recursive: true });
    mkdirSync(path.join(root, "packages/runtime-a/dist"), { recursive: true });
    mkdirSync(path.join(root, "packages/runtime-b/dist"), { recursive: true });
    mkdirSync(path.join(root, "packages/dev-only"), { recursive: true });

    writeFileSync(path.join(root, "server/package.json"), JSON.stringify({
      dependencies: {
        "@test/runtime-a": "workspace:*",
      },
      devDependencies: {
        "@test/dev-only": "workspace:*",
      },
    }));
    writeFileSync(path.join(root, "packages/runtime-a/package.json"), JSON.stringify({
      name: "@test/runtime-a",
      exports: {
        ".": "./dist/index.js",
        "./missing": "./dist/missing.js",
      },
      dependencies: {
        "@test/runtime-b": "workspace:*",
      },
    }));
    writeFileSync(path.join(root, "packages/runtime-a/dist/index.js"), "export {};\n");
    writeFileSync(path.join(root, "packages/runtime-b/package.json"), JSON.stringify({
      name: "@test/runtime-b",
      exports: {
        ".": "./src/index.ts",
      },
    }));
    writeFileSync(path.join(root, "packages/dev-only/package.json"), JSON.stringify({
      name: "@test/dev-only",
      exports: {
        ".": "./src/index.ts",
      },
    }));

    assert.deepEqual(
      collectRuntimeWorkspacePackages({ repoRoot: root }).map((entry) => entry.pkg.name),
      ["@test/runtime-a", "@test/runtime-b"],
    );

    const result = scanRuntimeWorkspaceExports({ repoRoot: root });
    assert.deepEqual(result.sourceExportOffenses.map((offense) => offense.packageName), ["@test/runtime-b"]);
    assert.deepEqual(result.missingDistExportTargets.map((offense) => offense.target), ["./dist/missing.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyStartCommand correctly classifies node-dist, tsx-src, and unknown commands", () => {
  assert.equal(classifyStartCommand("node dist/index.js"), "node-dist");
  assert.equal(classifyStartCommand("node ./dist/server.js --port 3100"), "node-dist");
  assert.equal(classifyStartCommand("tsx src/index.ts"), "tsx-src");
  assert.equal(classifyStartCommand("tsx ./src/index.ts"), "tsx-src");
  assert.equal(classifyStartCommand("pnpm dev"), "unknown");
  assert.equal(classifyStartCommand(null), "unknown");
  assert.equal(classifyStartCommand(""), "unknown");
});

test("readServerStartScript reads start script from server/package.json", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-preflight-startscript-"));
  try {
    mkdirSync(path.join(root, "server"), { recursive: true });
    writeFileSync(
      path.join(root, "server/package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts", dev: "tsx src/index.ts" } }),
    );
    assert.equal(readServerStartScript({ repoRoot: root }), "tsx src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: FUL-11154 — node dist/ start command with TS source workspace exports causes service loop.
test("runRuntimeSourcePreflight FAILS when start is node dist and workspace package exports TS source", (t) => {
  if (!canUseGitChildProcess()) {
    t.skip("Node child_process cannot spawn git in this sandbox");
    return;
  }

  const root = makeTempRepo("runtime-preflight-node-dist-fail-");
  try {
    mkdirSync(path.join(root, "server/src"), { recursive: true });
    mkdirSync(path.join(root, "packages/db/src"), { recursive: true });

    writeFileSync(
      path.join(root, "server/package.json"),
      JSON.stringify({
        scripts: { start: "node dist/index.js" },
        dependencies: { "@paperclipai/db": "workspace:*" },
      }),
    );
    writeFileSync(
      path.join(root, "packages/db/package.json"),
      JSON.stringify({
        name: "@paperclipai/db",
        exports: { ".": "./src/index.ts" },
      }),
    );
    writeFileSync(path.join(root, "packages/db/src/index.ts"), "export const ok = true;\n");

    const errors = [];
    const code = runRuntimeSourcePreflight({
      repoRoot: root,
      log: () => {},
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("node dist/index.js")));
    assert.ok(errors.some((line) => line.includes("@paperclipai/db")));
    assert.ok(errors.some((line) => line.includes("./src/index.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Current healthy state: tsx src/index.ts start with TS source workspace exports must pass.
test("runRuntimeSourcePreflight PASSES when start is tsx src and workspace package exports TS source", (t) => {
  if (!canUseGitChildProcess()) {
    t.skip("Node child_process cannot spawn git in this sandbox");
    return;
  }

  const root = makeTempRepo("runtime-preflight-tsx-src-pass-");
  try {
    mkdirSync(path.join(root, "server/src"), { recursive: true });
    mkdirSync(path.join(root, "packages/db/src"), { recursive: true });

    writeFileSync(
      path.join(root, "server/package.json"),
      JSON.stringify({
        scripts: { start: "tsx src/index.ts" },
        dependencies: { "@paperclipai/db": "workspace:*" },
      }),
    );
    writeFileSync(
      path.join(root, "packages/db/package.json"),
      JSON.stringify({
        name: "@paperclipai/db",
        exports: { ".": "./src/index.ts" },
      }),
    );
    writeFileSync(path.join(root, "packages/db/src/index.ts"), "export const ok = true;\n");

    const logs = [];
    const errors = [];
    const code = runRuntimeSourcePreflight({
      repoRoot: root,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => line.includes("tsx-src")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
