import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseManifest,
  validateBuildTimestamp,
  validateFullCommit,
  validateHelp2dayVersion,
} from "./release-provenance.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("validates the governed Help2day calver distribution format", () => {
  assert.equal(validateHelp2dayVersion("2026.715.0-help2day.1"), "2026.715.0-help2day.1");
  assert.equal(validateHelp2dayVersion("2026.1015.2-help2day.7"), "2026.1015.2-help2day.7");
  assert.throws(() => validateHelp2dayVersion("0.3.1-help2day.1"), /YYYY\.MDD/);
  assert.throws(() => validateHelp2dayVersion("2026.1332.0-help2day.1"), /invalid UTC/);
});

test("requires immutable commits and a canonical UTC timestamp", () => {
  assert.equal(validateFullCommit(commit), commit);
  assert.throws(() => validateFullCommit(commit.slice(0, 12)), /full lowercase/);
  assert.equal(validateBuildTimestamp("2026-07-15T13:15:00.000Z"), "2026-07-15T13:15:00.000Z");
  assert.throws(() => validateBuildTimestamp("2026-07-15"), /canonical ISO-8601/);
});

test("builds a stable sorted manifest and rejects version drift", () => {
  const input = {
    version: "2026.715.0-help2day.1",
    sourceCommit: commit,
    upstreamBase: "1".repeat(40),
    forkAnchor: "2".repeat(40),
    buildTimestamp: "2026-07-15T13:15:00.000Z",
    builderId: "github:gboyles2paperclipAI/paperclip/actions/runs/123",
    lockfile: { filename: "package-lock.json", sha256: "a".repeat(64) },
    releaseMap: { filename: "release-package-manifest.json", sha256: "b".repeat(64) },
    sbom: { filename: "sbom.cdx.json", sha256: "c".repeat(64) },
    artifacts: [
      { name: "paperclipai", version: "2026.715.0-help2day.1", path: "/tmp/z.tgz", sha256: "d".repeat(64) },
      { name: "@paperclipai/server", version: "2026.715.0-help2day.1", path: "/tmp/a.tgz", sha256: "e".repeat(64) },
    ],
  };
  const manifest = buildReleaseManifest(input);
  assert.deepEqual(manifest.artifacts.map((item) => item.package), ["@paperclipai/server", "paperclipai"]);
  assert.equal(manifest.distribution, "help2day");

  assert.throws(
    () => buildReleaseManifest({
      ...input,
      artifacts: [{ ...input.artifacts[0], version: "2026.715.0-help2day.2" }],
    }),
    /does not use governed version/,
  );
});
