#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { listStandalonePublicPackages } from "./build-standalone-public-packages.mjs";
import { linkSdkInto } from "./link-plugin-dev-sdk.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const requestedDirs = process.argv.slice(2).filter((arg) => arg !== "--");
const available = listStandalonePublicPackages().filter(({ dir }) => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"));
  return Boolean(pkg.scripts?.test);
});
const selected = requestedDirs.length === 0
  ? available
  : requestedDirs.map((dir) => {
      const match = available.find((pkg) => pkg.dir === dir);
      if (!match) throw new Error(`not a testable standalone release package: ${dir}`);
      return match;
    });

if (selected.length === 0) {
  console.log("  i No testable standalone public packages detected");
  process.exit(0);
}

execFileSync(
  "pnpm",
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
  { cwd: repoRoot, stdio: "inherit" },
);

for (const pkg of selected) {
  const config = path.join(pkg.dir, "vitest.config.ts");
  const packageRoot = path.join(repoRoot, pkg.dir);
  const configPath = path.join(repoRoot, config);
  const lockfilePath = path.join(packageRoot, "pnpm-lock.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`standalone package is missing its Vitest config: ${pkg.dir}`);
  }
  if (!existsSync(lockfilePath)) {
    throw new Error(`standalone package is missing its reproducibility lockfile: ${pkg.dir}`);
  }
  rmSync(path.join(packageRoot, "node_modules"), { force: true, recursive: true });
  execFileSync(
    "pnpm",
    ["install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: packageRoot, stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
  linkSdkInto(packageRoot);
  console.log(`  Testing standalone package ${pkg.name} with the repository-locked Vitest`);
  execFileSync(
    "pnpm",
    ["exec", "vitest", "run", "--root", packageRoot, "--config", configPath],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
}
