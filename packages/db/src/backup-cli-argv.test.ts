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

  it.each(["backup", "restore"] as const)(
    "fails closed before spawning for sslpassword during %s",
    async (operation) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-sslpassword-"));
      tempDirs.push(tempDir);
      const connectionString = [
        "postgresql://backup-user:synthetic-password@db.example.test/paperclip",
        "?sslmode=verify-full&sslkey=%2Fcerts%2Fclient.key&sslpassword=synthetic-client-key-passphrase",
      ].join("");

      const result = operation === "backup"
        ? runDatabaseBackup({
          connectionString,
          backupDir: tempDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "sslpassword-test",
          backupEngine: "pg_dump",
        })
        : runDatabaseRestore({
          connectionString,
          backupFile: path.join(tempDir, "backup.sql"),
        });

      await expect(result).rejects.toThrow(
        'cannot safely pass credential parameter "sslpassword"',
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["literal plus", "+"],
    ["percent-encoded plus", "%2B"],
  ])("preserves %s in query credentials without exposing them in argv", async (_label, encodedPlus) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-query-plus-"));
    tempDirs.push(tempDir);
    const connectionString = [
      "postgresql://db.example.test/paperclip?sslmode=verify-full",
      `&user=backup${encodedPlus}user`,
      `&password=synthetic${encodedPlus}password`,
    ].join("");

    const backup = await runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "query-plus-test",
      backupEngine: "pg_dump",
    });
    await runDatabaseRestore({ connectionString, backupFile: backup.backupFile });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      expect(args.join(" ")).not.toContain("backup+user");
      expect(args.join(" ")).not.toContain("synthetic+password");

      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PGUSER).toBe("backup+user");
      expect(env.PGPASSWORD).toBe("synthetic+password");
    }
  });

  it("preserves encoded Unix-socket routing and advanced libpq parameters", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-unix-socket-"));
    tempDirs.push(tempDir);
    const connectionString = [
      "postgresql:///paperclip?host=%2Fvar%2Frun%2Fpostgresql",
      "&hostaddr=127.0.0.1",
      "&sslmode=verify-full",
      "&sslrootcert=%2Fcerts%2Froot.pem",
      "&sslcert=%2Fcerts%2Fclient.pem",
      "&sslkey=%2Fcerts%2Fclient.key",
      "&application_name=paperclip-backup",
      "&target_session_attrs=read-write",
      "&options=-c%20statement_timeout%3D5000",
      "&user=backup-user",
      "&password=synthetic-password",
    ].join("");
    const expectedDatabaseTarget = [
      "postgresql:///paperclip?host=%2Fvar%2Frun%2Fpostgresql",
      "&hostaddr=127.0.0.1",
      "&sslmode=verify-full",
      "&sslrootcert=%2Fcerts%2Froot.pem",
      "&sslcert=%2Fcerts%2Fclient.pem",
      "&sslkey=%2Fcerts%2Fclient.key",
      "&application_name=paperclip-backup",
      "&target_session_attrs=read-write",
      "&options=-c%20statement_timeout%3D5000",
    ].join("");

    const backup = await runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "unix-socket-test",
      backupEngine: "pg_dump",
    });
    await runDatabaseRestore({ connectionString, backupFile: backup.backupFile });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[];
      expect(args[0]).toBe(`--dbname=${expectedDatabaseTarget}`);
      expect(args.join(" ")).not.toContain("synthetic-password");

      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.PGUSER).toBe("backup-user");
      expect(env.PGPASSWORD).toBe("synthetic-password");
    }
  });

  it.each([
    "oauth_client_secret",
    "scram_client_key",
    "scram_server_key",
  ])("fails closed before spawning for %s", async (parameter) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cli-credential-param-"));
    tempDirs.push(tempDir);
    const connectionString = [
      "postgresql://backup-user@db.example.test/paperclip?sslmode=require&",
      `${parameter}=synthetic-credential-material`,
    ].join("");

    await expect(runDatabaseBackup({
      connectionString,
      backupDir: tempDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "credential-param-test",
      backupEngine: "pg_dump",
    })).rejects.toThrow(`cannot safely pass credential parameter \"${parameter}\"`);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps the helper script connection string out of psql argv", () => {
    const helperSource = fs.readFileSync(
      new URL("../../../scripts/find-paperclip-user-id.sh", import.meta.url),
      "utf8",
    );

    expect(/psql\s+["']?\$CONNECTION_STRING/.test(helperSource)).toBe(false);
    expect(helperSource.includes('PGDATABASE="$CONNECTION_STRING" psql')).toBe(true);
  });
});
