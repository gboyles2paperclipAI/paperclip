#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".py"]);
const DENIED_DIRECTORY_NAMES = new Set([".vercel", ".paperclip", ".codex", "shell_snapshots"]);
const DENIED_CODEX_HOME_NAMES = new Set(["shell_snapshots", "sessions", "cache", "tmp", ".tmp"]);
const RUNTIME_OUTPUT_NAME = /^\.[^.]+-(?:issue-out|comments-out|hbctx[^-]*-out|contract-out)(?:\.|$)/;
const TEMP_HELPER_NAME = /^(?:tmp-.*[.](?:js|mjs)|fix-.*[.](?:js|mjs)|ful.*-.*[.](?:sh|py)|[.](?:tmp|fix)-|[.]ful.*-)/;

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function isDeniedSh9Path(root, candidate) {
  const rel = relative(root, candidate);
  if (!isWithin(root, candidate) || rel === "") return rel !== "";
  const parts = rel.split(sep);

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const previous = parts[index - 1];
    if (DENIED_DIRECTORY_NAMES.has(part) || part.startsWith(".env") || part.startsWith(".update-")) {
      return true;
    }
    if (part === ".credentials.json" && previous === ".claude") return true;
    if (part === "sessions" && previous === ".claude") return true;
    if (part === "instances" && previous === "paperclip") return true;
    if (DENIED_CODEX_HOME_NAMES.has(part) && previous === "codex-home") return true;
    if (RUNTIME_OUTPUT_NAME.test(part) || TEMP_HELPER_NAME.test(part)) return true;
  }
  return false;
}

function compileMatcher({ literal, regex, flags = "" }) {
  if ((literal === undefined) === (regex === undefined)) {
    throw new Error("exactly one search expression is required");
  }
  if (literal !== undefined) return (contents) => contents.includes(literal);
  if (!/^[imsu]*$/.test(flags)) throw new Error("unsupported regular expression flags");
  const expression = new RegExp(regex, flags);
  return (contents) => expression.test(contents);
}

function fileContains(file, matcher) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("search target must be a regular file");
  return matcher(readFileSync(file, "utf8"));
}

export function searchExactFileQuiet({ file, literal, regex, flags }) {
  const matcher = compileMatcher({ literal, regex, flags });
  return fileContains(resolve(file), matcher);
}

export function searchSafeSourceTreeQuiet({ root, literal, regex, flags }) {
  const resolvedRoot = resolve(root);
  if (!lstatSync(resolvedRoot).isDirectory()) throw new Error("tree target must be a directory");
  const matcher = compileMatcher({ literal, regex, flags });
  const pending = [resolvedRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = resolve(current, entry.name);
      if (entry.isSymbolicLink() || isDeniedSh9Path(resolvedRoot, candidate)) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && SAFE_SOURCE_EXTENSIONS.has(extname(entry.name))) {
        if (fileContains(candidate, matcher)) return true;
      }
    }
  }
  return false;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--file", "--tree", "--literal", "--regex", "--flags"].includes(flag)) {
      throw new Error("invalid arguments");
    }
    options[flag.slice(2)] = value;
  }
  if ((options.file === undefined) === (options.tree === undefined)) {
    throw new Error("exactly one search target is required");
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const matched = options.file
      ? searchExactFileQuiet(options)
      : searchSafeSourceTreeQuiet({ root: options.tree, ...options });
    process.exit(matched ? 0 : 1);
  } catch {
    // SH-9: never echo a target path, expression, matched line, or caught error.
    process.stderr.write("ERROR: quiet search could not complete safely.\n");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
