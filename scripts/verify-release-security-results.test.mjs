import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeGrype,
  summarizeNpmAudit,
  summarizeOsv,
  verifyReleaseSecurity,
} from "./verify-release-security-results.mjs";

const cleanNpm = {
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 0, total: 2 } },
};
const cleanOsv = { results: [{ packages: [] }] };
const cleanGrype = { descriptor: { version: "0.110.0" }, matches: [] };

test("passes complementary results only when every scanner is well formed and within policy", () => {
  const summary = verifyReleaseSecurity({ npmAudit: cleanNpm, osv: cleanOsv, grype: cleanGrype });
  assert.equal(summary.status, "pass");
  assert.equal(summary.npmAudit.moderate, 2);
  assert.deepEqual(summary.blockers, []);
});

test("fails closed for high findings from npm or Grype and any unresolved OSV finding", () => {
  const summary = verifyReleaseSecurity({
    npmAudit: {
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    },
    osv: {
      results: [{ packages: [{ package: { name: "x", version: "1.0.0" }, vulnerabilities: [{ id: "GHSA-test" }] }] }],
    },
    grype: {
      descriptor: { version: "0.110.0" },
      matches: [{ vulnerability: { severity: "Critical" } }],
    },
  });
  assert.equal(summary.status, "fail");
  assert.equal(summary.blockers.length, 3);
});

test("rejects unavailable or malformed scanner output rather than treating it as clean", () => {
  assert.throws(() => summarizeNpmAudit({ error: "endpoint unavailable" }), /no valid/);
  assert.throws(() => summarizeOsv({}), /no results array/);
  assert.throws(() => summarizeGrype({ matches: [] }), /missing descriptor/);
});
