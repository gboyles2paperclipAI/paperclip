import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\\\", "/");
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.exceptions)) {
    throw new Error("package Gitleaks policy must use schemaVersion 1 with an exceptions array");
  }
  const ids = new Set();
  for (const exception of policy.exceptions) {
    if (!exception?.id || ids.has(exception.id)) throw new Error("package Gitleaks exception ids must be unique");
    ids.add(exception.id);
    if (!exception.reason || !exception.ruleId) throw new Error(`${exception.id}: reason and ruleId are required`);
    if (!/^[0-9a-f]{64}$/.test(exception.selectedTextDigest ?? "")) {
      throw new Error(`${exception.id}: selectedTextDigest must be lowercase SHA-256`);
    }
    if (!/^[0-9a-f]{64}$/.test(exception.matchedTextDigest ?? "")) {
      throw new Error(`${exception.id}: matchedTextDigest must be lowercase SHA-256`);
    }
    if (!Array.isArray(exception.expectedPathPatterns) || exception.expectedPathPatterns.length === 0) {
      throw new Error(`${exception.id}: expectedPathPatterns must be non-empty`);
    }
    for (const pattern of exception.expectedPathPatterns) new RegExp(pattern);
  }
}

function sanitizedFinding(finding) {
  return {
    ...finding,
    File: normalizePath(finding.File),
    Secret: "[REDACTED]",
    Match: "[REDACTED]",
  };
}

function findingIdentity(finding) {
  return {
    ruleId: finding.RuleID,
    startLine: finding.StartLine,
    endLine: finding.EndLine,
    startColumn: finding.StartColumn,
    endColumn: finding.EndColumn,
    selectedTextDigest: sha256(finding.Secret),
    matchedTextDigest: sha256(finding.Match),
  };
}

function identityMatches(finding, exception) {
  const identity = findingIdentity(finding);
  return identity.ruleId === exception.ruleId
    && identity.startLine === exception.startLine
    && identity.endLine === exception.endLine
    && identity.startColumn === exception.startColumn
    && identity.endColumn === exception.endColumn
    && identity.selectedTextDigest === exception.selectedTextDigest
    && identity.matchedTextDigest === exception.matchedTextDigest;
}

export function evaluatePackageGitleaks(findings, policy) {
  if (!Array.isArray(findings)) throw new Error("package Gitleaks report must be a JSON array");
  validatePolicy(policy);

  const matchesByException = new Map(policy.exceptions.map((item) => [item.id, []]));
  const remaining = [];

  for (const finding of findings) {
    const file = normalizePath(finding.File);
    const candidates = policy.exceptions.filter((exception) => identityMatches(finding, exception));
    const pathMatches = candidates.flatMap((exception) => exception.expectedPathPatterns
      .map((pattern, patternIndex) => ({ exception, pattern, patternIndex }))
      .filter(({ pattern }) => new RegExp(pattern).test(file)));

    if (pathMatches.length !== 1) {
      remaining.push(sanitizedFinding(finding));
      continue;
    }

    const { exception, patternIndex } = pathMatches[0];
    matchesByException.get(exception.id).push({
      exceptionId: exception.id,
      expectedPathPattern: exception.expectedPathPatterns[patternIndex],
      file,
      ...findingIdentity(finding),
    });
  }

  const policyErrors = [];
  for (const exception of policy.exceptions) {
    const matches = matchesByException.get(exception.id);
    for (const pattern of exception.expectedPathPatterns) {
      const count = matches.filter((match) => match.expectedPathPattern === pattern).length;
      if (count !== 1) policyErrors.push(`${exception.id}: expected exactly one match for ${pattern}, found ${count}`);
    }
  }

  return {
    status: remaining.length === 0 && policyErrors.length === 0 ? "pass" : "blocked",
    remaining,
    exclusions: [...matchesByException.values()].flat(),
    policyErrors,
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
    args.set(key, value);
  }
  for (const required of ["--input", "--policy", "--report", "--exclusions"]) {
    if (!args.has(required)) throw new Error(`${required} is required`);
  }
  return args;
}

export function runCli(argv) {
  const args = parseArgs(argv);
  const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
  const policyText = readFileSync(args.get("--policy"), "utf8");
  const policy = JSON.parse(policyText);
  const result = evaluatePackageGitleaks(input, policy);

  writeFileSync(args.get("--report"), `${JSON.stringify(result.remaining, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(args.get("--exclusions"), `${JSON.stringify({
    schemaVersion: 1,
    status: result.status,
    policySha256: sha256(policyText),
    exclusions: result.exclusions,
    policyErrors: result.policyErrors,
    remainingFindingCount: result.remaining.length,
  }, null, 2)}\n`, { mode: 0o600 });

  return result.status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
