import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = new URL("./verify-package-integrity.sh", import.meta.url).pathname;

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-integrity-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, contents);
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runVerifier(target) {
  try {
    const output = execFileSync("bash", [scriptPath, target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output, status: 0 };
  } catch (error) {
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status ?? 1,
    };
  }
}

const cappedAgentsRoute = `
const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 50)) : 50;
const runs = await heartbeat.list(companyId, agentId, limit, { summary });
`;

test("passes when a built dist contains every mandatory marker", () => {
  const root = makeFixture({
    "routes/agents.js": cappedAgentsRoute,
    "routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0);
    assert.match(result.output, /Package integrity check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an installed package root containing dist", () => {
  const root = makeFixture({
    "dist/routes/agents.js": cappedAgentsRoute,
    "dist/routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "dist/services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails and lists missing markers for stale uncapped dist", () => {
  const root = makeFixture({
    "routes/agents.js": `
const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
const runs = await heartbeat.list(companyId, agentId);
`,
    "routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /missing: heartbeat-runs default limit cap/);
    assert.match(result.output, /missing: heartbeat-runs capped list call/);
    assert.match(result.output, /missing: #51 premium managed concurrency marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
