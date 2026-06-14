import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectEvidenceArtifactFiles,
  findArtifactSecretOffenses,
  runEvidenceArtifactSecretCheck,
} from "./check-evidence-artifact-secrets.mjs";

test("findArtifactSecretOffenses flags credential-bearing connection strings without returning content", () => {
  const credential = "postgresql://app_user:synthetic-password@db.example.test/help2day";
  const offenses = findArtifactSecretOffenses(`restart output\nDATABASE_URL=${credential}\n`);

  assert.deepEqual(offenses, [
    { lineNumber: 2, ruleId: "postgres-credential-uri" },
    { lineNumber: 2, ruleId: "secret-env-assignment" },
  ]);
  assert.equal(JSON.stringify(offenses).includes("synthetic-password"), false);
});

test("runEvidenceArtifactSecretCheck reports only path, line number, and rule id", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evidence-artifact-secret-fail-"));
  try {
    writeFileSync(
      path.join(root, "restart-evidence-2026-06-13.md"),
      "diagnostic\npostgres://user:synthetic-password@localhost/app\n",
    );
    const logs = [];
    const errors = [];
    const code = runEvidenceArtifactSecretCheck({
      repoRoot: root,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.equal(logs.length, 0);
    assert.ok(errors.some((line) => line.includes("restart-evidence-2026-06-13.md:2: postgres-credential-uri")));
    assert.equal(errors.join("\n").includes("synthetic-password"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runEvidenceArtifactSecretCheck passes clean evidence artifacts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evidence-artifact-secret-pass-"));
  try {
    writeFileSync(path.join(root, "restart-evidence-2026-06-13.md"), "Health check passed. Token name: DATABASE_URL.\n");
    const logs = [];
    const errors = [];
    const code = runEvidenceArtifactSecretCheck({
      repoRoot: root,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => line.includes("No credential-shaped content")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectEvidenceArtifactFiles skips secret-bearing runtime directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evidence-artifact-secret-skip-"));
  try {
    mkdirSync(path.join(root, ".vercel"), { recursive: true });
    mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    mkdirSync(path.join(root, ".update-123"), { recursive: true });
    writeFileSync(path.join(root, ".vercel", "restart-evidence.txt"), "");
    writeFileSync(path.join(root, ".paperclip", "debug-output.txt"), "");
    writeFileSync(path.join(root, ".update-123", "raw-log.txt"), "");
    writeFileSync(path.join(root, "restart-evidence.txt"), "");

    assert.deepEqual(collectEvidenceArtifactFiles({ repoRoot: root }).map((file) => file.relativePath), [
      "restart-evidence.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
