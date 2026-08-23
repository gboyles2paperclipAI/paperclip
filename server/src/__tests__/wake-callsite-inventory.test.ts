import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-20260823-quiescent-coordination R2.4: the implementation ships with a
 * checked-in inventory of every wake call site, each classified by the guard
 * that keeps it from piercing an active decision freeze. This grep test
 * derives the live call-site set from the source tree and fails when a site
 * is missing from `services/decision-freeze-inventory.md` (new unclassified
 * site), when the inventory lists a site that no longer exists (stale row),
 * or when a row uses an unknown classification.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSrcRoot = path.resolve(testDir, "..");
const inventoryPath = path.join(serverSrcRoot, "services", "decision-freeze-inventory.md");

const WAKE_GUARD_CLASSIFICATIONS = new Set([
  "wake-guard",
  "mutation-gate",
  "claim-recheck",
  "recovery-durable-wait",
  "routine-suppression",
  "bypass-only",
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
 * Broadened call matcher (stack-review H). Matches, per line:
 *  - `enqueueWakeup(` on ANY receiver (`deps.enqueueWakeup(`, bare, spaced);
 *  - `.wakeup(` on any receiver, with optional whitespace before `(`;
 *  - bracket access `["wakeup"](` / `['wakeup'](`;
 *  - a BARE `wakeup(` call (a destructured `const { wakeup } = heartbeat`
 *    alias invokes exactly this shape).
 *
 * Residual limits (documented honestly in decision-freeze-inventory.md):
 * a rename at the import/destructure/assignment boundary (`enqueueWakeup as
 * x`, `{ wakeup: x } =`, `const x = heartbeat.wakeup`) would produce calls
 * this matcher cannot see — so `findWakeAliasHazards` below FAILS the suite
 * on any such aliasing line instead of letting it slip; a name-and-paren
 * split across lines is also invisible to the per-line scan.
 */
const WAKE_CALL_PATTERN =
  /(?:\benqueueWakeup|\.\s*wakeup\b|\[\s*["']wakeup["']\s*\]|(?<![.\w$])wakeup\b)\s*\(/;
/** Definition shapes (not calls): declarations, method/property definitions. */
const WAKE_DEFINITION_PATTERN =
  /(?:function\s+(?:enqueueWakeup|wakeup)\b|\b(?:enqueueWakeup|wakeup)\??\s*:\s|\b(?:enqueueWakeup|wakeup)\s*=\s*(?:async\b\s*)?\()/;

function findWakeCallSiteIdentifiers(): string[] {
  const identifiers: string[] = [];
  for (const absolute of listSourceFiles(serverSrcRoot)) {
    const relative = path.relative(serverSrcRoot, absolute).split(path.sep).join("/");
    let ordinal = 0;
    for (const line of readFileSync(absolute, "utf8").split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) continue;
      if (/function enqueueWakeup/.test(line)) continue;
      if (WAKE_CALL_PATTERN.test(line) && !WAKE_DEFINITION_PATTERN.test(line)) {
        ordinal += 1;
        identifiers.push(`wake:${relative}#${ordinal}`);
      }
    }
  }
  return identifiers;
}

/**
 * Aliasing that would take future calls OUT of the matcher's sight fails the
 * suite loudly instead of walking around the inventory (stack-review H):
 *  - import/export renames of `enqueueWakeup`/`wakeup`;
 *  - destructure renames (`{ wakeup: other } = …`);
 *  - method-reference assignments (`const other = heartbeat.wakeup`).
 */
function findWakeAliasHazards(): string[] {
  const hazards: string[] = [];
  const aliasPatterns: RegExp[] = [
    /\b(?:enqueueWakeup|wakeup)\s+as\s+\w+/,
    /\bwakeup\s*:\s*\w+\s*[,}][^)]*\}\s*=/,
    /=\s*[\w$.]+\.\s*wakeup\s*(?:[,;)\]]|$)/,
    /=\s*enqueueWakeup\s*(?:[,;)\]]|$)/,
  ];
  for (const absolute of listSourceFiles(serverSrcRoot)) {
    const relative = path.relative(serverSrcRoot, absolute).split(path.sep).join("/");
    let lineNumber = 0;
    for (const line of readFileSync(absolute, "utf8").split("\n")) {
      lineNumber += 1;
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) continue;
      if (WAKE_CALL_PATTERN.test(line)) continue; // direct calls are inventoried above
      if (aliasPatterns.some((pattern) => pattern.test(line))) {
        hazards.push(`${relative}:${lineNumber}: ${stripped.slice(0, 120)}`);
      }
    }
  }
  return hazards;
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

describe("wake call-site inventory (R2.4)", () => {
  it("classifies every enqueueWakeup/.wakeup call site in server/src", () => {
    const liveSites = findWakeCallSiteIdentifiers();
    expect(liveSites.length).toBeGreaterThan(0);
    const inventory = readInventoryRows("wake:");

    const unclassified = liveSites.filter((site) => !inventory.has(site));
    expect(
      unclassified,
      "New or renumbered wake call sites must be classified in services/decision-freeze-inventory.md "
      + "(wake-guard | mutation-gate | claim-recheck | recovery-durable-wait | routine-suppression | bypass-only)",
    ).toEqual([]);

    const liveSet = new Set(liveSites);
    const stale = [...inventory.keys()].filter((identifier) => !liveSet.has(identifier));
    expect(
      stale,
      "Inventory rows without a matching live call site must be removed from services/decision-freeze-inventory.md",
    ).toEqual([]);
  });

  it("refuses wake-helper aliasing that would evade the call matcher", () => {
    expect(
      findWakeAliasHazards(),
      "Renaming/aliasing enqueueWakeup or .wakeup takes future call sites out of this inventory's "
      + "sight. Call the helper directly (any receiver is matched) instead of binding it to a new name.",
    ).toEqual([]);
  });

  it("uses only the sanctioned guard classifications", () => {
    const inventory = readInventoryRows("wake:");
    expect(inventory.size).toBeGreaterThan(0);
    for (const [identifier, classification] of inventory) {
      expect(
        WAKE_GUARD_CLASSIFICATIONS.has(classification),
        `${identifier} has unknown classification "${classification}"`,
      ).toBe(true);
    }
  });

  it("keeps the sanctioned freeze-piercing wakes down to the decision outbox and revision wake", () => {
    const inventory = readInventoryRows("wake:");
    const bypassSites = [...inventory.entries()]
      .filter(([, classification]) => classification === "bypass-only")
      .map(([identifier]) => identifier)
      .sort();
    expect(bypassSites).toEqual([
      "wake:services/decision-leases.ts#1",
      "wake:services/decision-leases.ts#2",
    ]);
  });
});
