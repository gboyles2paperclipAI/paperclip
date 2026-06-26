import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts", "tmpfs-usage-guard.sh");

function runGuard(args) {
  return spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
    },
  });
}

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "tmpfs-guard-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("forced pressure emits redacted metadata-only JSON", () => {
  withTempRoot((root) => {
    mkdirSync(join(root, "paperclip-agent-old"));
    writeFileSync(join(root, "paperclip-agent-old", "payload.txt"), "x".repeat(1024));
    mkdirSync(join(root, ".env.secret"));
    mkdirSync(join(root, ".vercel"));
    mkdirSync(join(root, ".update-hidden"));

    const result = runGuard(["--tmp-dir", root, "--force-pressure", "--json", "--stale-minutes", "0"]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stdout, /paperclip-agent-old|payload\.txt|\.env\.secret|\.vercel|\.update-hidden/);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.tmpDir, "[custom tmp dir redacted]");
    assert.equal(parsed.pressure, true);
    assert.deepEqual(parsed.pressureReasons, ["forced_dry_run"]);
    assert.equal(parsed.inventory.length, 1);
    assert.match(parsed.inventory[0].ref, /^tmp-entry-\d{3}$/);
    assert.equal(parsed.inventory[0].location, "top-level tmp entry");
    assert.equal(parsed.inventory[0].cleanupCandidate, true);
    assert.equal(parsed.cleanup[0].action, "would_remove");
    assert.equal(parsed.cleanup[0].ref, parsed.inventory[0].ref);
  });
});

test("apply rejects forced pressure", () => {
  withTempRoot((root) => {
    const result = runGuard(["--tmp-dir", root, "--apply", "--force-pressure", "--json"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--force-pressure is dry-run only/);
  });
});

test("apply removes only stale owned transient directories under pressure", () => {
  withTempRoot((root) => {
    const stale = join(root, "paperclip-agent-stale");
    const sensitive = join(root, "paperclip-agent-sensitive");
    const unrelated = join(root, "unrelated-cache");
    mkdirSync(stale);
    mkdirSync(sensitive);
    writeFileSync(join(sensitive, ".env.local"), "");
    mkdirSync(unrelated);

    const result = runGuard([
      "--tmp-dir",
      root,
      "--apply",
      "--json",
      "--bytes-threshold",
      "0",
      "--inodes-threshold",
      "0",
      "--stale-minutes",
      "0",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /paperclip-agent-stale|paperclip-agent-sensitive|unrelated-cache|\.env\.local/);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, "apply");
    assert.ok(parsed.removed.count >= 1);
    assert.equal(parsed.cleanup.some((entry) => entry.action === "removed"), true);
    assert.equal(parsed.cleanup.some((entry) => entry.action === "skipped_forbidden_name"), true);
  });
});
