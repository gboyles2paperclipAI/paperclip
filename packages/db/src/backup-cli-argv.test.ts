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
  it("keeps database URL userinfo and passwords out of spawned argv", async () => {
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
      expect(env.PGHOST).toBe("db.example.test");
      expect(env.PGPORT).toBe("6543");
      expect(env.PGUSER).toBe("backup-user");
      expect(env.PGDATABASE).toBe("paperclip");
      expect(env.PGPASSWORD === password).toBe(true);
      expect(env.PGSSLMODE).toBe("require");
    }

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ]);
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
