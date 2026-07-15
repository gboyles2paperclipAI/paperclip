#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} result is missing or malformed`);
  }
}

export function summarizeNpmAudit(report) {
  const counts = report?.metadata?.vulnerabilities;
  const required = ["info", "low", "moderate", "high", "critical", "total"];
  if (!counts || required.some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)) {
    throw new Error("npm audit result has no valid vulnerability summary");
  }
  return Object.fromEntries(required.map((key) => [key, counts[key]]));
}

export function summarizeOsv(report) {
  if (!report || !Array.isArray(report.results)) {
    throw new Error("OSV result has no results array");
  }
  const findings = [];
  for (const result of report.results) {
    if (!Array.isArray(result?.packages)) throw new Error("OSV result contains malformed packages");
    for (const entry of result.packages) {
      if (!Array.isArray(entry?.vulnerabilities)) {
        throw new Error("OSV package result has no vulnerabilities array");
      }
      for (const vulnerability of entry.vulnerabilities) {
        if (typeof vulnerability?.id !== "string" || !vulnerability.id) {
          throw new Error("OSV vulnerability is missing its id");
        }
        findings.push({
          id: vulnerability.id,
          package: entry.package?.name ?? "unknown",
          version: entry.package?.version ?? "unknown",
        });
      }
    }
  }
  return findings.sort((left, right) =>
    `${left.id}\0${left.package}\0${left.version}`.localeCompare(
      `${right.id}\0${right.package}\0${right.version}`,
    ));
}

export function summarizeGrype(report) {
  if (!report?.descriptor?.version || !Array.isArray(report.matches)) {
    throw new Error("Grype result is missing descriptor or matches");
  }
  const counts = { negligible: 0, low: 0, medium: 0, high: 0, critical: 0, unknown: 0 };
  for (const match of report.matches) {
    const severity = String(match?.vulnerability?.severity ?? "unknown").toLowerCase();
    const key = Object.hasOwn(counts, severity) ? severity : "unknown";
    counts[key] += 1;
  }
  return { version: report.descriptor.version, counts, total: report.matches.length };
}

export function verifyReleaseSecurity({ npmAudit, osv, grype }) {
  const npm = summarizeNpmAudit(npmAudit);
  const osvFindings = summarizeOsv(osv);
  const grypeSummary = summarizeGrype(grype);
  const blockers = [];
  if (npm.high > 0 || npm.critical > 0) {
    blockers.push(`npm audit reports ${npm.high} high and ${npm.critical} critical findings`);
  }
  if (osvFindings.length > 0) {
    blockers.push(`OSV reports ${osvFindings.length} unresolved findings`);
  }
  if (grypeSummary.counts.high > 0 || grypeSummary.counts.critical > 0) {
    blockers.push(
      `Grype reports ${grypeSummary.counts.high} high and ${grypeSummary.counts.critical} critical findings`,
    );
  }
  return {
    status: blockers.length === 0 ? "pass" : "fail",
    policy: {
      npmAudit: "no high or critical findings",
      osv: "no unresolved findings",
      grype: "no high or critical findings",
    },
    npmAudit: npm,
    osv: { total: osvFindings.length, findings: osvFindings },
    grype: grypeSummary,
    blockers,
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || args.has(flag)) {
      throw new Error("invalid security result arguments");
    }
    args.set(flag, value);
  }
  for (const flag of ["--npm-audit", "--osv", "--grype", "--output"]) {
    if (!args.has(flag)) throw new Error(`missing ${flag}`);
  }
  return args;
}

function main() {
  let outputPath;
  try {
    const args = parseArgs(process.argv.slice(2));
    outputPath = resolve(args.get("--output"));
    const summary = verifyReleaseSecurity({
      npmAudit: readJson(resolve(args.get("--npm-audit")), "npm audit"),
      osv: readJson(resolve(args.get("--osv")), "OSV"),
      grype: readJson(resolve(args.get("--grype")), "Grype"),
    });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (summary.status !== "pass") process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "security result verification failed";
    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify({ status: "error", blockers: [message] }, null, 2)}\n`);
    }
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
