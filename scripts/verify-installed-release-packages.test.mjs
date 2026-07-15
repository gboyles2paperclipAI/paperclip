import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyInstalledReleasePackages } from "./verify-installed-release-packages.mjs";

function fixture({ includeEntrypoint = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-installed-release-"));
  const installRoot = join(root, "install");
  const packageRoot = join(installRoot, "node_modules", "@paperclipai", "example");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@paperclipai/example",
    version: "2026.715.0-help2day.1",
    main: "./dist/index.js",
  }));
  if (includeEntrypoint) writeFileSync(join(packageRoot, "dist", "index.js"), "export {};\n");
  const artifactIndex = join(root, "artifacts.tsv");
  writeFileSync(
    artifactIndex,
    `packages/example\t@paperclipai/example\t2026.715.0-help2day.1\t/tmp/example.tgz\t${"a".repeat(64)}\n`,
  );
  return { root, installRoot, artifactIndex, output: join(root, "installed-packages.json") };
}

test("records exact installed identities and concrete entrypoints", () => {
  const input = fixture();
  try {
    const records = verifyInstalledReleasePackages(input);
    assert.deepEqual(records, [{
      package: "@paperclipai/example",
      version: "2026.715.0-help2day.1",
      entrypoints: ["dist/index.js"],
    }]);
    assert.deepEqual(JSON.parse(readFileSync(input.output, "utf8")).packages, records);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("blocks an installed package with a missing entrypoint", () => {
  const input = fixture({ includeEntrypoint: false });
  try {
    assert.throws(() => verifyInstalledReleasePackages(input), /missing a concrete entrypoint/);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});
