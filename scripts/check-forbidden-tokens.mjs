#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans for forbidden tokens without echoing matched values. The default mode
 * mirrors the git pre-commit hook across the tracked tree. The
 * --npm-package-dir mode derives a preview publishable file set from
 * `npm pack --dry-run --json` and scans that package directory. The release
 * path performs its final check against the exact staged tarball instead.
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * Tokens combine explicit, stable account/path fragments with current-account
 * names only when bounded as host paths. Bare process account names are never
 * used because shared runners commonly use ordinary words such as "runner".
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function resolveBoundedHostPathTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];
  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // A release caller still fails closed if no explicit or bounded token exists.
  }
  return uniqueNonEmpty(candidates)
    .filter((account) => /^[A-Za-z0-9._-]+$/.test(account))
    .flatMap((account) => [
      `/home/${account}/`,
      `/Users/${account}/`,
      `C:\\Users\\${account}\\`,
    ]);
}

export function readPathExcludesFile(excludesFile) {
  if (!existsSync(excludesFile)) return [];

  return readFileSync(excludesFile, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter(Boolean);
}

export function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...readForbiddenTokensFile(tokensFile),
    ...resolveBoundedHostPathTokens(env, osModule),
  ]);
}

export function resolvePathExcludes(repoRoot) {
  return readPathExcludesFile(join(repoRoot, "scripts/forbidden-tokens-path-excludes.txt"));
}

function redactDiagnosticPath(path, normalizedTokens, fallback) {
  const normalizedPath = path.toLocaleLowerCase("en-US");
  return normalizedTokens.some((token) => normalizedPath.includes(token)) ? fallback : path;
}

export function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  pathExcludes = [],
  exec = spawnSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  const normalizedTokens = tokens.map((token) => token.toLocaleLowerCase("en-US"));
  let found = false;

  for (const token of tokens) {
    const gitGrepExcludes = [
      ":!pnpm-lock.yaml",
      ":!.git",
      ...pathExcludes.map((entry) => `:!${entry}`),
    ];
    let result;
    try {
      result = exec(
        "git",
        ["grep", "-in", "--no-color", "--", token, "--", ...gitGrepExcludes],
        { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      error("ERROR: Forbidden-token tracked-tree scan failed before it could complete safely.");
      return 2;
    }

    if (result?.error || result?.signal || ![0, 1].includes(result?.status)) {
      error("ERROR: Forbidden-token tracked-tree scan failed before it could complete safely.");
      return 2;
    }

    if (result.status === 0) {
      const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
      if (!output) {
        error("ERROR: Forbidden-token tracked-tree scan returned an invalid successful result.");
        return 2;
      }
      if (output) {
        if (!found) {
          error("ERROR: Forbidden tokens found in tracked files:\n");
        }
        found = true;
        const lines = output.split("\n");
        for (const line of lines) {
          const match = line.match(/^(.+?):(\d+):/);
          const displayPath = match
            ? redactDiagnosticPath(match[1], normalizedTokens, "[REDACTED tracked path]")
            : "tracked file";
          error(
            `  ${match ? `${displayPath}:${match[2]}` : displayPath}:[REDACTED forbidden token]`,
          );
        }
      }
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

function staysWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function resolveNpmPackageFiles(packageDir, exec = execFileSync) {
  const resolvedPackageDir = resolve(packageDir);
  const realPackageDir = realpathSync(resolvedPackageDir);
  const output = exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: resolvedPackageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let manifest;
  try {
    manifest = JSON.parse(output);
  } catch {
    throw new Error("npm pack dry-run did not return valid JSON");
  }

  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0]?.files)) {
    throw new Error("npm pack dry-run returned an unexpected manifest shape");
  }
  if (manifest[0].files.length === 0) {
    throw new Error("npm pack dry-run returned an empty publishable file list");
  }

  return uniqueNonEmpty(
    manifest[0].files.map((entry) => {
      if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
        throw new Error("npm pack dry-run returned an invalid file path");
      }

      const candidate = resolve(resolvedPackageDir, entry.path);
      if (!staysWithin(resolvedPackageDir, candidate)) {
        throw new Error("npm pack dry-run returned a path outside the package directory");
      }

      const realCandidate = realpathSync(candidate);
      if (!staysWithin(realPackageDir, realCandidate)) {
        throw new Error("npm pack dry-run resolved a file outside the package directory");
      }
      if (!statSync(realCandidate).isFile()) {
        throw new Error("npm pack dry-run returned a non-file entry");
      }
      return realCandidate;
    }),
  );
}

export function runForbiddenTokenFileCheck({
  files,
  tokens,
  displayRoot,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }
  if (!Array.isArray(files) || files.length === 0) {
    error("ERROR: Publishable forbidden-token scan received no files.");
    return 1;
  }

  const normalizedTokens = tokens.map((token) => token.toLocaleLowerCase("en-US"));
  let found = false;

  for (const file of files) {
    const displayPath = relative(displayRoot, file) || file;
    const safeDisplayPath = redactDiagnosticPath(
      displayPath,
      normalizedTokens,
      "[REDACTED publishable path]",
    );
    const pathContainsToken = safeDisplayPath !== displayPath;
    if (pathContainsToken) {
      if (!found) error("ERROR: Forbidden tokens found in publishable package files:\n");
      found = true;
      error(`  ${safeDisplayPath}:[REDACTED forbidden token]`);
    }

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lowerLine = lines[index].toLocaleLowerCase("en-US");
      for (const token of normalizedTokens) {
        if (!lowerLine.includes(token)) continue;
        if (!found) error("ERROR: Forbidden tokens found in publishable package files:\n");
        found = true;
        error(`  ${safeDisplayPath}:${index + 1}:[REDACTED forbidden token]`);
      }
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) from publishable package files.");
    return 1;
  }

  log(`  ✓  No forbidden tokens found in ${files.length} publishable package files.`);
  return 0;
}

function resolveRepoPaths(exec = execFileSync) {
  const repoRoot = exec("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const gitCommonDir = exec("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitCommonDir, "hooks/forbidden-tokens.txt"),
  };
}

function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  if (process.argv.length === 4 && process.argv[2] === "--npm-package-dir") {
    const packageDir = resolve(repoRoot, process.argv[3]);
    try {
      const files = resolveNpmPackageFiles(packageDir);
      process.exit(runForbiddenTokenFileCheck({ files, tokens, displayRoot: repoRoot }));
    } catch {
      console.error(
        "ERROR: Publishable forbidden-token scan could not safely enumerate package files.",
      );
      process.exit(1);
    }
  }
  if (process.argv.length !== 2) {
    console.error("Usage: check-forbidden-tokens.mjs [--npm-package-dir <path>]");
    process.exit(2);
  }
  const pathExcludes = resolvePathExcludes(repoRoot);
  process.exit(runForbiddenTokenCheck({ repoRoot, tokens, pathExcludes }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
