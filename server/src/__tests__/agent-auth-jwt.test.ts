import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const disableLegacyFallbackEnv = "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK";
  const enableLegacyFallbackEnv = "PAPERCLIP_AGENT_JWT_ENABLE_LEGACY_FALLBACK";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    disableLegacyFallback: process.env[disableLegacyFallbackEnv],
    enableLegacyFallback: process.env[enableLegacyFallbackEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    delete process.env[disableLegacyFallbackEnv];
    delete process.env[enableLegacyFallbackEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
    if (originalEnv.disableLegacyFallback === undefined) delete process.env[disableLegacyFallbackEnv];
    else process.env[disableLegacyFallbackEnv] = originalEnv.disableLegacyFallback;
    if (originalEnv.enableLegacyFallback === undefined) delete process.env[enableLegacyFallbackEnv];
    else process.env[enableLegacyFallbackEnv] = originalEnv.enableLegacyFallback;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
    });
  });

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("does not fall back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it.each(["iss", "aud"] as const)("rejects a signed token missing %s", (missingClaim) => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const masterSecret = process.env[secretEnv]!;
    const companyId = "company-claims";
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims: Record<string, unknown> = {
      sub: "agent-claims",
      company_id: companyId,
      adapter_type: "codex_local",
      run_id: "run-claims",
      iat: now,
      exp: now + 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    delete claims[missingClaim];
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const companyKey = createHmac("sha256", masterSecret).update(`jwt:${companyId}`).digest("hex");
    const signature = createHmac("sha256", companyKey).update(signingInput).digest("base64url");

    expect(verifyLocalAgentJwt(`${signingInput}.${signature}`)).toBeNull();
  });

  it("does not verify a token across companies (per-company isolation)", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const tokenA = createLocalAgentJwt("agent-1", "company-A", "claude_local", "run-1");
    expect(tokenA).not.toBeNull();

    // A token whose body claims company-A must verify successfully under its
    // own company-A derived key.
    expect(verifyLocalAgentJwt(tokenA!)?.company_id).toBe("company-A");

    // Tamper: forge a token by copying tokenA's header+signature and swapping
    // the claim's company_id to company-B. The signature was bound to the
    // company-A derived key over the original claims; once we re-encode with a
    // different company_id (or rebind to company-B's key) verification must
    // fail because the signature is over the original signing input.
    const [headerB64, claimsB64, signature] = tokenA!.split(".");
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    claims.company_id = "company-B";
    const tamperedClaimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const tampered = `${headerB64}.${tamperedClaimsB64}.${signature}`;
    expect(verifyLocalAgentJwt(tampered)).toBeNull();
  });

  it("rejects legacy tokens signed with the master secret by default", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const masterSecret = process.env[secretEnv]!;

    // Hand-craft a token signed directly with the master secret, simulating a
    // JWT issued before per-company derivation existed.
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = {
      sub: "agent-legacy",
      company_id: "company-legacy",
      adapter_type: "claude_local",
      run_id: "run-legacy",
      iat: now,
      exp: now + 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const legacySig = createHmac("sha256", masterSecret).update(signingInput).digest("base64url");
    const legacyToken = `${signingInput}.${legacySig}`;

    expect(verifyLocalAgentJwt(legacyToken)).toBeNull();
  });

  it("defaults TTL to 1h when PAPERCLIP_AGENT_JWT_TTL_SECONDS is unset", () => {
    delete process.env[ttlEnv];
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).not.toBeNull();
    expect(claims!.exp - claims!.iat).toBe(60 * 60);
  });

  // Helper: hand-craft a token signed with the raw master secret (legacy path).
  function craftLegacyMasterSecretToken(masterSecret: string, companyId: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = {
      sub: "agent-legacy",
      company_id: companyId,
      adapter_type: "claude_local",
      run_id: "run-legacy",
      iat: now,
      exp: now + 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const legacySig = createHmac("sha256", masterSecret).update(signingInput).digest("base64url");
    return `${signingInput}.${legacySig}`;
  }

  it("accepts master-secret-signed tokens only with explicit legacy fallback opt-in", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[enableLegacyFallbackEnv] = "true";
    const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
    const verified = verifyLocalAgentJwt(legacyToken);
    expect(verified).not.toBeNull();
    expect(verified!.company_id).toBe("company-legacy");
  });

  it("rejects master-secret-signed tokens when legacy fallback opt-in is absent", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
    expect(verifyLocalAgentJwt(legacyToken)).toBeNull();
  });

  it("rejects master-secret-signed tokens when PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK is enabled", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[enableLegacyFallbackEnv] = "true";
    process.env[disableLegacyFallbackEnv] = "true";
    const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
    expect(verifyLocalAgentJwt(legacyToken)).toBeNull();
  });

  it.each(["false", "1", "yes", "on", "random", ""])(
    "does not enable legacy fallback for malformed opt-in value %j",
    (value) => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      process.env[enableLegacyFallbackEnv] = value;
      const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
      expect(verifyLocalAgentJwt(legacyToken)).toBeNull();
    },
  );

  it("still verifies per-company-signed tokens when PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK is enabled", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[disableLegacyFallbackEnv] = "true";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).not.toBeNull();
    const verified = verifyLocalAgentJwt(token!);
    expect(verified).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });
});
