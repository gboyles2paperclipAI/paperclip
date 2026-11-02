import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const scriptsRoot = import.meta.dirname;

function source(name) {
  return readFileSync(join(scriptsRoot, name), "utf8");
}

test("governed release shell searches use the SH-9 quiet primitive", () => {
  const build = source("build-help2day-release-evidence.sh");
  const integrity = source("verify-package-integrity.sh");
  const proof = source("prove-isolated-release-runtime.sh");

  for (const contents of [build, integrity, proof]) {
    assert.doesNotMatch(contents, /(^|[;&|]\s*|\bif\s+)(?:grep|rg)(?:\s|$)/m);
  }
  assert.match(build, /sh9-quiet-search[.]mjs --regex/);
  assert.match(integrity, /sh9-quiet-search[.]mjs/);
  assert.match(proof, /sh9-quiet-search[.]mjs/);
  assert.doesNotMatch(integrity, /package[.]json[^\n]*(?:grep|rg)|(?:grep|rg)[^\n]*package[.]json/);
});

test("remaining find calls are documented filename-only inventories", () => {
  for (const name of [
    "build-help2day-release-evidence.sh",
    "prove-isolated-release-runtime.sh",
  ]) {
    const lines = source(name).split(/\r?\n/);
    const findLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*find\s/.test(line));
    assert.ok(findLines.length > 0);
    for (const { index } of findLines) {
      assert.match(lines[index - 1], /SH-9: filename-only/);
    }
  }
});
