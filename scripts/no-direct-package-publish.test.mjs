import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const textExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

export function findDirectPackagePublishOffenses(filePath, content) {
  if (/(?:^|\/)__tests__(?:\/|$)|\.test\.[^.]+$/.test(filePath)) return [];
  const offenses = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!/\b(?:npm|pnpm)\s+publish\b/i.test(line)) continue;
    const trimmed = line.trim().replace(/^[-*]\s+/, "").replace(/^>\s+/, "");
    const commandLike =
      /^(?:`{1,3}\s*)?(?:\$\s*)?(?:npm|pnpm)\s+publish\b/i.test(trimmed) ||
      /^if\s+(?:\([^;]+;\s*)?(?:npm|pnpm)\s+publish\b/i.test(trimmed) ||
      /(?:&&|;|\|\|)\s*(?:npm|pnpm)\s+publish\b/i.test(line) ||
      /\b(?:to publish|publish with|run to publish)\b[^\n]*(?:npm|pnpm)\s+publish\b/i.test(line);
    if (!commandLike) continue;

    const usesTarball = /(?:<tarball>|\$\{?tarball|[\w./-]+\.tgz\b)/i.test(line);
    const disablesLifecycle = /--ignore-scripts\b/.test(line);
    if (!usesTarball || !disablesLifecycle) {
      offenses.push(`${filePath}:${index + 1}`);
    }
  }
  return offenses;
}

function trackedDocumentationAndExecutableFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => textExtensions.has(extname(file)));
}

test("tracked documentation and executable output contains no direct directory publish command", () => {
  const offenses = trackedDocumentationAndExecutableFiles().flatMap((file) =>
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
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("doc/example.md", unsafe), [
    "doc/example.md:1",
    "doc/example.md:2",
    "doc/example.md:3",
    "doc/example.md:4",
  ]);
});

test("guard permits verified tarball helpers and non-command prose", () => {
  const safe = [
    'pnpm publish "$tarball_path" --ignore-scripts --access public',
    "`pnpm publish <tarball> --ignore-scripts --access public`",
    "Confirm npm publish succeeds without a long-lived token.",
  ].join("\n");
  assert.deepEqual(findDirectPackagePublishOffenses("doc/example.md", safe), []);
});
