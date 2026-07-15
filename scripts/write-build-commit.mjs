#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultOutput = resolve(repoRoot, "server", "dist", "BUILD_COMMIT");
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function normalizeBuildCommit(value) {
  const commit = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!commitPattern.test(commit)) {
    throw new Error("build commit must be a full 40- or 64-character hexadecimal object id");
  }
  return commit;
}

export function resolveBuildCommit({
  root = repoRoot,
  explicitCommit = process.env.PAPERCLIP_BUILD_COMMIT,
  git = execFileSync,
} = {}) {
  if (explicitCommit?.trim()) return normalizeBuildCommit(explicitCommit);

  const status = git("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.trim()) return null;

  return normalizeBuildCommit(git("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

export function writeBuildCommit({ output = defaultOutput, ...options } = {}) {
  const commit = resolveBuildCommit(options);
  if (!commit) {
    rmSync(output, { force: true });
    return null;
  }

  mkdirSync(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryOutput, `${commit}\n`, { mode: 0o444, flag: "wx" });
    renameSync(temporaryOutput, output);
  } finally {
    rmSync(temporaryOutput, { force: true });
  }
  return commit;
}

function main() {
  const output = process.argv[2] ? resolve(process.argv[2]) : defaultOutput;
  const commit = writeBuildCommit({ output });
  if (commit) {
    process.stdout.write(`Embedded build commit ${commit}\n`);
  } else {
    process.stderr.write(
      "Tracked source changes detected; omitted BUILD_COMMIT to avoid false provenance.\n",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
