import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import {
  isT1Key,
  extractT1Secrets,
  getT1Secrets,
  clearT1Secrets,
  writeT1EnvFile,
  cleanupT1EnvFile,
  t1EnvFilePath,
} from "../services/t1-secret-store.js";

const RUN_ID = "test-run-ful6378";

afterEach(() => {
  clearT1Secrets(RUN_ID);
});

describe("isT1Key", () => {
  it("classifies known T1 keys as T1", () => {
    const t1Keys = [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENROUTER_API_KEY",
      "RESEND_API_KEY",
      "VERCEL_OIDC_TOKEN",
      "ADMIN_SESSION_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "VERCEL_WEBHOOK_SECRET",
      "HELP2DAY_QA_BYPASS_TOKEN",
      "HELP2DAY_TEST_HOOK_SECRET",
      "PAPERCLIP_BYPASS_TOKEN",
      "MY_API_KEY",
      "MY_ACCESS_TOKEN",
      "AUTH_TOKEN",
      "BEARER_TOKEN",
      "DB_PASSWORD",
      "DB_PASSWD",
      "JWT_SECRET",
      "PRIVATE_KEY",
      "CONNECTION_STRING",
    ];
    for (const key of t1Keys) {
      expect(isT1Key(key), `expected ${key} to be T1`).toBe(true);
    }
  });

  it("classifies T2 (non-secret) keys as not T1", () => {
    const t2Keys = [
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_COMPANY_ID",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_RUN_ID",
      "PAPERCLIP_TASK_ID",
      "PAPERCLIP_WAKE_REASON",
      "PAPERCLIP_WORKSPACE_CWD",
      "NODE_ENV",
      "HOME",
      "PATH",
      "PORT",
      "LOG_LEVEL",
      "VERCEL_GIT_COMMIT_SHA",
      "PAPERCLIP_DEPLOYMENT_MODE",
    ];
    for (const key of t2Keys) {
      expect(isT1Key(key), `expected ${key} to be T2 (not T1)`).toBe(false);
    }
  });
});

describe("extractT1Secrets", () => {
  it("separates T1 keys from T2 keys", () => {
    const env = {
      PAPERCLIP_AGENT_ID: "agent-uuid",
      DATABASE_URL: "postgres://user:pass@host/db",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      NODE_ENV: "production",
      HOME: "/home/user",
      RESEND_API_KEY: "re_xxx",
    };

    const { sanitizedEnv, t1Keys } = extractT1Secrets(RUN_ID, env);

    expect(sanitizedEnv).toEqual({
      PAPERCLIP_AGENT_ID: "agent-uuid",
      NODE_ENV: "production",
      HOME: "/home/user",
    });
    expect(t1Keys.sort()).toEqual(["ANTHROPIC_API_KEY", "DATABASE_URL", "RESEND_API_KEY"]);
  });

  it("stores extracted T1 secrets in memory", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-xxx", NODE_ENV: "production" };
    extractT1Secrets(RUN_ID, env);
    expect(getT1Secrets(RUN_ID)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
  });

  it("returns empty t1Keys when env has no T1 secrets", () => {
    const env = { NODE_ENV: "production", HOME: "/home/user" };
    const { sanitizedEnv, t1Keys } = extractT1Secrets(RUN_ID, env);
    expect(t1Keys).toHaveLength(0);
    expect(sanitizedEnv).toEqual(env);
    expect(getT1Secrets(RUN_ID)).toEqual({});
  });

  it("does not persist to disk — memory only at extraction time", () => {
    extractT1Secrets(RUN_ID, { ANTHROPIC_API_KEY: "sk-ant-xxx" });
    // getT1Secrets reads from memory, not disk
    expect(getT1Secrets(RUN_ID)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
  });
});

describe("clearT1Secrets", () => {
  it("removes in-memory state for a run", () => {
    extractT1Secrets(RUN_ID, { ANTHROPIC_API_KEY: "sk-ant-xxx" });
    clearT1Secrets(RUN_ID);
    expect(getT1Secrets(RUN_ID)).toEqual({});
  });
});

describe("writeT1EnvFile + cleanupT1EnvFile", () => {
  it("writes a chmod 600 JSON file and returns its path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ful6378-"));
    try {
      extractT1Secrets(RUN_ID, {
        ANTHROPIC_API_KEY: "sk-ant-xxx",
        NODE_ENV: "production",
      });

      const filePath = await writeT1EnvFile(RUN_ID, tmpDir);
      expect(filePath).not.toBeNull();
      expect(filePath).toBe(t1EnvFilePath(RUN_ID, tmpDir));

      const content = await fs.readFile(filePath!, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xxx" });

      const stat = await fs.stat(filePath!);
      // Mode should be 0o100600 (regular file + 600)
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when no T1 secrets exist for the run", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ful6378-"));
    try {
      const filePath = await writeT1EnvFile(RUN_ID, tmpDir);
      expect(filePath).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("cleanupT1EnvFile removes the file and clears memory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ful6378-"));
    try {
      extractT1Secrets(RUN_ID, { ANTHROPIC_API_KEY: "sk-ant-xxx" });
      const filePath = await writeT1EnvFile(RUN_ID, tmpDir);
      expect(filePath).not.toBeNull();

      await cleanupT1EnvFile(RUN_ID, tmpDir);

      // Memory cleared
      expect(getT1Secrets(RUN_ID)).toEqual({});
      // File removed
      await expect(fs.access(filePath!)).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("cleanupT1EnvFile is idempotent when directory is already gone", async () => {
    const tmpDir = path.join(os.tmpdir(), "ful6378-never-exists");
    await expect(cleanupT1EnvFile(RUN_ID, tmpDir)).resolves.toBeUndefined();
  });
});
