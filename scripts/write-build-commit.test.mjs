import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeBuildCommit,
  resolveBuildCommit,
  writeBuildCommit,
} from "./write-build-commit.mjs";

const commit = "abcdef0123456789abcdef0123456789abcdef01";

test("normalizes a full commit and rejects abbreviated or malformed values", () => {
  assert.equal(normalizeBuildCommit(` ${commit.toUpperCase()}\n`), commit);
  assert.throws(() => normalizeBuildCommit(commit.slice(0, 12)), /full 40- or 64-character/);
  assert.throws(() => normalizeBuildCommit("g".repeat(40)), /hexadecimal/);
});

test("explicit release commit takes precedence over repository inspection", () => {
  const resolved = resolveBuildCommit({
    explicitCommit: commit,
    git() {
      throw new Error("git must not run when release provenance is explicit");
    },
  });
  assert.equal(resolved, commit);
});

test("dirty source omits provenance instead of claiming the current HEAD", () => {
  const calls = [];
  const resolved = resolveBuildCommit({
    explicitCommit: "",
    git(_command, args) {
      calls.push(args);
      return " M server/package.json\n";
    },
  });
  assert.equal(resolved, null);
  assert.deepEqual(calls, [["status", "--porcelain", "--untracked-files=no"]]);
});

test("writes an immutable newline-terminated build marker", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-build-commit-"));
  const output = join(root, "dist", "BUILD_COMMIT");
  try {
    assert.equal(writeBuildCommit({ output, explicitCommit: commit }), commit);
    assert.equal(readFileSync(output, "utf8"), `${commit}\n`);

    assert.equal(
      writeBuildCommit({
        output,
        explicitCommit: "",
        git() {
          return " M tracked-file\n";
        },
      }),
      null,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
