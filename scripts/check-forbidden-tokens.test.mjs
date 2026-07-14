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
import { getReleasePackages } from "./release-package-map.mjs";

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
    const rawRelativePath = `package/dist/${forbidden}-diagnostic.js`;
    writeFileSync(join(fixture.packageDir, "dist", `${forbidden}-diagnostic.js`), "export {};\n");
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
    const output = errors.join("\n");
    assert.match(output, /\[REDACTED publishable path\]/);
    assert.doesNotMatch(output, new RegExp(forbidden, "i"));
    assert.doesNotMatch(output, new RegExp(rawRelativePath, "i"));
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

test("tracked-tree scanner redacts token-bearing diagnostic paths", () => {
  const rawPath = `docs/${forbidden}-evidence.txt`;
  const errors = [];
  const status = runForbiddenTokenCheck({
    repoRoot: "/tmp/example",
    tokens: [forbidden],
    exec: () => `${rawPath}:7:/home/${forbidden}/runtime\n`,
    log: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(status, 1);
  const output = errors.join("\n");
  assert.match(output, /\[REDACTED tracked path\]:7:\[REDACTED forbidden token\]/);
  assert.doesNotMatch(output, new RegExp(forbidden, "i"));
  assert.doesNotMatch(output, new RegExp(rawPath, "i"));
});

test("canonical release path preserves the publishable-package forbidden-token gate", () => {
  const releaseScript = readFileSync(join(import.meta.dirname, "release.sh"), "utf8");
  const buildInvocations = releaseScript
    .split(/\r?\n/)
    .filter((line) => line.includes("scripts/build-npm.sh"));

  assert.deepEqual(buildInvocations, ['"$REPO_ROOT/scripts/build-npm.sh" --skip-typecheck']);
  assert.doesNotMatch(releaseScript, /build-npm\.sh[^\n]*--skip-checks/);
});

test("canonical release scans every enabled package before any publish command", () => {
  const releasePackages = getReleasePackages();
  assert.equal(releasePackages.length, 30);
  assert.equal(releasePackages.filter((pkg) => pkg.dir !== "cli").length, 29);

  const releaseScript = readFileSync(join(import.meta.dirname, "release.sh"), "utf8");
  const versionedInfoIndex = releaseScript.indexOf(
    'VERSIONED_PACKAGE_INFO="$(list_public_package_info)"',
  );
  const scanInvocation =
    'node "$REPO_ROOT/scripts/check-forbidden-tokens.mjs" --npm-package-dir "$REPO_ROOT/$pkg_dir"';
  const scanIndex = releaseScript.indexOf(scanInvocation);
  const scanLoopEndIndex = releaseScript.indexOf('done <<< "$VERSIONED_PACKAGE_INFO"', scanIndex);

  assert.notEqual(versionedInfoIndex, -1);
  assert.ok(scanIndex > versionedInfoIndex);
  assert.ok(scanLoopEndIndex > scanIndex);

  const publishCommands = [
    ...releaseScript.matchAll(/\bpnpm publish\b|\bpublish_package_to_npm\b/g),
  ];
  assert.ok(publishCommands.length > 0);
  assert.ok(
    publishCommands.every((match) => match.index > scanLoopEndIndex),
    "every dry-run or real publish must occur after the complete package-scan loop",
  );
});
