#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "server/src",
  "ui/src",
  "packages",
  "cli/src",
  "scripts",
];

const DEFAULT_SCAN_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
];

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".sh",
  ".css",
  ".html",
  ".yml",
  ".yaml",
]);

const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".paperclip",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

const SKIP_FILENAME_SUFFIXES = [
  ".d.ts",
  ".map",
];

const WORKSPACE_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

const PAPERCLIP_PACKAGE_PATTERN = /(?:from\s+["']|import\s*\(\s*["'])(@paperclipai\/[^/"']+(?:\/[^"']+)?)["']/g;

export const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/;

function toRepoRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function shouldScanFile(relativePath) {
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  return SCANNABLE_EXTENSIONS.has(path.extname(relativePath));
}

export function collectScannableSourceFiles({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  scanFiles = DEFAULT_SCAN_FILES,
} = {}) {
  const results = [];
  const seen = new Set();

  function addFile(absolutePath) {
    const relativePath = toRepoRelative(repoRoot, absolutePath);
    if (seen.has(relativePath) || !shouldScanFile(relativePath)) return;
    seen.add(relativePath);
    results.push({ absolutePath, relativePath });
  }

  for (const relativeFile of scanFiles) {
    const absoluteFile = path.resolve(repoRoot, relativeFile);
    try {
      if (statSync(absoluteFile).isFile()) addFile(absoluteFile);
    } catch {
      // Missing optional root files are fine.
    }
  }

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(repoRoot, scanRoot);
    let rootStats;
    try {
      rootStats = statSync(absoluteRoot);
    } catch {
      continue;
    }
    if (!rootStats.isDirectory()) continue;

    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absoluteEntry = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
          stack.push(absoluteEntry);
          continue;
        }
        if (entry.isFile()) addFile(absoluteEntry);
      }
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function findConflictMarkerOffenses(text) {
  const lines = text.split(/\r?\n/);
  const offenses = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (CONFLICT_MARKER_PATTERN.test(lines[index])) {
      offenses.push({ lineNumber: index + 1 });
    }
  }
  return offenses;
}

export function scanConflictMarkers({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  scanFiles = DEFAULT_SCAN_FILES,
} = {}) {
  const offenses = [];
  for (const file of collectScannableSourceFiles({ repoRoot, scanRoots, scanFiles })) {
    let text;
    try {
      text = readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    for (const offense of findConflictMarkerOffenses(text)) {
      offenses.push({ relativePath: file.relativePath, lineNumber: offense.lineNumber });
    }
  }
  return offenses;
}

export function getUnresolvedGitPaths({ repoRoot } = {}) {
  let output;
  try {
    output = execFileSync("git", ["-C", repoRoot, "diff", "--name-only", "--diff-filter=U", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, paths: [] };
  }

  const paths = output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();
  return { ok: true, paths };
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readServerStartScript({ repoRoot, serverPackagePath = "server/package.json" } = {}) {
  try {
    const pkg = readJsonFile(path.resolve(repoRoot, serverPackagePath));
    return typeof pkg.scripts?.start === "string" ? pkg.scripts.start : null;
  } catch {
    return null;
  }
}

// Returns 'node-dist' | 'tsx-src' | 'unknown'
export function classifyStartCommand(startScript) {
  if (typeof startScript !== "string" || !startScript) return "unknown";
  // node dist/…  — compiled-only runtime; TS source exports are fatal
  if (/\bnode\b/.test(startScript) && /\bdist\//.test(startScript)) return "node-dist";
  // tsx src/… — TypeScript-aware runtime; TS source exports are fine
  if (/\btsx\b/.test(startScript) && !/\bnode\b/.test(startScript)) return "tsx-src";
  return "unknown";
}

function isWorkspaceRange(range) {
  return typeof range === "string" && range.startsWith("workspace:");
}

function collectWorkspaceManifests(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const manifests = [];

  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "tmp" || entry.name === ".git") continue;

      const absolutePath = path.join(directory, entry.name);
      const manifestPath = path.join(absolutePath, "package.json");
      if (existsSync(manifestPath)) manifests.push(manifestPath);
      walk(absolutePath);
    }
  }

  if (existsSync(packagesRoot)) walk(packagesRoot);
  return manifests.sort();
}

function collectWorkspaceDependencyNames(pkg) {
  const names = [];
  for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
    const dependencies = pkg[field] ?? {};
    for (const [name, range] of Object.entries(dependencies)) {
      if (isWorkspaceRange(range)) names.push(name);
    }
  }
  return names.sort();
}

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split("/");
  if (parts.length < 2 || parts[0] !== "@paperclipai") return null;
  return `${parts[0]}/${parts[1]}`;
}

function collectBuiltServerImportPackageNames(repoRoot) {
  const distRoot = path.join(repoRoot, "server", "dist");
  const packageNames = new Set();

  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

      let source;
      try {
        source = readFileSync(absolutePath, "utf8");
      } catch {
        continue;
      }

      for (const match of source.matchAll(PAPERCLIP_PACKAGE_PATTERN)) {
        const packageName = packageNameFromSpecifier(match[1]);
        if (packageName) packageNames.add(packageName);
      }
    }
  }

  if (existsSync(distRoot)) walk(distRoot);
  return [...packageNames].sort();
}

export function collectRuntimeWorkspacePackages({ repoRoot, serverPackagePath = "server/package.json" } = {}) {
  const workspacePackages = new Map();
  for (const manifestPath of collectWorkspaceManifests(repoRoot)) {
    const pkg = readJsonFile(manifestPath);
    if (typeof pkg.name === "string") {
      workspacePackages.set(pkg.name, {
        pkg,
        manifestPath,
        relativePath: toRepoRelative(repoRoot, manifestPath),
      });
    }
  }

  const serverPkg = readJsonFile(path.resolve(repoRoot, serverPackagePath));
  const queue = [
    ...collectWorkspaceDependencyNames(serverPkg),
    ...collectBuiltServerImportPackageNames(repoRoot),
  ].sort();
  const seen = new Set();
  const runtimePackages = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const workspacePackage = workspacePackages.get(name);
    if (!workspacePackage) continue;

    runtimePackages.push(workspacePackage);
    for (const dependencyName of collectWorkspaceDependencyNames(workspacePackage.pkg)) {
      if (!seen.has(dependencyName)) queue.push(dependencyName);
    }
  }

  return runtimePackages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isSourceTypeScriptExportTarget(value) {
  return typeof value === "string" && value.startsWith("./src/") && value.endsWith(".ts");
}

function isDevelopmentOnlyCondition(conditionPath) {
  return conditionPath.includes("development");
}

export function findRuntimeSourceExportOffenses(exportsField) {
  const offenses = [];

  function visit(value, exportPath, conditionPath) {
    if (typeof value === "string") {
      if (isSourceTypeScriptExportTarget(value) && !isDevelopmentOnlyCondition(conditionPath)) {
        offenses.push({
          exportPath,
          conditions: conditionPath,
          target: value,
        });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${exportPath}[${index}]`, conditionPath));
      return;
    }

    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "types") continue;
      const nextConditionPath = key.startsWith(".") ? conditionPath : [...conditionPath, key];
      const nextExportPath = key.startsWith(".") ? key : exportPath;
      visit(child, nextExportPath, nextConditionPath);
    }
  }

  visit(exportsField, ".", []);
  return offenses;
}

function findMissingLiteralRuntimeExportTargets({ packageRoot, exportsField }) {
  const offenses = [];
  const seen = new Set();

  function visit(value, exportPath, conditionPath) {
    if (typeof value === "string") {
      if (
        !isDevelopmentOnlyCondition(conditionPath) &&
        value.startsWith("./dist/") &&
        value.endsWith(".js") &&
        !value.includes("*")
      ) {
        const absoluteTarget = path.resolve(packageRoot, value);
        if (!seen.has(absoluteTarget) && !existsSync(absoluteTarget)) {
          seen.add(absoluteTarget);
          offenses.push({
            exportPath,
            conditions: conditionPath,
            target: value,
          });
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${exportPath}[${index}]`, conditionPath));
      return;
    }

    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "types") continue;
      const nextConditionPath = key.startsWith(".") ? conditionPath : [...conditionPath, key];
      const nextExportPath = key.startsWith(".") ? key : exportPath;
      visit(child, nextExportPath, nextConditionPath);
    }
  }

  visit(exportsField, ".", []);
  return offenses;
}

export function scanRuntimeWorkspaceExports({ repoRoot, serverPackagePath = "server/package.json" } = {}) {
  const sourceExportOffenses = [];
  const missingDistExportTargets = [];

  for (const workspacePackage of collectRuntimeWorkspacePackages({ repoRoot, serverPackagePath })) {
    const exportsField = workspacePackage.pkg.exports;
    if (!exportsField) continue;

    for (const offense of findRuntimeSourceExportOffenses(exportsField)) {
      sourceExportOffenses.push({
        packageName: workspacePackage.pkg.name,
        manifestPath: workspacePackage.relativePath,
        ...offense,
      });
    }

    const packageRoot = path.dirname(workspacePackage.manifestPath);
    for (const offense of findMissingLiteralRuntimeExportTargets({ packageRoot, exportsField })) {
      missingDistExportTargets.push({
        packageName: workspacePackage.pkg.name,
        manifestPath: workspacePackage.relativePath,
        ...offense,
      });
    }
  }

  return { sourceExportOffenses, missingDistExportTargets };
}

export function runRuntimeSourcePreflight({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  scanFiles = DEFAULT_SCAN_FILES,
  log = console.log,
  error = console.error,
  runtimeManifestsOnly = false,
  serverPackagePath = "server/package.json",
} = {}) {
  const conflictMarkers = runtimeManifestsOnly ? [] : scanConflictMarkers({ repoRoot, scanRoots, scanFiles });
  const unresolvedGit = runtimeManifestsOnly ? { ok: true, paths: [] } : getUnresolvedGitPaths({ repoRoot });
  const runtimeWorkspaceExports = scanRuntimeWorkspaceExports({ repoRoot, serverPackagePath });
  const startScript = readServerStartScript({ repoRoot, serverPackagePath });
  const startKind = classifyStartCommand(startScript);
  let failed = false;

  if (!unresolvedGit.ok) {
    failed = true;
    error("ERROR: unable to verify unresolved Git merge paths.");
    error(`  ${unresolvedGit.error}`);
  } else if (unresolvedGit.paths.length > 0) {
    failed = true;
    error("ERROR: unresolved Git merge paths found:");
    for (const relativePath of unresolvedGit.paths) {
      error(`  ${relativePath}`);
    }
  }

  if (conflictMarkers.length > 0) {
    failed = true;
    error("ERROR: conflict markers found in runtime source files:");
    for (const offense of conflictMarkers) {
      error(`  ${offense.relativePath}:${offense.lineNumber}`);
    }
  }

  if (startKind === "node-dist" && runtimeWorkspaceExports.sourceExportOffenses.length > 0) {
    failed = true;
    error(`ERROR: start command uses compiled dist ("${startScript}") but workspace package exports resolve to source TypeScript — node cannot load TS source:`);
    for (const offense of runtimeWorkspaceExports.sourceExportOffenses) {
      const conditions = offense.conditions.length > 0 ? ` conditions=${offense.conditions.join(",")}` : "";
      error(`  ${offense.manifestPath} ${offense.packageName} ${offense.exportPath}${conditions} -> ${offense.target}`);
    }
    error(`  Fix: change server/package.json "start" to "tsx src/index.ts", or update workspace package exports to compiled dist.`);
  }

  if (runtimeWorkspaceExports.missingDistExportTargets.length > 0) {
    failed = true;
    error("ERROR: runtime workspace package exports point at missing dist files:");
    for (const offense of runtimeWorkspaceExports.missingDistExportTargets) {
      const conditions = offense.conditions.length > 0 ? ` conditions=${offense.conditions.join(",")}` : "";
      error(`  ${offense.manifestPath} ${offense.packageName} ${offense.exportPath}${conditions} -> ${offense.target}`);
    }
  }

  if (failed) {
    error("\nRefusing to start, restart, or promote Paperclip from unsafe runtime source.");
    return 1;
  }

  log(`  ✓  Runtime source preflight passed: no unresolved Git paths, conflict markers, or start-command/package-export mismatches found. (start: ${startKind})`);
  return 0;
}

function parseArgs(argv) {
  let repoRoot = process.cwd();
  const scanRoots = [];
  const scanFiles = [];
  let runtimeManifestsOnly = false;
  let serverPackagePath = "server/package.json";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      repoRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--scan-root") {
      scanRoots.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--scan-file") {
      scanFiles.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--server-package") {
      serverPackagePath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log("Usage: node scripts/runtime-source-preflight.mjs [--repo-root PATH] [--runtime-manifests-only] [--scan-root PATH] [--scan-file PATH] [--server-package PATH]");
      process.exit(0);
    }
    if (arg === "--runtime-manifests-only") {
      runtimeManifestsOnly = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }

  if (!repoRoot) {
    console.error("--repo-root requires a path");
    process.exit(2);
  }

  if (!serverPackagePath) {
    console.error("--server-package requires a path");
    process.exit(2);
  }

  return {
    repoRoot: path.resolve(repoRoot),
    scanRoots: scanRoots.length > 0 ? scanRoots : DEFAULT_SCAN_ROOTS,
    scanFiles: scanFiles.length > 0 ? scanFiles : DEFAULT_SCAN_FILES,
    runtimeManifestsOnly,
    serverPackagePath,
  };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runRuntimeSourcePreflight(parseArgs(process.argv.slice(2))));
}
