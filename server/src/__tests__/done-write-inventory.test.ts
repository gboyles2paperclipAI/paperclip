import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-20260823-quiescent-coordination R2.13: `issueService.update`
 * (server/src/services/issues.ts) is the sanctioned chokepoint for terminal
 * issue-status writes. Every OTHER `update(issues)` call whose `.set({...})`
 * block writes a terminal status literal ("done"/"cancelled") must be
 * classified in `services/decision-freeze-inventory.md`; a new uncovered site
 * fails this test until classified.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSrcRoot = path.resolve(testDir, "..");
const inventoryPath = path.join(serverSrcRoot, "services", "decision-freeze-inventory.md");
const SANCTIONED_CHOKEPOINT = "services/issues.ts";

const DONE_WRITE_CLASSIFICATIONS = new Set([
  "tree-control-cancel",
  "pipeline-cancel",
  "recovery-terminalization",
  "monitor-clear",
  "execution-policy-stage-commit",
]);

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const absolute = path.join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * `done:<relative-file>#<ordinal>` for every `update(issues)` site outside the
 * chokepoint whose set block (bounded by the following `.where(` or 600
 * characters) contains a terminal status literal.
 */
function findTerminalDoneWriteIdentifiers(): string[] {
  const identifiers: string[] = [];
  for (const absolute of listSourceFiles(serverSrcRoot)) {
    const relative = path.relative(serverSrcRoot, absolute).split(path.sep).join("/");
    if (relative === SANCTIONED_CHOKEPOINT) continue;
    const source = readFileSync(absolute, "utf8");
    let ordinal = 0;
    let searchFrom = 0;
    for (;;) {
      const found = source.indexOf("update(issues)", searchFrom);
      if (found < 0) break;
      searchFrom = found + 1;
      const whereIndex = source.indexOf(".where(", found);
      const windowEnd = Math.min(whereIndex >= 0 ? whereIndex : found + 600, found + 600);
      const window = source.slice(found, windowEnd);
      if (/status:\s*"(?:done|cancelled)"/.test(window)) {
        ordinal += 1;
        identifiers.push(`done:${relative}#${ordinal}`);
      }
    }
  }
  return identifiers;
}

function readInventoryRows(prefix: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of readFileSync(inventoryPath, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([a-z-]+)\s*\|/.exec(line);
    if (!match) continue;
    const [, identifier, classification] = match;
    if (!identifier!.startsWith(prefix)) continue;
    expect(rows.has(identifier!), `duplicate inventory row for ${identifier}`).toBe(false);
    rows.set(identifier!, classification!);
  }
  return rows;
}

describe("terminal done-write inventory (R2.13)", () => {
  it("classifies every terminal update(issues) write outside issueService.update", () => {
    const liveSites = findTerminalDoneWriteIdentifiers();
    const inventory = readInventoryRows("done:");

    const unclassified = liveSites.filter((site) => !inventory.has(site));
    expect(
      unclassified,
      "New or renumbered terminal-status update(issues) writes must be classified in "
      + "services/decision-freeze-inventory.md, or routed through issueService.update instead",
    ).toEqual([]);

    const liveSet = new Set(liveSites);
    const stale = [...inventory.keys()].filter((identifier) => !liveSet.has(identifier));
    expect(
      stale,
      "Inventory rows without a matching live terminal write must be removed from services/decision-freeze-inventory.md",
    ).toEqual([]);
  });

  it("uses only the sanctioned done-write classifications", () => {
    const inventory = readInventoryRows("done:");
    expect(inventory.size).toBeGreaterThan(0);
    for (const [identifier, classification] of inventory) {
      expect(
        DONE_WRITE_CLASSIFICATIONS.has(classification),
        `${identifier} has unknown classification "${classification}"`,
      ).toBe(true);
    }
  });

  it("keeps the sanctioned chokepoint in place", () => {
    const chokepointSource = readFileSync(path.join(serverSrcRoot, SANCTIONED_CHOKEPOINT), "utf8");
    // issueService.update must keep validating transitions — the reason it is
    // excluded from the scan is that it IS the guarded path.
    expect(chokepointSource).toContain("assertTransition(existing.status, issueData.status)");
  });
});
