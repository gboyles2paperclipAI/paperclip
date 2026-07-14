import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveNpmPackageFiles,
  runForbiddenTokenCheck,
  runForbiddenTokenFileCheck,
} from "./check-forbidden-tokens.mjs";

const forbidden = "account_fixture_6394";

function makePackageFixture() {
  const root = mkdtempSync(join(tmpdir(), "paperclip-forbidden-token-package-"));
  const packageDir = join(root, "package");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "scanner-fixture", version: "1.0.0", files: ["dist"] }, null, 2)}\n`,
  );
  writeFileSync(join(packageDir, "README.md"), "Safe package documentation.\n");
  writeFileSync(join(packageDir, "dist", "index.js"), "export const safe = true;\n");
  writeFileSync(
    join(packageDir, "historical-evidence.txt"),
    `non-publishable path: /home/${forbidden}/archive\n`,
  );
  return { root, packageDir };
}

test("npm dry-run enumeration excludes non-publishable historical evidence", () => {
  const fixture = makePackageFixture();
  try {
    const files = resolveNpmPackageFiles(fixture.packageDir);
    const relativeFiles = files.map((file) => file.slice(fixture.packageDir.length + 1)).sort();
    assert.deepEqual(relativeFiles, ["README.md", "dist/index.js", "package.json"]);

    const errors = [];
    const status = runForbiddenTokenFileCheck({
      files,
      tokens: [forbidden],
      displayRoot: fixture.root,
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(status, 0);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publishable bundled content containing a forbidden account reference fails closed", () => {
  const fixture = makePackageFixture();
  try {
    writeFileSync(
      join(fixture.packageDir, "dist", "index.js"),
      `export const hostPath = "/home/${forbidden}/runtime";\n`,
    );
    const files = resolveNpmPackageFiles(fixture.packageDir);
    const errors = [];
    const status = runForbiddenTokenFileCheck({
      files,
      tokens: [forbidden],
      displayRoot: fixture.root,
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(status, 1);
    assert.match(errors.join("\n"), /package\/dist\/index\.js:1:\[REDACTED forbidden token\]/);
    assert.doesNotMatch(errors.join("\n"), new RegExp(forbidden, "i"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publishable README content containing a case-varied forbidden reference fails closed", () => {
  const fixture = makePackageFixture();
  try {
    writeFileSync(join(fixture.packageDir, "README.md"), `Do not publish /Users/${forbidden.toUpperCase()}/work.\n`);
    const files = resolveNpmPackageFiles(fixture.packageDir);
    const errors = [];
    const status = runForbiddenTokenFileCheck({
      files,
      tokens: [forbidden],
      displayRoot: fixture.root,
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(status, 1);
    assert.match(errors.join("\n"), /package\/README\.md:1:\[REDACTED forbidden token\]/);
    assert.doesNotMatch(errors.join("\n"), new RegExp(forbidden, "i"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publishable file names containing a forbidden account reference fail closed", () => {
  const fixture = makePackageFixture();
  try {
    writeFileSync(join(fixture.packageDir, "dist", `${forbidden}.js`), "export {};\n");
    const files = resolveNpmPackageFiles(fixture.packageDir);
    const errors = [];
    const status = runForbiddenTokenFileCheck({
      files,
      tokens: [forbidden],
      displayRoot: fixture.root,
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(status, 1);
    assert.match(errors.join("\n"), /\[REDACTED publishable path\]/);
    assert.doesNotMatch(errors.join("\n"), new RegExp(forbidden, "i"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("npm manifest paths that escape the package directory fail closed", () => {
  const fixture = makePackageFixture();
  try {
    const fakeExec = () => JSON.stringify([{ files: [{ path: "../outside.txt" }] }]);
    assert.throws(
      () => resolveNpmPackageFiles(fixture.packageDir, fakeExec),
      /outside the package directory/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an empty npm publishable manifest fails closed", () => {
  const fixture = makePackageFixture();
  try {
    const fakeExec = () => JSON.stringify([{ files: [] }]);
    assert.throws(
      () => resolveNpmPackageFiles(fixture.packageDir, fakeExec),
      /empty publishable file list/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tracked-tree scanner reports locations without echoing matched values", () => {
  const errors = [];
  const status = runForbiddenTokenCheck({
    repoRoot: "/tmp/example",
    tokens: [forbidden],
    exec: () => `docs/evidence.txt:7:/home/${forbidden}/runtime\n`,
    log: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(status, 1);
  assert.match(errors.join("\n"), /docs\/evidence\.txt:7:\[REDACTED forbidden token\]/);
  assert.doesNotMatch(errors.join("\n"), new RegExp(forbidden, "i"));
});

test("canonical release path preserves the publishable-package forbidden-token gate", () => {
  const releaseScript = readFileSync(join(import.meta.dirname, "release.sh"), "utf8");
  const buildInvocations = releaseScript
    .split(/\r?\n/)
    .filter((line) => line.includes("scripts/build-npm.sh"));

  assert.deepEqual(buildInvocations, ['"$REPO_ROOT/scripts/build-npm.sh" --skip-typecheck']);
  assert.doesNotMatch(releaseScript, /build-npm\.sh[^\n]*--skip-checks/);
});
