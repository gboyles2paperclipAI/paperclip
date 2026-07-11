import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = new URL("./verify-package-integrity.sh", import.meta.url).pathname;

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-integrity-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, contents);
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runVerifier(target) {
  try {
    const output = execFileSync("bash", [scriptPath, target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output, status: 0 };
  } catch (error) {
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status ?? 1,
    };
  }
}

const cappedAgentsRoute = `
const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 50)) : 50;
const runs = await heartbeat.list(companyId, agentId, limit, { summary });
`;
const hardenedAgentJwt = `
const legacyFallbackEnabled =
  process.env.PAPERCLIP_AGENT_JWT_ENABLE_LEGACY_FALLBACK?.trim().toLowerCase() === "true" &&
  !parseBooleanEnv(process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK);
`;
const hardenedCompaniesRoute = `
if (opts.companyDeletionEnabled !== true) {
  throw forbidden("Company deletion is disabled");
}
const company = await svc.remove(companyId);
`;
const hardenedConfig = `
const companyDeletionEnabled = process.env.PAPERCLIP_ENABLE_COMPANY_DELETION?.trim().toLowerCase() === "true";
`;
const hardenedBoardChat = "const env = buildSafeInheritedProcessEnv({});\n";
const hardenedWorkspaceRuntime = "const env = sanitizeRuntimeServiceBaseEnv({});\n";
const hardenedBetterAuth = `
const secret = process.env.BETTER_AUTH_SECRET?.trim();
const agentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
if (!secret) throw new Error("BETTER_AUTH_SECRET must be set in authenticated mode");
if (agentJwtSecret && secret === agentJwtSecret) {
  throw new Error("BETTER_AUTH_SECRET and PAPERCLIP_AGENT_JWT_SECRET must be distinct");
}
`;
const staleBetterAuth = `
const secret = process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
`;
const hardenedCliEntrypoint = `
const serverPackageSpecifier = "@paperclipai/server";
const secret = process.env.BETTER_AUTH_SECRET?.trim();
const message = "authenticated mode requires BETTER_AUTH_SECRET";
`;
const staleCliEntrypoint = `
const serverPackageSpecifier = "@paperclipai/server";
const secret = process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
const message = "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)";
`;

test("passes when a built dist contains every mandatory marker", () => {
  const root = makeFixture({
    "agent-auth-jwt.js": hardenedAgentJwt,
    "auth/better-auth.js": hardenedBetterAuth,
    "config.js": hardenedConfig,
    "routes/board-chat.js": hardenedBoardChat,
    "routes/agents.js": cappedAgentsRoute,
    "routes/companies.js": hardenedCompaniesRoute,
    "routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
    "services/workspace-runtime.js": hardenedWorkspaceRuntime,
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0);
    assert.match(result.output, /Package integrity check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an installed package root containing dist", () => {
  const root = makeFixture({
    "dist/agent-auth-jwt.js": hardenedAgentJwt,
    "dist/auth/better-auth.js": hardenedBetterAuth,
    "dist/config.js": hardenedConfig,
    "dist/routes/board-chat.js": hardenedBoardChat,
    "dist/routes/agents.js": cappedAgentsRoute,
    "dist/routes/companies.js": hardenedCompaniesRoute,
    "dist/routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "dist/services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
    "dist/services/workspace-runtime.js": hardenedWorkspaceRuntime,
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an installed service package and validates its resolved server package", () => {
  const root = makeFixture({
    "paperclipai/package.json": JSON.stringify({ name: "paperclipai" }),
    "paperclipai/dist/index.js": hardenedCliEntrypoint,
    "@paperclipai/server/dist/agent-auth-jwt.js": hardenedAgentJwt,
    "@paperclipai/server/dist/auth/better-auth.js": hardenedBetterAuth,
    "@paperclipai/server/dist/config.js": hardenedConfig,
    "@paperclipai/server/dist/routes/board-chat.js": hardenedBoardChat,
    "@paperclipai/server/dist/routes/agents.js": cappedAgentsRoute,
    "@paperclipai/server/dist/routes/companies.js": hardenedCompaniesRoute,
    "@paperclipai/server/dist/routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "@paperclipai/server/dist/services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
    "@paperclipai/server/dist/services/workspace-runtime.js": hardenedWorkspaceRuntime,
  });
  try {
    const result = runVerifier(join(root, "paperclipai"));
    assert.equal(result.status, 0);
    assert.match(result.output, /service entrypoint/);
    assert.match(result.output, /@paperclipai\/server\/dist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails and names the service entrypoint when CLI auth falls back to agent JWT secret", () => {
  const root = makeFixture({
    "paperclipai/package.json": JSON.stringify({ name: "paperclipai" }),
    "paperclipai/dist/index.js": staleCliEntrypoint,
    "@paperclipai/server/dist/agent-auth-jwt.js": hardenedAgentJwt,
    "@paperclipai/server/dist/auth/better-auth.js": hardenedBetterAuth,
    "@paperclipai/server/dist/config.js": hardenedConfig,
    "@paperclipai/server/dist/routes/board-chat.js": hardenedBoardChat,
    "@paperclipai/server/dist/routes/agents.js": cappedAgentsRoute,
    "@paperclipai/server/dist/routes/companies.js": hardenedCompaniesRoute,
    "@paperclipai/server/dist/routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "@paperclipai/server/dist/services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
    "@paperclipai/server/dist/services/workspace-runtime.js": hardenedWorkspaceRuntime,
  });
  try {
    const target = join(root, "paperclipai", "dist", "index.js");
    const result = runVerifier(target);
    assert.equal(result.status, 1);
    assert.match(result.output, /CLI auth check must not fall back to agent JWT secret/);
    assert.match(result.output, /paperclipai\/dist\/index[.]js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when the built Better Auth module falls back to the agent JWT secret", () => {
  const root = makeFixture({
    "agent-auth-jwt.js": hardenedAgentJwt,
    "auth/better-auth.js": staleBetterAuth,
    "config.js": hardenedConfig,
    "routes/board-chat.js": hardenedBoardChat,
    "routes/agents.js": cappedAgentsRoute,
    "routes/companies.js": hardenedCompaniesRoute,
    "routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
    "services/heartbeat.js": "function premiumManagedMaxConcurrentRuns() { return 2; }\n",
    "services/workspace-runtime.js": hardenedWorkspaceRuntime,
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /Better Auth trimmed secret must not fall back to agent JWT secret/);
    assert.match(result.output, /auth\/better-auth[.]js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails and lists missing markers for stale uncapped dist", () => {
  const root = makeFixture({
    "routes/agents.js": `
const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
const runs = await heartbeat.list(companyId, agentId);
`,
    "routes/issues.js": "const code = 'pending_issue_thread_interaction';\n",
  });
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /missing: heartbeat-runs default limit cap/);
    assert.match(result.output, /missing: heartbeat-runs capped list call/);
    assert.match(result.output, /missing: #51 premium managed concurrency marker/);
    assert.match(result.output, /missing: DELETE route fail-closed marker/);
    assert.match(result.output, /missing: explicit legacy fallback opt-in marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
