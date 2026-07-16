#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyManifestEntrypoints } from "./npm-release-tarball.mjs";

function listInstalledEntries(packageRoot, relative = "") {
  const entries = [];
  for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true })) {
    const child = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) entries.push(...listInstalledEntries(packageRoot, child));
    else if (entry.isFile()) entries.push({ path: `package/${child.split("\\").join("/")}`, type: "file" });
  }
  return entries;
}

export function verifyInstalledReleasePackages({ artifactIndex, installRoot, output }) {
  const records = [];
  const lines = readFileSync(artifactIndex, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("artifact index is empty");
  for (const [index, line] of lines.entries()) {
    const fields = line.split("\t");
    if (fields.length !== 5) throw new Error(`invalid artifact index row ${index + 1}`);
    const [, expectedName, expectedVersion] = fields;
    const packageRoot = resolve(installRoot, "node_modules", ...expectedName.split("/"));
    if (lstatSync(packageRoot).isSymbolicLink()) {
      throw new Error(`installed package ${expectedName} is an unexpected symlink`);
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
      throw new Error(`installed package identity drift for ${expectedName}`);
    }
    const targets = verifyManifestEntrypoints(manifest, listInstalledEntries(packageRoot));
    records.push({ package: expectedName, version: expectedVersion, entrypoints: targets });
  }
  records.sort((left, right) => left.package.localeCompare(right.package));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, packages: records }, null, 2)}\n`, { flag: "wx" });
  return records;
}

function main() {
  if (process.argv.length !== 5) {
    process.stderr.write("Usage: verify-installed-release-packages.mjs ARTIFACT_INDEX INSTALL_ROOT OUTPUT\n");
    process.exit(2);
  }
  try {
    verifyInstalledReleasePackages({
      artifactIndex: resolve(process.argv[2]),
      installRoot: resolve(process.argv[3]),
      output: resolve(process.argv[4]),
    });
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : "installed package verification failed"}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
