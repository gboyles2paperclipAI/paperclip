import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const serverRoot = path.join(repoRoot, "server");
const distRoot = path.join(repoRoot, "server", "dist");
const staticImportPattern =
  /\bimport\s+([^;]*?)\s+from\s+["'](@paperclipai\/[^"']+)["']/g;

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
    }),
  );
  return files.flat();
}

function parseNamedImports(importClause) {
  const namedBlock = importClause.match(/\{([\s\S]*?)\}/);
  if (!namedBlock) {
    return [];
  }

  return namedBlock[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);
}

async function collectWorkspaceNamedImports() {
  const byPackage = new Map();
  const files = await listJsFiles(distRoot);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(staticImportPattern)) {
      const [, importClause, packageName] = match;
      const namedImports = parseNamedImports(importClause);
      if (namedImports.length === 0) {
        continue;
      }

      let packageImports = byPackage.get(packageName);
      if (!packageImports) {
        packageImports = new Map();
        byPackage.set(packageName, packageImports);
      }

      const relativeFile = path.relative(repoRoot, file);
      for (const exportName of namedImports) {
        const importingFiles = packageImports.get(exportName) ?? new Set();
        importingFiles.add(relativeFile);
        packageImports.set(exportName, importingFiles);
      }
    }
  }

  return byPackage;
}

function formatFiles(files) {
  return [...files].sort().join(", ");
}

function loadProductionExportKeys(packageName) {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=production",
      "--input-type=module",
      "--eval",
      "const mod = await import(process.argv[1]); console.log(JSON.stringify(Object.keys(mod).sort()));",
      packageName,
    ],
    {
      cwd: serverRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout).trim().split("\n")[0],
    };
  }

  return { ok: true, keys: JSON.parse(result.stdout) };
}

const importsByPackage = await collectWorkspaceNamedImports();
let failed = false;

for (const [packageName, namedImports] of [...importsByPackage].sort()) {
  const exportResult = loadProductionExportKeys(packageName);

  if (!exportResult.ok) {
    failed = true;
    console.log(`${packageName}: fail`);
    console.log(`  could not load production exports: ${exportResult.error}`);
    continue;
  }

  const exportedNames = new Set(exportResult.keys);
  const missing = [...namedImports]
    .filter(([exportName]) => !exportedNames.has(exportName))
    .sort(([a], [b]) => a.localeCompare(b));

  console.log(`${packageName}: ${missing.length === 0 ? "pass" : "fail"}`);

  if (missing.length > 0) {
    failed = true;
    for (const [exportName, importingFiles] of missing) {
      console.log(`  missing ${exportName}`);
      console.log(`    imported by ${formatFiles(importingFiles)}`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
}
