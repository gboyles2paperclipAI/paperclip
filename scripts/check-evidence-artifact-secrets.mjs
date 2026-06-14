#!/usr/bin/env node
/**
 * Guardrail for local debug/evidence artifacts.
 *
 * Evidence artifacts are often copied into issue comments or uploaded as work
 * products. This scanner fails on credential-shaped content but reports only
 * file path, line number, and rule id.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ARTIFACT_SECRET_RULES = [
  {
    id: "postgres-credential-uri",
    pattern: /\bpostgres(?:ql)?:\/\/[^/\s"'<>:@]+:[^@\s"'<>]+@[^)\s"'<>]+/i,
  },
  {
    id: "mysql-credential-uri",
    pattern: /\bmysql:\/\/[^/\s"'<>:@]+:[^@\s"'<>]+@[^)\s"'<>]+/i,
  },
  {
    id: "redis-credential-uri",
    pattern: /\bredis:\/\/(?::[^@\s"'<>]+|[^/\s"'<>:@]+:[^@\s"'<>]+)@[^)\s"'<>]+/i,
  },
  {
    id: "mongodb-credential-uri",
    pattern: /\bmongodb(?:\+srv)?:\/\/[^/\s"'<>:@]+:[^@\s"'<>]+@[^)\s"'<>]+/i,
  },
  {
    id: "authorization-bearer-value",
    pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    id: "secret-env-assignment",
    pattern: /\b(?:DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|POSTGRES_URL_NON_POOLING|SUPABASE_SERVICE_ROLE_KEY|VERCEL_TOKEN|PAPERCLIP_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s*=\s*['"]?[^'"\s]{16,}/,
  },
];

const DEFAULT_SCAN_ROOTS = ["."];
const SCANNABLE_EXTENSIONS = new Set([".md", ".txt", ".log", ".json", ".jsonl"]);
const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".paperclip",
  ".turbo",
  ".vercel",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);
const SKIP_DIRECTORY_PREFIXES = [".update-"];
const EVIDENCE_FILENAME_PATTERN =
  /(?:restart.*evidence|evidence.*restart|debug|diagnostic|stdout|stderr|run[-_.]?log|raw[-_.]?log|artifact|evidence|health.*out|out(?:put)?)/i;

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function shouldSkipDirectory(name) {
  return SKIP_DIRECTORY_NAMES.has(name) || SKIP_DIRECTORY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function shouldScanFile(relativePath) {
  const base = path.basename(relativePath);
  if (base.startsWith(".env")) return false;
  if (!SCANNABLE_EXTENSIONS.has(path.extname(base))) return false;
  return EVIDENCE_FILENAME_PATTERN.test(base) || relativePath.split("/").includes("artifacts");
}

export function collectEvidenceArtifactFiles({ repoRoot, scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const results = [];
  const seen = new Set();

  function addFile(absolutePath) {
    const relativePath = normalizeRelative(path.relative(repoRoot, absolutePath));
    if (seen.has(relativePath) || !shouldScanFile(relativePath)) return;
    seen.add(relativePath);
    results.push({ absolutePath, relativePath });
  }

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(repoRoot, scanRoot);
    let rootStats;
    try {
      rootStats = statSync(absoluteRoot);
    } catch {
      continue;
    }

    if (rootStats.isFile()) {
      addFile(absoluteRoot);
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
          if (shouldSkipDirectory(entry.name)) continue;
          stack.push(absoluteEntry);
          continue;
        }
        if (entry.isFile()) addFile(absoluteEntry);
      }
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function findArtifactSecretOffenses(text) {
  const offenses = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of ARTIFACT_SECRET_RULES) {
      if (rule.pattern.test(line)) {
        offenses.push({ lineNumber: index + 1, ruleId: rule.id });
      }
    }
  }

  return offenses;
}

export function scanEvidenceArtifacts({ repoRoot, scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const offenses = [];
  for (const file of collectEvidenceArtifactFiles({ repoRoot, scanRoots })) {
    let text;
    try {
      text = readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    for (const offense of findArtifactSecretOffenses(text)) {
      offenses.push({ relativePath: file.relativePath, ...offense });
    }
  }
  return offenses;
}

export function runEvidenceArtifactSecretCheck({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  log = console.log,
  error = console.error,
} = {}) {
  const offenses = scanEvidenceArtifacts({ repoRoot, scanRoots });
  if (offenses.length > 0) {
    error("ERROR: credential-shaped content found in evidence/debug artifact files:");
    for (const offense of offenses) {
      error(`  ${offense.relativePath}:${offense.lineNumber}: ${offense.ruleId}`);
    }
    error("\nArtifact content is intentionally omitted. Remove the artifact or regenerate it with secret-safe evidence.");
    return 1;
  }

  log("  ✓  No credential-shaped content found in evidence/debug artifact files.");
  return 0;
}

function parseArgs(argv) {
  let repoRoot = process.cwd();
  const scanRoots = [];

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
    if (arg === "-h" || arg === "--help") {
      console.log("Usage: node scripts/check-evidence-artifact-secrets.mjs [--repo-root PATH] [--scan-root PATH]");
      process.exit(0);
    }
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }

  if (!repoRoot) {
    console.error("--repo-root requires a path");
    process.exit(2);
  }

  return {
    repoRoot: path.resolve(repoRoot),
    scanRoots: scanRoots.length > 0 ? scanRoots : DEFAULT_SCAN_ROOTS,
  };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runEvidenceArtifactSecretCheck(parseArgs(process.argv.slice(2))));
}
