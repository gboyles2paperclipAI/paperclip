import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function unquote(token) {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function isVerifiedTarballPublishCommand(command) {
  const prefix = command.match(/^\s*(?:npm|pnpm)\s+publish\b/i);
  if (!prefix) return false;
  const tokens = command
    .slice(prefix[0].length)
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map(unquote) ?? [];
  const operand = tokens.shift();
  if (
    !operand ||
    !(
      operand === "<tarball>" ||
      /^(?:\$tarball(?:_path)?|\$\{tarball(?:_path)?\})$/i.test(operand) ||
      (!operand.startsWith("-") && /(?:^|\/)[^/\s]+\.tgz$/i.test(operand))
    )
  ) {
    return false;
  }

  const booleanOptions = new Set(["--dry-run", "--ignore-scripts", "--no-git-checks"]);
  const valueOptions = new Set(["--access", "--tag"]);
  let disablesLifecycle = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (booleanOptions.has(token)) {
      if (token === "--ignore-scripts") disablesLifecycle = true;
      continue;
    }
    if (token === "--provenance=false") continue;
    if (valueOptions.has(token) && tokens[index + 1] && !tokens[index + 1].startsWith("--")) {
      index += 1;
      continue;
    }
    return false;
  }
  return disablesLifecycle;
}
export function findDirectPackagePublishOffenses(filePath, content) {
  if (/(?:^|\/)__tests__(?:\/|$)|\.test\.[^.]+$/.test(filePath)) return [];
  const offenses = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const matches = [...line.matchAll(/\b(?:npm|pnpm)\s+publish\b/gi)];
    let unsafe = false;
    for (const [matchIndex, match] of matches.entries()) {
      const nextPublishIndex = matches[matchIndex + 1]?.index ?? line.length;
      const remaining = line.slice(match.index, nextPublishIndex);
      const separatorIndex = remaining.search(/&&|\|\||[|&;#`]|\s\d*>/);
      const command = separatorIndex === -1 ? remaining : remaining.slice(0, separatorIndex);
      if (!isVerifiedTarballPublishCommand(command)) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) {
      offenses.push(`${filePath}:${index + 1}`);
    }
  }
  return offenses;
}

export function trackedFilesContainingPackagePublish(exec = spawnSync) {
  const result = exec(
    "git",
    ["grep", "-Ilz", "-E", "(npm|pnpm)[[:space:]]+publish", "--", "."],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result?.error || result?.signal || ![0, 1].includes(result?.status)) {
    throw new Error("tracked package-publication scan failed before completion");
  }
  if (result.status === 1) return [];
  const files = result.stdout.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("tracked package-publication scan returned an invalid successful result");
  }
  return files;
}

test("every tracked non-test package-publish line visibly uses a verified tarball", () => {
  const offenses = trackedFilesContainingPackagePublish().flatMap((file) =>
    findDirectPackagePublishOffenses(file, readFileSync(join(repoRoot, file), "utf8")),
  );
  assert.deepEqual(offenses, []);

  const buildOutput = readFileSync(join(repoRoot, "scripts/build-npm.sh"), "utf8");
  assert.doesNotMatch(buildOutput, /cd\s+cli[^\n]*(?:npm|pnpm)\s+publish/i);
  assert.match(buildOutput, /\.\/scripts\/release\.sh canary/);
  assert.match(buildOutput, /\.\/scripts\/release\.sh stable/);
});

test("guard catches direct shell, documentation, and generated-output publish instructions", () => {
  const unsafe = [
    "npm publish",
    "pnpm publish ./package --access public",
    "cd cli && npm publish --access public",
    'echo "To publish: cd cli && npm publish"',
    "Run npm publish --access public",
    "Then run npm publish",
    "sudo npm publish",
    "exec npm publish",
    "$(npm publish)",
    "command npm publish",
    "env NODE_ENV=production pnpm publish .",
    "sh -c 'npm publish --access public'",
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("doc/example.md", unsafe), [
    "doc/example.md:1",
    "doc/example.md:2",
    "doc/example.md:3",
    "doc/example.md:4",
    "doc/example.md:5",
    "doc/example.md:6",
    "doc/example.md:7",
    "doc/example.md:8",
    "doc/example.md:9",
    "doc/example.md:10",
    "doc/example.md:11",
    "doc/example.md:12",
  ]);
});

test("guard permits verified tarball helpers and non-command prose", () => {
  const safe = [
    'pnpm publish "$tarball_path" --ignore-scripts --access public',
    "`pnpm publish <tarball> --ignore-scripts --access public`",
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("doc/example.md", safe), []);
});

test("a safe command or comment cannot launder an unsafe publish on the same line", () => {
  const camouflaged = [
    "npm publish .; pnpm publish verified.tgz --ignore-scripts",
    "npm publish . || pnpm publish verified.tgz --ignore-scripts",
    "npm publish . # pnpm publish verified.tgz --ignore-scripts",
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("scripts/example.sh", camouflaged), [
    "scripts/example.sh:1",
    "scripts/example.sh:2",
    "scripts/example.sh:3",
  ]);
});

test("pipes, background commands, option values, and extra operands cannot mimic a tarball operand", () => {
  const camouflaged = [
    "npm publish . | echo verified.tgz --ignore-scripts",
    "npm publish . & echo verified.tgz --ignore-scripts",
    "npm publish . --tag verified.tgz --ignore-scripts",
    "npm publish --tag=verified.tgz --ignore-scripts",
    "pnpm publish verified.tgz . --ignore-scripts",
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("scripts/example.sh", camouflaged), [
    "scripts/example.sh:1",
    "scripts/example.sh:2",
    "scripts/example.sh:3",
    "scripts/example.sh:4",
    "scripts/example.sh:5",
  ]);
});

test("tracked-file enumeration treats only git-grep status 1 as an empty set", () => {
  const options = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const args = ["grep", "-Ilz", "-E", "(npm|pnpm)[[:space:]]+publish", "--", "."];
  assert.deepEqual(
    trackedFilesContainingPackagePublish((command, actualArgs, actualOptions) => {
      assert.equal(command, "git");
      assert.deepEqual(actualArgs, args);
      assert.deepEqual(actualOptions, options);
      return { status: 1, stdout: "", stderr: "" };
    }),
    [],
  );
  assert.throws(
    () =>
      trackedFilesContainingPackagePublish(() => ({
        status: 2,
        stdout: "",
        stderr: "fatal detail that must not be surfaced",
      })),
    /scan failed before completion/,
  );
  assert.throws(
    () =>
      trackedFilesContainingPackagePublish(() => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
    /invalid successful result/,
  );
});
