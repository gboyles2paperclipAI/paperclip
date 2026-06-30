import { describe, expect, it } from "vitest";
import { makeDbConnectionUrlRe, makeTailscaleAuthUrlRe, redactCommandText, REDACTED_COMMAND_TEXT_VALUE } from "./command-redaction.js";
import { redactKnownAuthUrls } from "./log-redaction.js";

describe("makeDbConnectionUrlRe", () => {
  it("returns a fresh RegExp instance on each call (no shared lastIndex)", () => {
    const re1 = makeDbConnectionUrlRe();
    const re2 = makeDbConnectionUrlRe();
    expect(re1).not.toBe(re2);
  });

  it("matches postgresql:// connection URL", () => {
    expect(makeDbConnectionUrlRe().test("postgresql://user:pass@host/db")).toBe(true);
  });

  it("matches postgres:// alias", () => {
    expect(makeDbConnectionUrlRe().test("postgres://user:pass@host:5432/mydb")).toBe(true);
  });

  it("matches mysql:// connection URL", () => {
    expect(makeDbConnectionUrlRe().test("mysql://user:pass@host/db")).toBe(true);
  });

  it("matches mongodb:// connection URL", () => {
    expect(makeDbConnectionUrlRe().test("mongodb://user:pass@host/db")).toBe(true);
  });

  it("matches redis:// connection URL", () => {
    expect(makeDbConnectionUrlRe().test("redis://user:pass@host:6379")).toBe(true);
  });
});

describe("redactCommandText — database connection URL redaction (FUL-14159)", () => {
  it("redacts DATABASE_URL env assignment (postgresql)", () => {
    const input = "DATABASE_URL=postgresql://user:pass@host/db";
    const result = redactCommandText(input);
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("pass");
    expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts DATABASE_URL env assignment (postgres alias)", () => {
    const input = "DATABASE_URL=postgres://admin:s3cret@db.internal:5432/prod";
    const result = redactCommandText(input);
    expect(result).not.toContain("postgres://");
    expect(result).not.toContain("s3cret");
  });

  it("redacts bare postgresql:// URL with credentials", () => {
    const input = "postgresql://user:pass@host/db";
    const result = redactCommandText(input);
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("pass");
    expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts bare postgres:// URL embedded mid-string", () => {
    const input = 'Connecting to postgres://user:secret@myhost:5432/mydb now';
    const result = redactCommandText(input);
    expect(result).not.toContain("secret");
    expect(result).not.toContain("postgres://");
  });

  it("redacts mysql:// URL", () => {
    const input = "mysql://root:topsecret@127.0.0.1/app";
    const result = redactCommandText(input);
    expect(result).not.toContain("topsecret");
  });

  it("redacts mongodb:// URL", () => {
    const input = "mongodb://mongouser:mongopass@cluster0.example.net/mydb";
    const result = redactCommandText(input);
    expect(result).not.toContain("mongopass");
  });

  it("redacts redis:// URL", () => {
    const input = "redis://:redispassword@redis.internal:6379/0";
    const result = redactCommandText(input);
    expect(result).not.toContain("redispassword");
  });

  it("does not alter text with no secret-bearing URL", () => {
    const input = "echo hello world";
    expect(redactCommandText(input)).toBe(input);
  });

  it("redacts only the URL portion, preserving surrounding non-secret text", () => {
    const input = "Migrating: postgresql://admin:pw@host/db done";
    const result = redactCommandText(input);
    expect(result).toContain("Migrating:");
    expect(result).toContain("done");
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("pw");
  });
});

describe("redactKnownAuthUrls — database connection URL redaction in transcript output (FUL-14159)", () => {
  it("redacts postgresql:// URL from stdout/stderr transcript", () => {
    const input = "DATABASE_URL: postgresql://user:pass@host/db";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("pass");
    expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts postgres:// alias from transcript", () => {
    const input = "Connected to postgres://admin:secret@host:5432/db";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("postgres://");
    expect(result).not.toContain("secret");
  });

  it("redacts mysql:// from transcript", () => {
    const input = "mysql://root:pass@localhost/app";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("mysql://");
  });

  it("redacts mongodb:// from transcript", () => {
    const input = "uri=mongodb://u:p@host/db";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("mongodb://");
    expect(result).not.toContain(":p@");
  });

  it("redacts redis:// from transcript", () => {
    const input = "REDIS_URL=redis://:pass@cache.internal:6379";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("redis://");
    expect(result).not.toContain("pass");
  });

  it("preserves non-URL content unchanged", () => {
    const input = "Process exited with code 0";
    expect(redactKnownAuthUrls(input)).toBe(input);
  });

  it("still redacts Tailscale auth URLs alongside DB URLs", () => {
    const input = "auth: https://login.tailscale.com/a/abc123 db: postgresql://u:p@h/d";
    const result = redactKnownAuthUrls(input);
    expect(result).not.toContain("login.tailscale.com");
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain(":p@");
  });
});

describe("makeTailscaleAuthUrlRe (regression guard)", () => {
  it("still matches Tailscale auth URLs", () => {
    expect(makeTailscaleAuthUrlRe().test("https://login.tailscale.com/a/abc123xyz")).toBe(true);
  });
});
