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

function tokenizeCommand(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) ?? [];
}

function isPublishToken(token) {
  return /^publish(?:["',.:-])?$/i.test(token ?? "");
}

function findPublishSubcommand(tokens) {
  if (!/^(?:npm|pnpm)["']?$/i.test(tokens[0] ?? "")) return -1;
  for (let index = 1; index < tokens.length; ) {
    const token = tokens[index];
    if (isPublishToken(token)) return index;
    if (token === "--") {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return -1;

    if (token.includes("=") || tokens[index + 1]?.startsWith("-")) {
      index += 1;
      continue;
    }
    if (tokens[index + 1] && !isPublishToken(tokens[index + 1])) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return -1;
}

function isVerifiedTarballPublishCommand(command) {
  const tokens = tokenizeCommand(command);
  const publishIndex = findPublishSubcommand(tokens);
  if (publishIndex === -1) return null;
  const operand = tokens[publishIndex + 1];
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
  for (let index = publishIndex + 2; index < tokens.length; index += 1) {
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

function logicalLines(content) {
  const physicalLines = content.split(/\r?\n/);
  const lines = [];
  for (let index = 0; index < physicalLines.length; index += 1) {
    const lineNumber = index + 1;
    let text = physicalLines[index];
    while (text.endsWith("\\") && index + 1 < physicalLines.length) {
      text = `${text.slice(0, -1)}${physicalLines[index + 1]}`;
      index += 1;
    }
    lines.push({ lineNumber, text });
  }
  return lines;
}

function canonicalLiteralFragments(source) {
  const text = source.trim();
  const fragments = [...text.matchAll(/(["'`])([^"'`]*)\1/g)];
  if (fragments.length === 0) return null;
  let offset = 0;
  let value = "";
  for (const fragment of fragments) {
    const separator = text.slice(offset, fragment.index);
    if (offset === 0 ? separator.trim() : !/^\s*\+\s*$/.test(separator)) return null;
    value += fragment[2];
    offset = fragment.index + fragment[0].length;
  }
  if (text.slice(offset).trim()) return null;
  return value.toLowerCase();
}

function findProgrammaticPackagePublishOffenses(filePath, content) {
  const offenses = [];
  const directChildProcessCall =
    /\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync|Async)?|execa(?:Sync)?)\s*\(\s*([\s\S]{1,120}?)\s*,\s*\[\s*([\s\S]{1,120}?)(?:,|\])/g;
  for (const match of content.matchAll(directChildProcessCall)) {
    if (
      /^(?:npm|pnpm)$/.test(canonicalLiteralFragments(match[1]) ?? "") &&
      canonicalLiteralFragments(match[2]) === "publish"
    ) {
      const lineNumber = content.slice(0, match.index).split(/\r?\n/).length;
      offenses.push(`${filePath}:${lineNumber}`);
    }
  }
  return offenses;
}

export function findDirectPackagePublishOffenses(filePath, content) {
  if (/(?:^|\/)__tests__(?:\/|$)|\.test\.[^.]+$/.test(filePath)) return [];
  const offenses = new Set(findProgrammaticPackagePublishOffenses(filePath, content));
  for (const { lineNumber, text } of logicalLines(content)) {
    const canonicalText = text.replace(/["']/g, "");
    const matches = [...canonicalText.matchAll(/\b(?:npm|pnpm)\b/gi)];
    let unsafe = false;
    for (const match of matches) {
      const remaining = canonicalText.slice(match.index);
      const separatorIndex = remaining.search(/&&|\|\||[|&;#`)]|\s\d*>/);
      const command = separatorIndex === -1 ? remaining : remaining.slice(0, separatorIndex);
      if (isVerifiedTarballPublishCommand(command) === false) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) {
      offenses.add(`${filePath}:${lineNumber}`);
    }
  }
  return [...offenses].sort((left, right) => {
    const leftLine = Number(left.slice(left.lastIndexOf(":") + 1));
    const rightLine = Number(right.slice(right.lastIndexOf(":") + 1));
    return leftLine - rightLine;
  });
}

export function trackedTextFiles(exec = spawnSync) {
  const result = exec(
    "git",
    ["grep", "-Ilz", "-e", "", "--", "."],
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
  const offenses = trackedTextFiles().flatMap((file) =>
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
    "pnpm --dir cli publish verified.tgz --ignore-scripts --access public",
    '"pnpm" publish verified.tgz --ignore-scripts',
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

test("global options and shell continuations cannot hide a direct directory publish", () => {
  const unsafe = [
    "npm --prefix cli publish --access public",
    "pnpm --dir cli publish --access public",
    "pnpm -C cli publish --access public",
    "pnpm --filter paperclipai publish --access public",
    "npm -- publish . --access public",
    "pnpm -- publish . --access public",
    '\"npm\" publish . --access public',
    "'pnpm' publish . --access public",
    "npm \\",
    "publish . --access public",
    "np\\",
    "m pub\\",
    "lish . --access public",
    'n"pm" pub"lish" . --access public',
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("scripts/example.sh", unsafe), [
    "scripts/example.sh:1",
    "scripts/example.sh:2",
    "scripts/example.sh:3",
    "scripts/example.sh:4",
    "scripts/example.sh:5",
    "scripts/example.sh:6",
    "scripts/example.sh:7",
    "scripts/example.sh:8",
    "scripts/example.sh:9",
    "scripts/example.sh:11",
    "scripts/example.sh:14",
  ]);
});

test("literal child-process publication calls cannot bypass the canonical helpers", () => {
  const source = [
    'spawnSync("npm", ["publish", "."]);',
    'execFileSync("pnpm", ["publish", "."]);',
    'execa("n" + "pm", ["pub" + "lish", "verified.tgz", "--ignore-scripts"]);',
    'spawn("pnpm", ["publish", "verified.tgz", "--ignore-scripts"]);',
    'spawnSync("npm", ["view", "paperclipai"]);',
    'spawnSync(command, args);',
    'commandRunner("pnpm", publishArgs);',
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("scripts/example.mjs", source), [
    "scripts/example.mjs:1",
    "scripts/example.mjs:2",
    "scripts/example.mjs:3",
    "scripts/example.mjs:4",
  ]);
});

test("tracked-text enumeration treats only git-grep status 1 as an empty set", () => {
  const options = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const args = ["grep", "-Ilz", "-e", "", "--", "."];
  assert.deepEqual(
    trackedTextFiles((command, actualArgs, actualOptions) => {
      assert.equal(command, "git");
      assert.deepEqual(actualArgs, args);
      assert.deepEqual(actualOptions, options);
      return { status: 1, stdout: "", stderr: "" };
    }),
    [],
  );
  assert.throws(
    () =>
      trackedTextFiles(() => ({
        status: 2,
        stdout: "",
        stderr: "fatal detail that must not be surfaced",
      })),
    /scan failed before completion/,
  );
  assert.throws(
    () =>
      trackedTextFiles(() => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
    /invalid successful result/,
  );
});
