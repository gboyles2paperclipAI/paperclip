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

async function runProvision(
  fixture: Fixture,
  overrides: Record<string, string> = {},
  scriptPath = provisionWorktreeScriptPath,
) {
  return execFileAsync("bash", [scriptPath], {
    cwd: fixture.worktreeRoot,
    env: buildEnv(fixture, overrides),
  });
}

async function fallbackTempPaths(paperclipDir: string) {
  const entries = await fs.readdir(paperclipDir);
  return entries.filter((entry) => entry.includes(".paperclip-temp-") || entry.includes(".paperclip-backup-"));
}

describe("provision-worktree.sh fallback config writer", () => {
  it("refuses a symlinked worktree .paperclip directory before reading or writing config", async () => {
    const fixture = await createFixture();
    const outsideDir = path.join(fixture.tempRoot, "outside-paperclip");
    const outsideSentinel = path.join(outsideDir, "sentinel.txt");

    try {
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideSentinel, "outside-must-not-change\n", "utf8");
      await fs.symlink(outsideDir, fixture.paperclipDir);

      let stderr = "";
      try {
        await runProvision(fixture);
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }

      expect(stderr).toContain("Refusing unsafe worktree .paperclip directory");
      await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("outside-must-not-change\n");
      await expect(fs.readdir(outsideDir)).resolves.toEqual(["sentinel.txt"]);
      expect((await fs.lstat(fixture.paperclipDir)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

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
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
      await expect(fallbackTempPaths(fixture.paperclipDir)).resolves.toEqual([]);
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
      await expect(fallbackTempPaths(fixture.paperclipDir)).resolves.toEqual([]);
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
      await expect(fallbackTempPaths(fixture.paperclipDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not follow hostile precreated fallback temp symlinks", async () => {
    const fixture = await createFixture();
    const outsideSentinel = path.join(fixture.tempRoot, "outside-sentinel");
    const hostileConfigTemp = path.join(fixture.paperclipDir, "config.json.paperclip-temp-hostile");
    const hostileEnvTemp = path.join(fixture.paperclipDir, ".env.paperclip-temp-hostile");

    try {
      await fs.mkdir(fixture.paperclipDir, { recursive: true });
      await fs.writeFile(outsideSentinel, "outside-must-not-change\n", "utf8");
      await fs.symlink(outsideSentinel, hostileConfigTemp);
      await fs.symlink(outsideSentinel, hostileEnvTemp);

      await runProvision(fixture);

      await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("outside-must-not-change\n");
      await expect(fs.readlink(hostileConfigTemp)).resolves.toBe(outsideSentinel);
      await expect(fs.readlink(hostileEnvTemp)).resolves.toBe(outsideSentinel);
      expect(JSON.parse(await fs.readFile(path.join(fixture.paperclipDir, "config.json"), "utf8")).database.mode)
        .toBe("embedded-postgres");
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses to replace a symlinked final config file", async () => {
    const fixture = await createFixture();
    const outsideSentinel = path.join(fixture.tempRoot, "outside-final-sentinel");
    const configPath = path.join(fixture.paperclipDir, "config.json");
    const envPath = path.join(fixture.paperclipDir, ".env");

    try {
      await fs.mkdir(fixture.paperclipDir, { recursive: true });
      await fs.writeFile(outsideSentinel, "{}\n", "utf8");
      await fs.symlink(outsideSentinel, configPath);
      await fs.writeFile(envPath, "PAPERCLIP_HOME=/missing\nPAPERCLIP_INSTANCE_ID=old\n", "utf8");

      await expect(runProvision(fixture)).rejects.toBeDefined();

      await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("{}\n");
      await expect(fs.readlink(configPath)).resolves.toBe(outsideSentinel);
      await expect(fs.readFile(envPath, "utf8")).resolves.toContain("PAPERCLIP_INSTANCE_ID=old");
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rolls back both final files when the second rename fails", async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.paperclipDir, "config.json");
    const envPath = path.join(fixture.paperclipDir, ".env");
    const injectedScriptPath = path.join(fixture.tempRoot, "provision-worktree-second-rename-failure.sh");
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
      await fs.writeFile(configPath, existingConfig, { mode: 0o600 });
      await fs.writeFile(envPath, existingEnv, { mode: 0o600 });
      const script = await fs.readFile(provisionWorktreeScriptPath, "utf8");
      const renameLine = "    fs.renameSync(envTmpPath, envPath);";
      expect(script.split(renameLine)).toHaveLength(2);
      await fs.writeFile(
        injectedScriptPath,
        script.replace(renameLine, '    throw new Error("injected second rename failure");'),
        { mode: 0o700 },
      );

      await expect(runProvision(fixture, {}, injectedScriptPath)).rejects.toBeDefined();

      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
      await expect(fs.readFile(envPath, "utf8")).resolves.toBe(existingEnv);
      await expect(fallbackTempPaths(fixture.paperclipDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses recursive deletion through a symlinked ancestor", async () => {
    const fixture = await createFixture();
    const basePackage = path.join(fixture.baseRoot, "packages", "hostile");
    const worktreePackages = path.join(fixture.worktreeRoot, "packages");
    const outsideParent = path.join(fixture.tempRoot, "outside-parent");
    const outsideModulesTarget = path.join(fixture.tempRoot, "outside-modules-target");
    const outsideSentinel = path.join(outsideModulesTarget, "sentinel.txt");

    try {
      await fs.mkdir(path.join(basePackage, "node_modules"), { recursive: true });
      await fs.mkdir(worktreePackages, { recursive: true });
      await fs.mkdir(outsideParent, { recursive: true });
      await fs.mkdir(outsideModulesTarget, { recursive: true });
      await fs.writeFile(outsideSentinel, "outside-must-survive\n", "utf8");
      await fs.symlink(outsideModulesTarget, path.join(outsideParent, "node_modules"));
      await fs.symlink(outsideParent, path.join(worktreePackages, "hostile"));
      await fs.writeFile(path.join(fixture.worktreeRoot, "package.json"), "{}\n", "utf8");
      await fs.writeFile(path.join(fixture.worktreeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

      let stderr = "";
      try {
        await runProvision(fixture);
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }

      expect(stderr).toContain("Refusing to remove unsafe provision path");
      await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("outside-must-survive\n");
      expect((await fs.lstat(path.join(outsideParent, "node_modules"))).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not use recursive forced deletion for dependency symlink recovery", async () => {
    const script = await fs.readFile(provisionWorktreeScriptPath, "utf8");
    expect(script).not.toContain("rm -rf");
  });
});
