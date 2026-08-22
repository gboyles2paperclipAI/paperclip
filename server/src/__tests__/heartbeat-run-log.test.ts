import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts generated credential config content when shell redirection is omitted", () => {
    const forbidden = [
      "SYNTHETIC_AUTH_CONFIG_VALUE_DO_NOT_USE",
      "SYNTHETIC_HEADER_CONFIG_VALUE_DO_NOT_USE",
      "SYNTHETIC_COLON_CONFIG_VALUE_DO_NOT_USE",
    ];
    const chunk = [
      `header = "Authorization: Bearer ${forbidden[0]}"`,
      `header = "X-Api-Key: ${forbidden[1]}"`,
      `PAPERCLIP_API_KEY: ${forbidden[2]}`,
      `header = "Accept: application/json"`,
      "normal command output preserved",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).toContain(`header = "Accept: application/json"`);
    expect(compacted).toContain("normal command output preserved");
    for (const value of forbidden) {
      expect(compacted).not.toContain(value);
    }
  });

  it("redacts database URL output before persisting run-log chunks", () => {
    const forbidden = [
      "SYNTHETIC_DB_URL_VALUE_DO_NOT_USE",
      "SYNTHETIC_SYSTEMD_DB_URL_VALUE_DO_NOT_USE",
      "SYNTHETIC_COLON_DB_URL_VALUE_DO_NOT_USE",
      "synthetic-pass",
    ];
    const chunk = [
      "Environment=NODE_ENV=production",
      `DATABASE_URL=${forbidden[0]}`,
      `Environment=DATABASE_URL=${forbidden[1]}`,
      `DATABASE_URL: ${forbidden[2]}`,
      `postgresql://synthetic-user:${forbidden[3]}@example.invalid:5432/synthetic-db`,
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).toContain("Environment=NODE_ENV=production");
    for (const value of forbidden) {
      expect(compacted).not.toContain(value);
    }
  });

  it("redacts a raw localhost database URL without fast-path secret hints before persistence", () => {
    const rawDatabaseUrl = "postgresql://u:q@localhost:5432/app";
    const compacted = compactRunLogChunk(`connect ${rawDatabaseUrl}`);

    expect(compacted).toBe("connect ***REDACTED***");
    expect(compacted).not.toContain(rawDatabaseUrl);
  });
});
