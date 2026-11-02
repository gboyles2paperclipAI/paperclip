import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchExactFileQuiet, searchSafeSourceTreeQuiet } from "./sh9-quiet-search.mjs";

const scriptPath = new URL("./sh9-quiet-search.mjs", import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paperclip-sh9-search-"));
  const files = {
    "src/safe.js": "export const marker = 'safe-marker';\n",
    "src/safe.ts": "export const other = 'other-marker';\n",
    "src/structured.json": "{\"value\":\"blocked-marker\"}\n",
    ".env.fixture.js": "export const value = 'blocked-marker';\n",
    ".vercel/runtime.js": "export const value = 'blocked-marker';\n",
    ".paperclip/runtime.js": "export const value = 'blocked-marker';\n",
    ".update-release.js": "export const value = 'blocked-marker';\n",
    ".10714-issue-out.js": "export const value = 'blocked-marker';\n",
    "tmp-ful24922-helper.mjs": "export const value = 'blocked-marker';\n",
    "fix-ful24922.js": "export const value = 'blocked-marker';\n",
    "ful24922-helper.py": "value = 'blocked-marker'\n",
    ".tmp-ful24922.mjs": "export const value = 'blocked-marker';\n",
    ".fix-ful24922.js": "export const value = 'blocked-marker';\n",
    ".ful24922-helper.py": "value = 'blocked-marker'\n",
    "shell_snapshots/runtime.js": "export const value = 'blocked-marker';\n",
    "codex-home/shell_snapshots/runtime.js": "export const value = 'blocked-marker';\n",
    ".claude/sessions/runtime.js": "export const value = 'blocked-marker';\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

test("tree mode searches only positive safe-source extensions and excludes SH-9 paths", () => {
  const root = fixture();
  try {
    assert.equal(searchSafeSourceTreeQuiet({ root, literal: "safe-marker" }), true);
    assert.equal(searchSafeSourceTreeQuiet({ root, literal: "blocked-marker" }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact-file mode is a no-output primitive for generated structured artifacts", () => {
  const root = fixture();
  try {
    const structured = join(root, "src", "structured.json");
    assert.equal(searchExactFileQuiet({ file: structured, literal: "blocked-marker" }), true);
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--literal",
      "blocked-marker",
      "--file",
      structured,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quiet CLI reports only generic failure when a scan cannot run", () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--literal",
    "do-not-echo",
    "--file",
    "/missing/do-not-echo.json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "ERROR: quiet search could not complete safely.\n");
  assert.doesNotMatch(result.stderr, /do-not-echo|missing/);
});
