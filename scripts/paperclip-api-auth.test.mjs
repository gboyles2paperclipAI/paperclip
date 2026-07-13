import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  deploymentModeFromHealth,
  fetchPaperclipJson,
  paperclipRequestUrl,
  protectedPaperclipHeaders,
} from "./lib/paperclip-api-auth.mjs";
import { createApiClient as createTerminalBenchApiClient } from "./smoke/terminal-bench-loop-skill-smoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationalScript = path.join(repoRoot, "scripts", "check-paperclip-agents-operational.mjs");
const evidenceScript = path.join(repoRoot, "scripts", "approval-evidence-report.mjs");
const shellHelper = path.join(repoRoot, "scripts", "lib", "paperclip-api-auth.sh");
const issueUpdateScript = path.join(repoRoot, "scripts", "paperclip-issue-update.sh");
const pipelineSmokeScript = path.join(repoRoot, "scripts", "smoke", "pipelines-tutorial-smoke.sh");

async function createFakeCurl(directory) {
  const fakeCurl = path.join(directory, "curl");
  await writeFile(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "--disable" ]] || exit 96
printf 'CALL\\n' >> "$FAKE_CURL_ARGV_LOG"
for arg in "$@"; do
  if [[ -n "\${PAPERCLIP_API_KEY:-}" && "$arg" == *"$PAPERCLIP_API_KEY"* ]]; then
    exit 97
  fi
  printf '%s\\n' "$arg" >> "$FAKE_CURL_ARGV_LOG"
done
if [[ "\${FAKE_CURL_EXIT_CODE:-0}" != "0" ]]; then
  exit "$FAKE_CURL_EXIT_CODE"
fi
headers_file=""
body_file=""
write_format=""
config_file=""
args=("$@")
for ((index = 0; index < \${#args[@]}; index += 1)); do
  case "\${args[$index]}" in
    -D|--dump-header) headers_file="\${args[$((index + 1))]}" ;;
    -o|--output) body_file="\${args[$((index + 1))]}" ;;
    -w|--write-out) write_format="\${args[$((index + 1))]}" ;;
    --config) config_file="\${args[$((index + 1))]}" ;;
  esac
done
if [[ -n "$config_file" ]]; then
  [[ "$(stat -c %a "$config_file")" == "600" ]] || exit 98
  [[ "$(<"$config_file")" == *"Authorization: Bearer $PAPERCLIP_API_KEY"* ]] || exit 99
fi
url="\${args[$((\${#args[@]} - 1))]}"
if [[ -n "$headers_file" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n' > "$headers_file"
fi
if [[ -n "$body_file" && "$body_file" != "/dev/null" ]]; then
  printf '{"status":"ok","deploymentMode":"authenticated","deploymentExposure":"private"}' > "$body_file"
fi
if [[ -n "$write_format" ]]; then
  printf '200\\n%s\\n' "$url"
elif [[ -z "$body_file" ]]; then
  printf '{"ok":true}\\n'
fi
`);
  await chmod(fakeCurl, 0o755);
  return fakeCurl;
}

async function startPaperclipStub(input) {
  const options = typeof input === "string" ? { deploymentMode: input } : input;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization ?? null,
    });
    if (request.url === "/api/health") {
      response.statusCode = options.healthStatus ?? 200;
      response.setHeader("Content-Type", options.healthContentType ?? "application/json");
      if (options.healthLocation) response.setHeader("Location", options.healthLocation);
      response.end(options.healthBody ?? JSON.stringify({
        status: "ok",
        deploymentMode: options.deploymentMode,
        deploymentExposure: "private",
      }));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/protected-redirect") {
      response.statusCode = 302;
      response.setHeader("Location", options.protectedLocation);
      response.end(JSON.stringify({ redirect: true }));
      return;
    }
    if (request.url?.endsWith("/dashboard")) {
      response.end(JSON.stringify({ agents: {}, tasks: {}, pendingApprovals: 0 }));
      return;
    }
    if (request.url?.endsWith("/agents")) {
      response.end("[]");
      return;
    }
    if (request.url === "/api/companies") {
      response.end("[]");
      return;
    }
    if (request.url?.includes("/live-runs")) {
      response.end("[]");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runOperationalCheck({ deploymentMode, apiKey, ...stubOptions }) {
  const stub = await startPaperclipStub({ deploymentMode, ...stubOptions });
  const outDir = await mkdtemp(path.join(tmpdir(), "paperclip-operational-auth-"));
  const env = { ...process.env };
  if (apiKey === undefined) delete env.PAPERCLIP_API_KEY;
  else env.PAPERCLIP_API_KEY = apiKey;
  try {
    const result = await runAsync(
      process.execPath,
      [operationalScript, "--base-url", stub.baseUrl, "--company-id", "company-unit", "--out-dir", outDir],
      { env },
    );
    return { ...result, requests: stub.requests, outDir };
  } finally {
    await stub.close();
  }
}

test("auth helper accepts only canonical deployment modes", () => {
  assert.equal(deploymentModeFromHealth({ deploymentMode: "local_trusted" }), "local_trusted");
  assert.equal(deploymentModeFromHealth({ deploymentMode: "authenticated" }), "authenticated");
  assert.equal(deploymentModeFromHealth({ deploymentMode: "  authenticated\t" }), "authenticated");
  assert.throws(() => deploymentModeFromHealth({ deploymentMode: "Authenticated" }), /unsupported deployment mode/);
  assert.throws(() => deploymentModeFromHealth({ deploymentMode: "unknown" }), /unsupported deployment mode/);
  assert.throws(() => deploymentModeFromHealth({}), /unsupported deployment mode/);
});

test("URL helper rejects cross-origin, credentialed, and non-HTTP origin tricks", () => {
  assert.equal(
    paperclipRequestUrl("http://example.test:80/base", "/api/health").href,
    "http://example.test/api/health",
  );
  for (const [apiUrl, requestUrl] of [
    ["http://example.test", "//evil.test/api/companies"],
    ["http://example.test", "https://evil.test/api/companies"],
    ["http://example.test", "http://user:pass@example.test/api/companies"],
    ["http://user:pass@example.test", "/api/companies"],
    ["http://example.test", "javascript:alert(1)"],
    ["http://example.test", "http://example.test.evil.test/api/companies"],
  ]) {
    assert.throws(() => paperclipRequestUrl(apiUrl, requestUrl), /HTTP\(S\)|different origin|without embedded/);
  }
});

test("auth helper injects a canonical key only for the Paperclip origin", () => {
  const key = "unit-board-value-123";
  const headers = protectedPaperclipHeaders({
    health: { deploymentMode: "authenticated" },
    apiUrl: "http://127.0.0.1:3100",
    requestUrl: "http://127.0.0.1:3100/api/companies",
    env: { PAPERCLIP_API_KEY: key },
  });
  assert.equal(headers.Authorization, `Bearer ${key}`);
  assert.throws(
    () => protectedPaperclipHeaders({
      health: { deploymentMode: "authenticated" },
      apiUrl: "http://127.0.0.1:3100",
      requestUrl: "https://example.invalid/api/companies",
      env: { PAPERCLIP_API_KEY: key },
    }),
    /different origin/,
  );
});

test("operational checker preserves local_trusted headerless compatibility", async () => {
  const result = await runOperationalCheck({ deploymentMode: "local_trusted" });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests[0].path, "/api/health");
    assert.ok(result.requests.every((request) => request.authorization === null));
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("operational checker keeps health public and authenticates every protected request", async () => {
  const key = "unit-board-value-456";
  const result = await runOperationalCheck({ deploymentMode: "authenticated", apiKey: key });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests[0].path, "/api/health");
    assert.equal(result.requests[0].authorization, null);
    assert.ok(result.requests.slice(1).length >= 3);
    assert.ok(result.requests.slice(1).every((request) => request.authorization === `Bearer ${key}`));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    const names = await readdir(result.outDir);
    const jsonName = names.find((name) => name.endsWith(".json"));
    assert.ok(jsonName);
    assert.doesNotMatch(await readFile(path.join(result.outDir, jsonName), "utf8"), new RegExp(key));
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("operational checker fails closed before protected calls when key is missing", async () => {
  const result = await runOperationalCheck({ deploymentMode: "authenticated" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAPERCLIP_API_KEY is required/);
    assert.deepEqual(result.requests.map((request) => request.path), ["/api/health"]);
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("operational checker fails closed before protected calls for malformed mode", async () => {
  const result = await runOperationalCheck({ deploymentMode: "unexpected" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported deployment mode/);
    assert.deepEqual(result.requests.map((request) => request.path), ["/api/health"]);
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("operational checker rejects non-JSON health before protected calls", async () => {
  const result = await runOperationalCheck({
    deploymentMode: "authenticated",
    apiKey: "unit-non-json-key",
    healthContentType: "text/html",
    healthBody: '<script>window.mode="local_trusted"</script>',
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JSON content type/);
    assert.deepEqual(result.requests.map((request) => request.path), ["/api/health"]);
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("health redirect cannot spoof deployment mode or trigger protected calls", async () => {
  const spoof = await startPaperclipStub("local_trusted");
  try {
    const result = await runOperationalCheck({
      deploymentMode: "authenticated",
      apiKey: "unit-redirect-key",
      healthStatus: 302,
      healthLocation: `${spoof.baseUrl}/api/health`,
    });
    try {
      assert.equal(result.status, 1);
      assert.deepEqual(result.requests.map((request) => request.path), ["/api/health"]);
      assert.equal(spoof.requests.length, 0);
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
    }
  } finally {
    await spoof.close();
  }
});

test("protected JSON fetch refuses redirects without forwarding credentials", async () => {
  const spoof = await startPaperclipStub("authenticated");
  const origin = await startPaperclipStub({
    deploymentMode: "authenticated",
    protectedLocation: `${spoof.baseUrl}/api/companies`,
  });
  const key = "unit-protected-redirect-key";
  try {
    await assert.rejects(() => fetchPaperclipJson({
      apiUrl: origin.baseUrl,
      requestUrl: "/api/protected-redirect",
      headers: { Authorization: `Bearer ${key}` },
    }));
    assert.equal(origin.requests.length, 1);
    assert.equal(origin.requests[0].authorization, `Bearer ${key}`);
    assert.equal(spoof.requests.length, 0);
  } finally {
    await origin.close();
    await spoof.close();
  }
});

test("JSON fetch rejects a mismatched final response origin", async () => {
  await assert.rejects(() => fetchPaperclipJson({
    apiUrl: "http://paperclip.test",
    requestUrl: "/api/health",
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return {
        url: "https://spoof.test/api/health",
        headers: new Headers({ "Content-Type": "application/json" }),
        json: async () => ({ deploymentMode: "local_trusted" }),
      };
    },
  }), /different origin/);
});

test("JSON fetch enforces a bounded request timeout", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(() => fetchPaperclipJson({
      apiUrl: "http://paperclip.test",
      requestUrl: "/api/health",
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    }), (error) => error?.name === "TimeoutError");
  } finally {
    clearTimeout(keepAlive);
  }
  await assert.rejects(() => fetchPaperclipJson({
    apiUrl: "http://paperclip.test",
    requestUrl: "/api/health",
    timeoutMs: 300_001,
  }), /timeout must be between/);
});

test("terminal-bench client uses same-origin redirect-safe in-process authentication", async () => {
  const spoof = await startPaperclipStub("authenticated");
  const origin = await startPaperclipStub({
    deploymentMode: "authenticated",
    protectedLocation: `${spoof.baseUrl}/api/companies`,
  });
  const key = "unit-terminal-client-value";
  const api = createTerminalBenchApiClient({ apiUrl: origin.baseUrl, apiKey: key, runId: "run-unit" });
  try {
    assert.deepEqual(await api("GET", "/api/companies"), []);
    assert.equal(origin.requests[0].authorization, `Bearer ${key}`);
    await assert.rejects(() => api("GET", "/api/protected-redirect"));
    assert.equal(spoof.requests.length, 0);

    const credentialedOriginApi = createTerminalBenchApiClient({
      apiUrl: "http://user:pass@paperclip.test",
      apiKey: key,
      runId: null,
    });
    await assert.rejects(() => credentialedOriginApi("GET", "/api/companies"), /without embedded credentials/);
  } finally {
    await origin.close();
    await spoof.close();
  }
});

test("approval evidence keeps health public and authenticates an explicit live-runs read", async () => {
  const key = "unit-board-value-789";
  const stub = await startPaperclipStub("authenticated");
  const env = { ...process.env, PAPERCLIP_API_URL: stub.baseUrl, PAPERCLIP_API_KEY: key };
  try {
    const result = await runAsync(process.execPath, [
      evidenceScript,
      "--health-url", `${stub.baseUrl}/api/health`,
      "--live-runs-url", `${stub.baseUrl}/api/companies/company-unit/live-runs`,
    ], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stub.requests[0].authorization, null);
    assert.equal(stub.requests[1].authorization, `Bearer ${key}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
  } finally {
    await stub.close();
  }
});

test("shell and JavaScript helpers share whitespace and case-sensitive mode semantics", () => {
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
paperclip_prepare_protected_auth
paperclip_require_protected_auth_for_mode "$MODE"
paperclip_cleanup_protected_auth
`;
  const cases = [
    { mode: "local_trusted", key: undefined, success: true },
    { mode: "  local_trusted\t", key: undefined, success: true },
    { mode: "authenticated", key: "unit-shell-value", success: true },
    { mode: " authenticated ", key: "  unit-shell-value  ", success: true },
    { mode: "authenticated", key: undefined, success: false },
    { mode: "Authenticated", key: "unit-shell-value", success: false },
    { mode: "malformed", key: "unit-shell-value", success: false },
  ];

  for (const item of cases) {
    const env = { ...process.env, AUTH_HELPER: shellHelper, MODE: item.mode };
    delete env.PAPERCLIP_API_KEY;
    delete env.PAPERCLIP_AUTH_HEADER;
    delete env.PAPERCLIP_COOKIE;
    if (item.key !== undefined) env.PAPERCLIP_API_KEY = item.key;
    const result = spawnSync("bash", ["-c", script], { cwd: repoRoot, encoding: "utf8", env });
    assert.equal(result.status === 0, item.success, `${item.mode}: ${result.stderr}`);
    if (item.key) assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unit-shell-value/);
  }
});

test("shell transport timeout constants ignore ambient values and cannot be mutated after source", () => {
  const names = [
    "_PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS",
    "_PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS",
    "_PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS",
  ];
  const loaded = spawnSync("bash", ["-c", `
set -euo pipefail
source "$AUTH_HELPER"
printf '%s\\n' "$_PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS" "$_PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS" "$_PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS"
declare -p _PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS _PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS _PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS
source "$AUTH_HELPER"
`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTH_HELPER: shellHelper,
      _PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS: "1",
      _PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS: "1",
      _PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS: "1",
    },
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /^10\n30\n300\n/);
  for (const name of names) {
    assert.match(loaded.stdout, new RegExp(`declare -r ${name}=`));
    const mutation = spawnSync("bash", ["-c", `
set -euo pipefail
source "$AUTH_HELPER"
printf -v "$TIMEOUT_NAME" '%s' 1
`], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, AUTH_HELPER: shellHelper, TIMEOUT_NAME: name },
    });
    assert.notEqual(mutation.status, 0, `${name} unexpectedly remained mutable`);
  }
});

test("documented legacy operator header and cookie compatibility remains fail-closed", () => {
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
paperclip_prepare_protected_auth
paperclip_require_protected_auth_for_mode authenticated
[[ "$(stat -c %a "$PAPERCLIP_PROTECTED_CURL_CONFIG")" == 600 ]]
paperclip_cleanup_protected_auth
`;
  for (const credential of [
    { PAPERCLIP_AUTH_HEADER: "Bearer unit-legacy-header" },
    { PAPERCLIP_COOKIE: "session=unit-legacy-cookie" },
  ]) {
    const env = { ...process.env, AUTH_HELPER: shellHelper, ...credential };
    delete env.PAPERCLIP_API_KEY;
    const result = spawnSync("bash", ["-c", script], { cwd: repoRoot, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unit-legacy/);
  }
});

test("shell transport trims keys, restores xtrace, uses a 0600 curl config, and never follows redirects", async () => {
  const spoof = await startPaperclipStub("authenticated");
  const origin = await startPaperclipStub({
    deploymentMode: " authenticated ",
    protectedLocation: `${spoof.baseUrl}/api/companies`,
  });
  const curlHome = await mkdtemp(path.join(tmpdir(), "paperclip-hostile-curl-home-"));
  await writeFile(
    path.join(curlHome, ".curlrc"),
    `url = "${spoof.baseUrl}/api/companies"\ntrace-ascii = "-"\n`,
  );
  const key = "unit-shell-xtrace-value";
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
set -x
paperclip_public_health_preflight "$PAPERCLIP_API_URL"
paperclip_prepare_protected_auth
[[ "$-" == *x* ]]
paperclip_require_protected_auth_for_mode "$PAPERCLIP_DEPLOYMENT_MODE"
[[ "$(stat -c %a "$PAPERCLIP_PROTECTED_CURL_CONFIG")" == 600 ]]
code="$(paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/companies" --output /dev/null --write-http-code)"
[[ "$code" == 200 ]]
redirect_code="$(paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/protected-redirect" --output /dev/null --write-http-code)"
[[ "$redirect_code" == 302 ]]
config_path="$PAPERCLIP_PROTECTED_CURL_CONFIG"
paperclip_cleanup_protected_auth
[[ "$-" == *x* ]]
[[ ! -e "$config_path" ]]
`;
  const env = {
    ...process.env,
    AUTH_HELPER: shellHelper,
    CURL_HOME: curlHome,
    HTTP_PROXY: spoof.baseUrl,
    HTTPS_PROXY: spoof.baseUrl,
    ALL_PROXY: spoof.baseUrl,
    NO_PROXY: "",
    no_proxy: "",
    PAPERCLIP_API_URL: origin.baseUrl,
    PAPERCLIP_API_KEY: `  ${key}\t`,
  };
  try {
    const result = await runAsync("bash", ["-c", script], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    assert.equal(origin.requests[0].path, "/api/health");
    assert.equal(origin.requests[0].authorization, null);
    assert.equal(origin.requests[1].authorization, `Bearer ${key}`);
    assert.equal(origin.requests[2].path, "/api/protected-redirect");
    assert.equal(origin.requests[2].authorization, `Bearer ${key}`);
    assert.equal(spoof.requests.length, 0);
  } finally {
    await rm(curlHome, { recursive: true, force: true });
    await origin.close();
    await spoof.close();
  }
});

test("shell protected transport preserves local_trusted headerless requests", async () => {
  const origin = await startPaperclipStub("local_trusted");
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
paperclip_public_health_preflight "$PAPERCLIP_API_URL"
paperclip_prepare_protected_auth
paperclip_require_protected_auth_for_mode "$PAPERCLIP_DEPLOYMENT_MODE"
code="$(paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/companies" --output /dev/null --write-http-code)"
paperclip_cleanup_protected_auth
[[ "$code" == 200 ]]
`;
  const env = { ...process.env, AUTH_HELPER: shellHelper, PAPERCLIP_API_URL: origin.baseUrl };
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_AUTH_HEADER;
  delete env.PAPERCLIP_COOKIE;
  try {
    const result = await runAsync("bash", ["-c", script], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(origin.requests.map((request) => request.path), ["/api/health", "/api/companies"]);
    assert.ok(origin.requests.every((request) => request.authorization === null));
  } finally {
    await origin.close();
  }
});

test("shell health preflight rejects redirects, non-JSON, and cross-origin request tricks", async () => {
  const spoof = await startPaperclipStub("local_trusted");
  const redirect = await startPaperclipStub({
    deploymentMode: "authenticated",
    healthStatus: 302,
    healthLocation: `${spoof.baseUrl}/api/health`,
  });
  const nonJson = await startPaperclipStub({
    deploymentMode: "authenticated",
    healthContentType: "text/plain",
    healthBody: '{"deploymentMode":"local_trusted"}',
  });
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
paperclip_public_health_preflight "$PAPERCLIP_API_URL"
`;
  try {
    for (const baseUrl of [redirect.baseUrl, nonJson.baseUrl]) {
      const result = await runAsync("bash", ["-c", script], {
        env: { ...process.env, AUTH_HELPER: shellHelper, PAPERCLIP_API_URL: baseUrl },
      });
      assert.notEqual(result.status, 0);
    }
    assert.equal(spoof.requests.length, 0);

    const originTrick = spawnSync("bash", ["-c", `
set -euo pipefail
source "$AUTH_HELPER"
! paperclip_resolve_api_url "http://example.test" "//evil.test/api/companies"
! paperclip_resolve_api_url "http://user:pass@example.test" "/api/companies"
`], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, AUTH_HELPER: shellHelper } });
    assert.equal(originTrick.status, 0, originTrick.stderr);
  } finally {
    await redirect.close();
    await nonJson.close();
    await spoof.close();
  }
});

test("shell transport keeps keys off argv and xtrace while rejecting hostile curl options", async () => {
  const fakeDir = await mkdtemp(path.join(tmpdir(), "paperclip-fake-curl-"));
  const argvLog = path.join(fakeDir, "argv.log");
  await createFakeCurl(fakeDir);
  const key = "unit-fake-curl-value";
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
set -x
paperclip_public_health_preflight "$PAPERCLIP_API_URL"
paperclip_require_api_key
paperclip_prepare_protected_auth
paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --method GET --output /dev/null
before_hostile="$(wc -l < "$FAKE_CURL_ARGV_LOG")"
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --trace-ascii /dev/stderr
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --verbose
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --next
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --url https://evil.test/api/issues/unit
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --location
! paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --config /tmp/hostile-curl-config
! paperclip_protected_curl "$PAPERCLIP_API_URL" "https://evil.test/api/issues/unit" --method GET
after_hostile="$(wc -l < "$FAKE_CURL_ARGV_LOG")"
[[ "$before_hostile" == "$after_hostile" ]]
config_path="$PAPERCLIP_PROTECTED_CURL_CONFIG"
paperclip_cleanup_protected_auth
[[ "$-" == *x* ]]
[[ ! -e "$config_path" ]]
`;
  try {
    const result = await runAsync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH}`,
        AUTH_HELPER: shellHelper,
        FAKE_CURL_ARGV_LOG: argvLog,
        PAPERCLIP_API_URL: "http://paperclip.test",
        PAPERCLIP_API_KEY: key,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    const argv = await readFile(argvLog, "utf8");
    assert.doesNotMatch(argv, new RegExp(key));
    assert.match(argv, /--connect-timeout\n10\n/);
    assert.match(argv, /--max-time\n30\n/);
    assert.match(argv, /--max-time\n300\n/);
    assert.match(argv, /--max-redirs\n0\n/);
    assert.match(argv, /--noproxy\n\*\n/);
    assert.doesNotMatch(argv, /evil\.test/);
    assert.doesNotMatch(argv, /trace|verbose|--next|--url|--location|hostile-curl-config/);
    assert.equal((argv.match(/^CALL$/gm) ?? []).length, 2);
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
});

test("shell public and protected transports propagate fake curl timeouts", async () => {
  const fakeDir = await mkdtemp(path.join(tmpdir(), "paperclip-timeout-curl-"));
  const argvLog = path.join(fakeDir, "argv.log");
  await createFakeCurl(fakeDir);
  const script = `
set -euo pipefail
source "$AUTH_HELPER"
if paperclip_public_health_preflight "$PAPERCLIP_API_URL"; then exit 41; fi
paperclip_require_api_key
paperclip_prepare_protected_auth
set +e
paperclip_protected_curl "$PAPERCLIP_API_URL" "/api/issues/unit" --method GET >/dev/null
status=$?
set -e
paperclip_cleanup_protected_auth
[[ "$status" == 28 ]]
`;
  try {
    const result = await runAsync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH}`,
        AUTH_HELPER: shellHelper,
        FAKE_CURL_ARGV_LOG: argvLog,
        FAKE_CURL_EXIT_CODE: "28",
        PAPERCLIP_API_URL: "http://paperclip.test",
        PAPERCLIP_API_KEY: "unit-timeout-value",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = await readFile(argvLog, "utf8");
    assert.match(argv, /--max-time\n30\n/);
    assert.match(argv, /--max-time\n300\n/);
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
});

test("issue update caller keeps required API key off curl argv and xtrace", async () => {
  const fakeDir = await mkdtemp(path.join(tmpdir(), "paperclip-issue-update-curl-"));
  const argvLog = path.join(fakeDir, "argv.log");
  await createFakeCurl(fakeDir);
  const key = "unit-issue-update-value";
  const env = {
    ...process.env,
    PATH: `${fakeDir}:${process.env.PATH}`,
    FAKE_CURL_ARGV_LOG: argvLog,
    PAPERCLIP_API_URL: "http://paperclip.test",
    PAPERCLIP_API_KEY: key,
    PAPERCLIP_RUN_ID: "run-unit",
  };
  try {
    const result = await runAsync("bash", [
      "-x",
      issueUpdateScript,
      "--issue-id", "issue-unit",
      "--status", "done",
      "--comment", "focused update",
    ], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    const argv = await readFile(argvLog, "utf8");
    assert.doesNotMatch(argv, new RegExp(key));
    assert.match(argv, /--config/);
    assert.match(argv, /--connect-timeout\n10\n/);
    assert.match(argv, /--max-time\n300\n/);
    assert.match(argv, /http:\/\/paperclip\.test\/api\/issues\/issue-unit/);

    const beforeRejectedOrigin = await readFile(argvLog, "utf8");
    const rejected = await runAsync("bash", [
      "-x",
      issueUpdateScript,
      "--issue-id", "issue-unit",
      "--status", "done",
    ], { env: { ...env, PAPERCLIP_API_URL: "http://user:pass@paperclip.test" } });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(key));
    assert.equal(await readFile(argvLog, "utf8"), beforeRejectedOrigin);

    const missingUrlEnv = { ...env };
    delete missingUrlEnv.PAPERCLIP_API_URL;
    const missingUrl = await runAsync("bash", [
      issueUpdateScript,
      "--issue-id", "issue-unit",
      "--status", "done",
    ], { env: missingUrlEnv });
    assert.notEqual(missingUrl.status, 0);
    assert.match(missingUrl.stderr, /Missing PAPERCLIP_API_URL or PAPERCLIP_RUN_ID\./);
    assert.doesNotMatch(missingUrl.stderr, /PAPERCLIP_API_KEY/);
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
});

test("pipeline tutorial API transport keeps keys off argv and xtrace and rejects foreign origins", async () => {
  const fakeDir = await mkdtemp(path.join(tmpdir(), "paperclip-pipeline-curl-"));
  const argvLog = path.join(fakeDir, "argv.log");
  await createFakeCurl(fakeDir);
  await writeFile(path.join(fakeDir, ".curlrc"), 'url = "http://evil.test/from-curlrc"\n');
  const key = "unit-pipeline-value";
  const script = `
set -euo pipefail
source "$PIPELINE_SMOKE_SCRIPT"
set -x
paperclip_require_api_key
paperclip_prepare_protected_auth
api_json GET "/api/issues/unit" >/dev/null
! api_json GET "https://evil.test/api/issues/unit"
config_path="$PAPERCLIP_PROTECTED_CURL_CONFIG"
paperclip_cleanup_protected_auth
[[ "$-" == *x* ]]
[[ ! -e "$config_path" ]]
`;
  try {
    const result = await runAsync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH}`,
        AUTH_HELPER: shellHelper,
        PIPELINE_SMOKE_SCRIPT: pipelineSmokeScript,
        FAKE_CURL_ARGV_LOG: argvLog,
        CURL_HOME: fakeDir,
        HTTP_PROXY: "http://evil.test:8080",
        HTTPS_PROXY: "http://evil.test:8080",
        NO_PROXY: "",
        PAPERCLIP_API_URL: "http://paperclip.test",
        PAPERCLIP_API_KEY: key,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    const argv = await readFile(argvLog, "utf8");
    assert.doesNotMatch(argv, new RegExp(key));
    assert.match(argv, /^CALL\n--disable\n/);
    assert.match(argv, /--config\n/);
    assert.match(argv, /--noproxy\n\*\n/);
    assert.match(argv, /--connect-timeout\n10\n/);
    assert.match(argv, /--max-time\n300\n/);
    assert.match(argv, /http:\/\/paperclip\.test\/api\/issues\/unit/);
    assert.doesNotMatch(argv, /evil\.test/);
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
});

test("inventory candidates retain the expected protected/public classification", async () => {
  const files = Object.fromEntries(await Promise.all([
    "scripts/check-paperclip-agents-operational.mjs",
    "scripts/docker-onboard-smoke.sh",
    "scripts/generate-org-chart-satori-comparison.ts",
    "scripts/ops/help2day/fleet-health-check.sh",
    "scripts/smoke/openclaw-join.sh",
    "scripts/smoke/hermes-gateway-join.sh",
    "scripts/smoke/hermes-gateway-e2e.sh",
    "scripts/smoke/openclaw-gateway-e2e.sh",
    "scripts/smoke/openclaw-sse-standalone.sh",
    "scripts/approval-evidence-report.mjs",
    "scripts/paperclip-issue-update.sh",
    "scripts/smoke/pipelines-tutorial-smoke.sh",
    "scripts/smoke/terminal-bench-loop-skill-smoke.mjs",
  ].map(async (name) => [name, await readFile(path.join(repoRoot, name), "utf8")])));

  assert.match(files["scripts/check-paperclip-agents-operational.mjs"], /protectedPaperclipHeaders/);
  assert.match(files["scripts/docker-onboard-smoke.sh"], /get_with_cookies.*\/api\/companies/s);
  assert.doesNotMatch(files["scripts/generate-org-chart-satori-comparison.ts"], /\bfetch\s*\(/);
  assert.match(files["scripts/ops/help2day/fleet-health-check.sh"], /probe_http http:\/\/127\.0\.0\.1:3100\//);
  assert.doesNotMatch(files["scripts/ops/help2day/fleet-health-check.sh"], /\/api\/(companies|agents|issues|approvals)/);
  assert.match(files["scripts/smoke/openclaw-join.sh"], /paperclip_require_protected_auth_for_mode/);
  for (const name of [
    "scripts/smoke/openclaw-join.sh",
    "scripts/smoke/hermes-gateway-join.sh",
    "scripts/smoke/hermes-gateway-e2e.sh",
    "scripts/smoke/openclaw-gateway-e2e.sh",
  ]) {
    assert.match(files[name], /source .*paperclip-api-auth\.sh/);
    assert.match(files[name], /paperclip_public_health_preflight/);
    assert.match(files[name], /paperclip_prepare_protected_auth/);
    assert.match(files[name], /paperclip_require_protected_auth_for_mode/);
    const apiRequest = files[name].match(/api_request\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(apiRequest, /paperclip_protected_curl/);
    assert.doesNotMatch(apiRequest, /\b(?:command\s+)?curl\b/);
    assert.doesNotMatch(files[name], /PAPERCLIP_PROTECTED_CURL_ARGS/);
    assert.doesNotMatch(files[name], /AUTH_HEADERS=\(/);
  }
  assert.doesNotMatch(files["scripts/smoke/openclaw-sse-standalone.sh"], /curl[^\n]*PAPERCLIP_API_URL/);
  assert.match(files["scripts/approval-evidence-report.mjs"], /protectedPaperclipHeaders/);
  for (const name of [
    "scripts/paperclip-issue-update.sh",
    "scripts/smoke/pipelines-tutorial-smoke.sh",
  ]) {
    assert.match(files[name], /source .*paperclip-api-auth\.sh/);
    assert.match(files[name], /paperclip_require_api_key/);
    assert.match(files[name], /paperclip_prepare_protected_auth/);
    assert.match(files[name], /paperclip_protected_curl/);
    assert.doesNotMatch(files[name], /Authorization: Bearer \$PAPERCLIP_API_KEY/);
  }
  assert.match(files["scripts/smoke/terminal-bench-loop-skill-smoke.mjs"], /fetchPaperclipJson/);
  assert.doesNotMatch(files["scripts/smoke/terminal-bench-loop-skill-smoke.mjs"], /\bfetch\s*\(/);
});
