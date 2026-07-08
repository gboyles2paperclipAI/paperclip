import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const provisionWorktreeScriptPath = fileURLToPath(new URL("../../../scripts/provision-worktree.sh", import.meta.url));

type Fixture = {
  tempRoot: string;
  baseRoot: string;
  worktreeRoot: string;
  fakeBin: string;
  paperclipDir: string;
};

async function createFixture(): Promise<Fixture> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provision-worktree-"));
  const baseRoot = path.join(tempRoot, "base");
  const worktreeRoot = path.join(tempRoot, "worktree");
  const fakeBin = path.join(tempRoot, "bin");
  const paperclipDir = path.join(worktreeRoot, ".paperclip");

  await fs.mkdir(baseRoot, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.symlink(process.execPath, path.join(fakeBin, "node"));

  return { tempRoot, baseRoot, worktreeRoot, fakeBin, paperclipDir };
}

function buildEnv(fixture: Fixture, overrides: Record<string, string> = {}) {
  return {
    HOME: path.join(fixture.tempRoot, "home"),
    PATH: [fixture.fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
    TMPDIR: os.tmpdir(),
    PAPERCLIP_HOME: path.join(fixture.tempRoot, "host-home"),
    PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_WORKSPACE_BASE_CWD: fixture.baseRoot,
    PAPERCLIP_WORKSPACE_CWD: fixture.worktreeRoot,
    PAPERCLIP_WORKTREE_INIT_SKIP_HOST_CLI: "1",
    PAPERCLIP_WORKTREES_DIR: path.join(fixture.tempRoot, "isolated-home"),
    ...overrides,
  };
}

async function runProvision(fixture: Fixture, overrides: Record<string, string> = {}) {
  return execFileAsync("bash", [provisionWorktreeScriptPath], {
    cwd: fixture.worktreeRoot,
    env: buildEnv(fixture, overrides),
  });
}

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("provision-worktree.sh fallback config writer", () => {
  it("atomically writes final config and env files without leaving fallback temp files", async () => {
    const fixture = await createFixture();

    try {
      const result = await runProvision(fixture);

      expect(result.stderr).toContain("writing isolated fallback config without DB seeding");
      const configPath = path.join(fixture.paperclipDir, "config.json");
      const envPath = path.join(fixture.paperclipDir, ".env");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const envContents = await fs.readFile(envPath, "utf8");

      expect(config.database.mode).toBe("embedded-postgres");
      expect(config.database.embeddedPostgresDataDir).toContain(path.join(fixture.tempRoot, "isolated-home"));
      expect(envContents).toContain(`PAPERCLIP_CONFIG="${configPath}"`);
      await expect(pathExists(`${configPath}.tmp`)).resolves.toBe(false);
      await expect(pathExists(`${envPath}.tmp`)).resolves.toBe(false);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reports invalid existing config JSON cleanly before regenerating fallback config", async () => {
    const fixture = await createFixture();

    try {
      await fs.mkdir(fixture.paperclipDir, { recursive: true });
      await fs.writeFile(path.join(fixture.paperclipDir, "config.json"), "{not-json", "utf8");
      await fs.writeFile(path.join(fixture.paperclipDir, ".env"), "PAPERCLIP_HOME=/tmp/missing\n", "utf8");

      const result = await runProvision(fixture);

      expect(result.stderr).toContain("existing worktree config is invalid JSON: config.json");
      expect(result.stderr).not.toMatch(/\n\s+at /);
      const config = JSON.parse(await fs.readFile(path.join(fixture.paperclipDir, "config.json"), "utf8"));
      expect(config.database.mode).toBe("embedded-postgres");
      await expect(pathExists(path.join(fixture.paperclipDir, "config.json.tmp"))).resolves.toBe(false);
      await expect(pathExists(path.join(fixture.paperclipDir, ".env.tmp"))).resolves.toBe(false);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing final files and removes temp files when fallback generation fails", async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.paperclipDir, "config.json");
    const envPath = path.join(fixture.paperclipDir, ".env");
    const badSourceConfigPath = path.join(fixture.tempRoot, "bad-source-config.json");
    const existingConfig = `${JSON.stringify({
      database: { embeddedPostgresDataDir: path.join(fixture.tempRoot, "old-home", "instances", "old", "db") },
    })}\n`;
    const existingEnv = [
      `PAPERCLIP_HOME=${path.join(fixture.tempRoot, "old-home")}`,
      "PAPERCLIP_INSTANCE_ID=old",
      `PAPERCLIP_CONFIG=${configPath}`,
      "",
    ].join("\n");

    try {
      await fs.mkdir(fixture.paperclipDir, { recursive: true });
      await fs.writeFile(configPath, existingConfig, "utf8");
      await fs.writeFile(envPath, existingEnv, "utf8");
      await fs.writeFile(badSourceConfigPath, "{not-json", "utf8");

      let stderr = "";
      try {
        await runProvision(fixture, { PAPERCLIP_CONFIG: badSourceConfigPath });
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }

      expect(stderr).toContain("Existing isolated Paperclip worktree config is stale for this host; regenerating.");
      expect(stderr).not.toMatch(/\n\s+at /);
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
      await expect(fs.readFile(envPath, "utf8")).resolves.toBe(existingEnv);
      await expect(pathExists(`${configPath}.tmp`)).resolves.toBe(false);
      await expect(pathExists(`${envPath}.tmp`)).resolves.toBe(false);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
