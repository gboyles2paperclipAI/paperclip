import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postgresMock, spawnMock } = vi.hoisted(() => ({
  postgresMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";

const tempDirs: string[] = [];

function fakeChild(command: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough | null;
    stdout: Readable | null;
    stderr: Readable;
  };
  child.stdin = command.includes("psql") ? new PassThrough() : null;
  child.stdout = command.includes("pg_dump") ? Readable.from(["-- synthetic dump\n"]) : null;
  child.stderr = Readable.from([]);
  queueMicrotask(() => child.emit("exit", 0, null));
  return child;
}

beforeEach(() => {
  const sql = Object.assign(vi.fn(async () => [{ connected: true }]), {
    end: vi.fn(async () => undefined),
  });
  postgresMock.mockReturnValue(sql);
  spawnMock.mockImplementation((command: string) => fakeChild(command));
});

afterEach(() => {
  vi.clearAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("PostgreSQL CLI credentials", () => {
  it("keeps database credentials out of argv while passing a sanitized URI", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-argv-"));
    tempDirs.push(tempDir);
    const password = "synthetic-sensitive-password";
    const connectionString = [
      "postgresql:",
      `//backup-user:${password}@db.example.test:6543/paperclip?sslmode=require`,
    ].join("");

    const backup = await runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "argv-test",
      backupEngine: "pg_dump",
    });
    await runDatabaseRestore({ connectionString, backupFile: backup.backupFile });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      const exposesPassword = args.some((arg) => arg.includes(password));
      const exposesUrlUserinfo = args.some((arg) => /postgres(?:ql)?:\/\/[^/?#]*@/i.test(arg));
      expect(exposesPassword || exposesUrlUserinfo).toBe(false);
    }

    for (const call of spawnMock.mock.calls) {
      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PGUSER).toBe("backup-user");
      expect(env.PGPASSWORD).toBe(password);
      expect(env.PGCONNECT_TIMEOUT).toBe("5");
    }

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--dbname=postgresql://db.example.test:6543/paperclip?sslmode=require",
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "--dbname=postgresql://db.example.test:6543/paperclip?sslmode=require",
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ]);
  });

  it("preserves multi-host routing and supported TLS and session parameters", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-multihost-"));
    tempDirs.push(tempDir);
    const connectionString = [
      "postgresql://backup-user:synthetic-password@",
      "db-a.example.test:5432,db-b.example.test:5433/paperclip",
      "?sslmode=verify-full",
      "&sslrootcert=%2Fcerts%2Froot.pem",
      "&sslcert=%2Fcerts%2Fclient.pem",
      "&application_name=paperclip-backup",
      "&target_session_attrs=read-write",
    ].join("");

    const backup = await runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "multihost-test",
      connectTimeoutSeconds: 23,
      backupEngine: "pg_dump",
    });
    await runDatabaseRestore({
      connectionString,
      backupFile: backup.backupFile,
      connectTimeoutSeconds: 23,
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      expect(args.some((arg) => arg.includes(connectionString))).toBe(false);
      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PGUSER).toBe("backup-user");
      expect(env.PGPASSWORD).toBe("synthetic-password");
      expect(env.PGCONNECT_TIMEOUT).toBe("23");
      expect(args[0]).toBe([
        "--dbname=postgresql://",
        "db-a.example.test:5432,db-b.example.test:5433/paperclip",
        "?sslmode=verify-full",
        "&sslrootcert=%2Fcerts%2Froot.pem",
        "&sslcert=%2Fcerts%2Fclient.pem",
        "&application_name=paperclip-backup",
        "&target_session_attrs=read-write",
      ].join(""));
    }
  });

  it("keeps sslpassword out of pg_dump and psql argv", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-sslpassword-"));
    tempDirs.push(tempDir);
    const sslPassword = "synthetic-client-key-passphrase";
    const connectionString = [
      "postgresql://backup-user:synthetic-password@db.example.test/paperclip",
      `?sslmode=verify-full&sslkey=%2Fcerts%2Fclient.key&sslpassword=${sslPassword}`,
    ].join("");

    const backup = await runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "sslpassword-test",
      backupEngine: "pg_dump",
    });
    await runDatabaseRestore({ connectionString, backupFile: backup.backupFile });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      expect(args.some((arg) => arg.includes("sslpassword") || arg.includes(sslPassword))).toBe(false);
      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PGPASSWORD).toBe("synthetic-password");
      expect(env.PGSSLPASSWORD).toBe(sslPassword);
      expect(args[0]).toBe([
        "--dbname=postgresql://db.example.test/paperclip",
        "?sslmode=verify-full",
        "&sslkey=%2Fcerts%2Fclient.key",
      ].join(""));
    }
  });

  it("keeps the helper script connection string out of psql argv", () => {
    const helperSource = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/find-paperclip-user-id.sh"),
      "utf8",
    );

    expect(/psql\s+["']?\$CONNECTION_STRING/.test(helperSource)).toBe(false);
    expect(helperSource.includes('PGDATABASE="$CONNECTION_STRING" psql')).toBe(true);
  });
});
