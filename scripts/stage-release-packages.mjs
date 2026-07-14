#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveForbiddenTokens } from "./check-forbidden-tokens.mjs";
import { inspectNpmReleaseTarball } from "./npm-release-tarball.mjs";
import { getReleasePackages } from "./release-package-map.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const stageMarker = ".paperclip-release-stage";

export function createReleaseStageRoot(parent = tmpdir()) {
  const stageRoot = mkdtempSync(join(parent, "paperclip-release-stage."));
  try {
    writeFileSync(join(stageRoot, stageMarker), "", { flag: "wx" });
    return stageRoot;
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupReleaseStageRoot(stageRoot) {
  if (!stageRoot) return;
  const resolved = resolve(stageRoot);
  if (!basename(resolved).startsWith("paperclip-release-stage.") || !existsSync(join(resolved, stageMarker))) {
    throw new Error("refusing to clean an unrecognized release staging root");
  }
  function makeWritable(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) makeWritable(join(path, entry));
    }
  }
  makeWritable(resolved);
  rmSync(resolved, { recursive: true, force: false });
}

function validateField(value) {
  if (typeof value !== "string" || !value || /[\t\r\n]/.test(value)) {
    throw new Error("invalid staged release field");
  }
  return value;
}

export function resolveConfiguredForbiddenTokens(root = repoRoot, exec = execFileSync) {
  const gitCommonDir = exec("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return resolveForbiddenTokens(resolve(root, gitCommonDir, "hooks/forbidden-tokens.txt"));
}

export function stageReleasePackages({
  root = repoRoot,
  stageRoot,
  packages = getReleasePackages(),
  tokens = resolveConfiguredForbiddenTokens(root),
  runPack = (packageDir, destination) =>
    spawnSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
}) {
  const resolvedStageRoot = resolve(stageRoot);
  if (!existsSync(join(resolvedStageRoot, stageMarker))) {
    throw new Error("release staging root is missing its safety marker");
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("release package plan is empty");
  }
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("release forbidden-token policy is empty");
  }

  const staged = [];
  for (const [index, pkg] of packages.entries()) {
    const dir = validateField(pkg.dir);
    const name = validateField(pkg.name);
    const version = validateField(pkg.version ?? pkg.pkg?.version);
    const destination = join(resolvedStageRoot, String(index + 1).padStart(3, "0"));
    mkdirSync(destination, { recursive: false });
    const result = runPack(resolve(root, dir), destination);
    if (result?.error || result?.signal || result?.status !== 0) {
      throw new Error("package lifecycle staging failed");
    }

    const stagedEntries = readdirSync(destination).map((entry) => join(destination, entry));
    if (
      stagedEntries.length !== 1 ||
      !basename(stagedEntries[0]).endsWith(".tgz") ||
      !lstatSync(stagedEntries[0]).isFile()
    ) {
      throw new Error("package staging did not produce exactly one regular tarball");
    }
    const tarballPath = stagedEntries[0];

    const inspected = inspectNpmReleaseTarball({
      tarballPath,
      expectedName: name,
      expectedVersion: version,
      tokens,
    });
    const immutablePath = join(destination, `${String(index + 1).padStart(3, "0")}-${inspected.sha256}.tgz`);
    renameSync(tarballPath, immutablePath);
    chmodSync(immutablePath, 0o444);
    chmodSync(destination, 0o555);
    staged.push({ dir, name, version, tarballPath: immutablePath, sha256: inspected.sha256 });
  }
  chmodSync(resolvedStageRoot, 0o555);
  return staged;
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "stage") {
    console.error("Usage: stage-release-packages.mjs stage <marked-stage-root>");
    process.exit(2);
  }
  try {
    const staged = stageReleasePackages({ stageRoot: process.argv[3] });
    for (const item of staged) {
      process.stdout.write(
        [item.dir, item.name, item.version, item.tarballPath, item.sha256].join("\t") + "\n",
      );
    }
  } catch {
    console.error("ERROR: Could not safely stage and scan the complete release package set.");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
