import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePackageGitleaks } from "./filter-package-gitleaks.mjs";

const selectedText = ["S=w", "focus", "key"].join(".");
const matchedText = ["w", "anchor", "key,S=w", "focus", "key;"].join(".");
const baseFinding = {
  RuleID: "generic-api-key",
  Description: "Detected a Generic API Key",
  StartLine: 140,
  EndLine: 140,
  StartColumn: 10699,
  EndColumn: 10725,
  Secret: selectedText,
  Match: matchedText,
};
const policy = {
  schemaVersion: 1,
  exceptions: [{
    id: "lexical-minified-selection-anchor-focus",
    reason: "Known Lexical node-key assignment, not credential material.",
    ruleId: "generic-api-key",
    startLine: 140,
    endLine: 140,
    startColumn: 10699,
    endColumn: 10725,
    selectedTextDigest: "71723e5d2360083c2abb42f740b8661756160a848dfa564f7cee1af9d0da0237",
    matchedTextDigest: "99f9adebdb275562bdd1a5cdf8579d4a7cca22dacc434e7a7e4b3fd080b5b498",
    expectedPathPatterns: [
      "/package/ui-dist/assets/index-[A-Za-z0-9_-]+\\.js$",
      "/package/dist/assets/index-[A-Za-z0-9_-]+\\.js$",
    ],
  }],
};

function exactFindings() {
  return [
    { ...baseFinding, File: "/tmp/package-content/017/package/ui-dist/assets/index-ABC_123.js" },
    { ...baseFinding, File: "/tmp/package-content/030/package/dist/assets/index-ABC_123.js" },
  ];
}

test("accepts only the two exact independently reviewable package fingerprints", () => {
  const result = evaluatePackageGitleaks(exactFindings(), policy);
  assert.equal(result.status, "pass");
  assert.equal(result.remaining.length, 0);
  assert.equal(result.exclusions.length, 2);
  assert.deepEqual(result.policyErrors, []);
});

test("accepts zero package findings when the exception policy is empty", () => {
  const result = evaluatePackageGitleaks([], { schemaVersion: 1, exceptions: [] });
  assert.equal(result.status, "pass");
  assert.equal(result.remaining.length, 0);
  assert.equal(result.exclusions.length, 0);
  assert.deepEqual(result.policyErrors, []);
});

test("fails closed when the finding content drifts", () => {
  const findings = exactFindings();
  findings[0] = { ...findings[0], Secret: `${selectedText}x` };
  const result = evaluatePackageGitleaks(findings, policy);
  assert.equal(result.status, "blocked");
  assert.equal(result.remaining.length, 1);
  assert.match(result.policyErrors.join("\n"), /found 0/);
});

test("fails closed for an extra finding", () => {
  const result = evaluatePackageGitleaks([
    ...exactFindings(),
    { ...baseFinding, RuleID: "private-key", File: "/tmp/package-content/030/package/dist/other.js" },
  ], policy);
  assert.equal(result.status, "blocked");
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].Secret, "[REDACTED]");
  assert.equal(result.remaining[0].Match, "[REDACTED]");
});

test("fails closed when an expected duplicate package path is absent", () => {
  const result = evaluatePackageGitleaks(exactFindings().slice(0, 1), policy);
  assert.equal(result.status, "blocked");
  assert.match(result.policyErrors.join("\n"), /\/package\/dist/);
});
