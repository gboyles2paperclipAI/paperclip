import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const trackedEnvKeys = [
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_HOME",
  "PAPERCLIP_TAILNET_BIND_HOST",
  "PAPERCLIP_IN_WORKTREE",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_ENABLE_COMPANY_DELETION",
  "HOST",
] as const;

const originalEnv = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]]),
) as Record<typeof trackedEnvKeys[number], string | undefined>;

let tempDir: string | null = null;
let importCounter = 0;

async function loadIsolatedConfig() {
  importCounter += 1;
  const modulePath = `../config.js?company-deletion-${importCounter}`;
  return import(modulePath) as Promise<typeof import("../config.js")>;
}

describe("company deletion config", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paperclip-company-deletion-config-"));
    process.env.PAPERCLIP_CONFIG = join(tempDir, "config.json");
    process.env.PAPERCLIP_HOME = tempDir;
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "127.0.0.1";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
    process.env.HOST = "127.0.0.1";
    delete process.env.PAPERCLIP_IN_WORKTREE;
    delete process.env.PAPERCLIP_ENABLE_COMPANY_DELETION;
  });

  afterEach(() => {
    for (const key of trackedEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("defaults company deletion to disabled in local_trusted mode", async () => {
    const { loadConfig } = await loadIsolatedConfig();

    expect(loadConfig().companyDeletionEnabled).toBe(false);
  });

  it("enables company deletion only with explicit true", async () => {
    process.env.PAPERCLIP_ENABLE_COMPANY_DELETION = "true";
    const { loadConfig } = await loadIsolatedConfig();

    expect(loadConfig().companyDeletionEnabled).toBe(true);
  });

  it.each(["false", "0", "no", "random", ""])(
    "keeps company deletion disabled for %j",
    async (value) => {
      process.env.PAPERCLIP_ENABLE_COMPANY_DELETION = value;
      const { loadConfig } = await loadIsolatedConfig();

      expect(loadConfig().companyDeletionEnabled).toBe(false);
    },
  );
});
