#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectNpmReleaseTarball } from "./npm-release-tarball.mjs";

const fullCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const help2dayVersionPattern = /^(\d{4})\.(\d{1,2})(\d{2})\.(0|[1-9]\d*)-help2day\.([1-9]\d*)$/;

export function validateFullCommit(value, label = "commit") {
  const commit = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!fullCommitPattern.test(commit)) {
    throw new Error(`${label} must be a full lowercase hexadecimal object id`);
  }
  return commit;
}

export function validateHelp2dayVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  const match = help2dayVersionPattern.exec(version);
  if (!match) {
    throw new Error("version must use YYYY.MDD.P-help2day.N");
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("version contains an invalid UTC month or day");
  }
  return version;
}

export function validateBuildTimestamp(value) {
  const timestamp = typeof value === "string" ? value.trim() : "";
  const parsed = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("build timestamp must be a canonical ISO-8601 UTC timestamp");
  }
  return timestamp;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildReleaseManifest({
  version,
  sourceCommit,
  upstreamBase,
  forkAnchor,
  buildTimestamp,
  builderId,
  lockfile,
  sourceLockfiles,
  sbom,
  releaseMap,
  artifacts,
  evidence = [],
}) {
  const normalizedVersion = validateHelp2dayVersion(version);
  const normalizedBuilder = typeof builderId === "string" ? builderId.trim() : "";
  if (!normalizedBuilder || /[\r\n\t]/.test(normalizedBuilder)) {
    throw new Error("builder id must be a non-empty single-line identifier");
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("release manifest requires at least one artifact");
  }

  const normalizedArtifacts = artifacts
    .map((artifact) => {
      if (artifact.version !== normalizedVersion) {
        throw new Error(`artifact ${artifact.name} does not use governed version ${normalizedVersion}`);
      }
      return {
        package: artifact.name,
        version: artifact.version,
        filename: basename(artifact.path),
        sha256: artifact.sha256,
      };
    })
    .sort((left, right) => left.package.localeCompare(right.package));

  const normalizedEvidence = evidence
    .map((item) => ({ filename: item.filename, sha256: item.sha256 }))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  return {
    schemaVersion: 1,
    product: "paperclip",
    distribution: "help2day",
    version: normalizedVersion,
    sourceCommit: validateFullCommit(sourceCommit, "source commit"),
    upstreamBase: validateFullCommit(upstreamBase, "upstream base"),
    forkAnchor: validateFullCommit(forkAnchor, "fork anchor"),
    build: {
      timestamp: validateBuildTimestamp(buildTimestamp),
      builderId: normalizedBuilder,
    },
    lockfile,
    sourceLockfiles,
    releaseMap,
    sbom,
    artifacts: normalizedArtifacts,
    evidence: normalizedEvidence,
  };
}

export function parseArtifactIndex(contents, { tokens = [], expectedSourceCommit } = {}) {
  const records = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 5 || fields.some((field) => !field || /[\r\n]/.test(field))) {
      throw new Error(`invalid artifact index row ${index + 1}`);
    }
    const [dir, name, version, path, expectedSha256] = fields;
    const inspected = inspectNpmReleaseTarball({
      tarballPath: path,
      expectedName: name,
      expectedVersion: version,
      tokens,
    });
    if (inspected.sha256 !== expectedSha256) {
      throw new Error(`artifact hash drift for ${name}`);
    }
    if (name === "@paperclipai/server" && expectedSourceCommit) {
      const marker = inspected.entries.find(
        (entry) => entry.path === "package/dist/BUILD_COMMIT" && entry.type === "file",
      );
      if (!marker || marker.content.toString("utf8").trim() !== expectedSourceCommit) {
        throw new Error("server artifact build commit does not match the release source");
      }
    }
    records.push({ dir, name, version, path, sha256: inspected.sha256 });
  }
  if (records.length === 0) throw new Error("artifact index is empty");
  return records;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error("invalid release provenance arguments");
    }
    values.set(flag, value);
  }
  const required = [
    "--version",
    "--source-commit",
    "--upstream-base",
    "--fork-anchor",
    "--build-timestamp",
    "--builder-id",
    "--lockfile",
    "--source-lockfiles",
    "--release-map",
    "--sbom",
    "--artifact-index",
    "--installed-packages",
    "--output",
  ];
  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`missing ${flag}`);
  }
  return values;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const lockfilePath = resolve(args.get("--lockfile"));
    const releaseMapPath = resolve(args.get("--release-map"));
    const sbomPath = resolve(args.get("--sbom"));
    const artifactIndexPath = resolve(args.get("--artifact-index"));
    const outputPath = resolve(args.get("--output"));
    const sourceCommit = validateFullCommit(args.get("--source-commit"), "source commit");
    const artifacts = parseArtifactIndex(readFileSync(artifactIndexPath, "utf8"), {
      expectedSourceCommit: sourceCommit,
    });
    const manifest = buildReleaseManifest({
      version: args.get("--version"),
      sourceCommit,
      upstreamBase: args.get("--upstream-base"),
      forkAnchor: args.get("--fork-anchor"),
      buildTimestamp: args.get("--build-timestamp"),
      builderId: args.get("--builder-id"),
      lockfile: { filename: basename(lockfilePath), sha256: sha256File(lockfilePath) },
      sourceLockfiles: {
        filename: basename(resolve(args.get("--source-lockfiles"))),
        sha256: sha256File(resolve(args.get("--source-lockfiles"))),
      },
      releaseMap: { filename: basename(releaseMapPath), sha256: sha256File(releaseMapPath) },
      sbom: { filename: basename(sbomPath), sha256: sha256File(sbomPath) },
      artifacts,
      evidence: [{
        filename: basename(resolve(args.get("--installed-packages"))),
        sha256: sha256File(resolve(args.get("--installed-packages"))),
      }],
    });
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : "release provenance failed"}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
