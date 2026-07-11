import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentAuthCheck } from "../checks/deployment-auth-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const originalEnv = {
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  agentJwtSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
};

const authenticatedConfig = {
  server: {
    deploymentMode: "authenticated",
    exposure: "private",
    bind: "lan",
    host: "0.0.0.0",
  },
  auth: {
    baseUrlMode: "auto",
    disableSignUp: false,
  },
} as PaperclipConfig;

describe("deployment auth check", () => {
  beforeEach(() => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  afterEach(() => {
    if (originalEnv.betterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.betterAuthSecret;
    if (originalEnv.agentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalEnv.agentJwtSecret;
  });

  it("rejects authenticated mode when only the agent JWT secret is configured", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-only-secret";

    const result = deploymentAuthCheck(authenticatedConfig);

    expect(result.status).toBe("fail");
    expect(result.message).toBe("authenticated mode requires BETTER_AUTH_SECRET");
  });

  it("accepts authenticated mode with a dedicated Better Auth secret", () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret";

    const result = deploymentAuthCheck(authenticatedConfig);

    expect(result.status).toBe("pass");
  });
});
