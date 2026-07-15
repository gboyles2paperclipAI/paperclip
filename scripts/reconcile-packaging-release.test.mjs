import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

function readText(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function packageExportHasProductionTarget(pkg, key) {
  const target = pkg.exports?.[key];
  return Boolean(
    target &&
      typeof target === "object" &&
      typeof target.production === "string" &&
      typeof target.types === "string" &&
      typeof target.import === "string" &&
      typeof target.default === "string",
  );
}

test("selected ACPX package architecture remains publishable and built in", () => {
  const manifest = readJson("scripts/release-package-manifest.json");
  const releaseEntry = manifest.find((entry) => entry.dir === "packages/adapters/acpx-local");
  assert.deepEqual(releaseEntry, {
    dir: "packages/adapters/acpx-local",
    name: "@paperclipai/adapter-acpx-local",
    publishFromCi: true,
  });

  assert.equal(existsSync(join(repoRoot, "packages/adapters/acpx-local/package.json")), true);
  const acpxPkg = readJson("packages/adapters/acpx-local/package.json");
  assert.equal(acpxPkg.name, "@paperclipai/adapter-acpx-local");
  assert.equal(acpxPkg.dependencies.acpx, "^0.11.2");
  assert.equal(acpxPkg.dependencies["@agentclientprotocol/claude-agent-acp"], "^0.52.0");
  assert.equal(acpxPkg.dependencies["@zed-industries/codex-acp"], "^0.12.0");

  const cliPkg = readJson("cli/package.json");
  const serverPkg = readJson("server/package.json");
  assert.equal(cliPkg.dependencies["@paperclipai/adapter-acpx-local"], "workspace:*");
  assert.equal(serverPkg.dependencies["@paperclipai/adapter-acpx-local"], "workspace:*");
});

test("published package exports keep production runtime markers", () => {
  const packagePaths = [
    "packages/adapter-utils/package.json",
    "packages/adapters/acpx-local/package.json",
    "packages/adapters/claude-local/package.json",
    "packages/adapters/codex-local/package.json",
    "packages/adapters/gemini-local/package.json",
    "packages/shared/package.json",
  ];

  for (const packagePath of packagePaths) {
    const pkg = readJson(packagePath);
    assert.equal(packageExportHasProductionTarget(pkg, "."), true, `${packagePath} root export`);
  }

  for (const packagePath of packagePaths.slice(1, 5)) {
    const pkg = readJson(packagePath);
    assert.equal(packageExportHasProductionTarget(pkg, "./server"), true, `${packagePath} server export`);
    assert.equal(packageExportHasProductionTarget(pkg, "./ui"), true, `${packagePath} ui export`);
    assert.equal(packageExportHasProductionTarget(pkg, "./cli"), true, `${packagePath} cli export`);
  }
});

test("dependency override policy preserves fork security pins and frozen upstream UI pins", () => {
  const rootPkg = readJson("package.json");
  const overrides = rootPkg.pnpm?.overrides ?? {};
  const expected = {
    rollup: ">=4.59.0",
    "drizzle-orm": ">=0.45.2",
    kysely: ">=0.28.17",
    picomatch: ">=4.0.4",
    react: "^19.2.7",
    "react-dom": "^19.2.7",
    lexical: "0.46.0",
    "@lexical/clipboard": "0.46.0",
    "@lexical/link": "0.46.0",
    "@lexical/list": "0.46.0",
    "@lexical/markdown": "0.46.0",
    "@lexical/plain-text": "0.46.0",
    "@lexical/react": "0.46.0",
    "@lexical/rich-text": "0.46.0",
    "@lexical/selection": "0.46.0",
    "@lexical/utils": "0.46.0",
  };

  assert.deepEqual(overrides, expected);

  const lockfile = readText("pnpm-lock.yaml");
  for (const [name, spec] of Object.entries(expected)) {
    const keyForms = [name, `'${name}'`];
    const specForms = [spec, `'${spec}'`];
    assert.equal(
      keyForms.some((key) => specForms.some((value) => lockfile.includes(`  ${key}: ${value}`))),
      true,
      `${name} override is present in pnpm-lock.yaml`,
    );
  }
});

test("Cursor Cloud pins the newest SDK release without the vulnerable Node transport chain", () => {
  const cursorPkg = readJson("packages/adapters/cursor-cloud/package.json");
  assert.equal(cursorPkg.dependencies["@cursor/sdk"], "1.0.20");

  const lockfile = readText("pnpm-lock.yaml");
  assert.match(lockfile, /'@cursor\/sdk@1\.0\.20':/);
  assert.doesNotMatch(lockfile, /'@connectrpc\/connect-node@/);
  assert.doesNotMatch(lockfile, /undici@5\.29\.0/);
});

test("release and governance controls stay wired into focused PR verification", () => {
  const rootPkg = readJson("package.json");
  assert.match(rootPkg.scripts["test:release-registry"], /reconcile-packaging-release\.test\.mjs/);

  const help2dayVerify = readText(".github/workflows/help2day-pr-verify.yml");
  assert.match(help2dayVerify, /Test release registry and immutable-package guards/);
  assert.match(help2dayVerify, /pnpm run test:release-registry/);

  const releaseMap = readText("scripts/release-package-map.mjs");
  assert.match(releaseMap, /findUnpublishableWorkspaceEdges/);
  assert.match(releaseMap, /publishFromCi:true/);

  const stageRelease = readText("scripts/stage-release-packages.mjs");
  assert.match(stageRelease, /inspectNpmReleaseTarball/);
  assert.match(stageRelease, /chmodSync\(immutablePath, 0o444\)/);
  assert.match(stageRelease, /release staging root is missing its safety marker/);

  const directPublishGuard = readText("scripts/no-direct-package-publish.test.mjs");
  assert.match(directPublishGuard, /tracked literal package-publish commands stay on the verified tarball boundary/);

  assert.equal(existsSync(join(repoRoot, ".github/workflows/gitleaks.yml")), true);
  assert.equal(existsSync(join(repoRoot, ".github/workflows/governance-approval-tripwire.yml")), true);
  assert.equal(existsSync(join(repoRoot, ".github/workflows/help2day-pr-verify.yml")), true);
});

test("Help2day source evidence is isolated from publication and runtime activation", () => {
  const workflow = readText(".github/workflows/help2day-source-release-evidence.yml");
  assert.match(workflow, /environment: source-release/);
  assert.match(workflow, /build-help2day-release-evidence\.sh/);
  assert.doesNotMatch(workflow, /environment: production-runtime/);
  assert.doesNotMatch(workflow, /npm[_ -]stable|paperclip\.service|db:migrate/);

  const evidence = readText("scripts/build-help2day-release-evidence.sh");
  const standaloneTests = evidence.indexOf("test-standalone-public-packages.mjs");
  const standaloneBuild = evidence.indexOf("build-standalone-public-packages.mjs");
  const immutableStage = evidence.indexOf("stage-release-packages.mjs stage");
  assert.ok(standaloneTests >= 0 && standaloneBuild > standaloneTests);
  assert.ok(standaloneBuild >= 0 && immutableStage > standaloneBuild);
  assert.match(evidence, /cyclonedx-npm/);
  assert.match(evidence, /osv-scanner/);
  assert.match(evidence, /grype/);
  assert.match(evidence, /source-range-gitleaks/);
  assert.match(evidence, /package-gitleaks/);
  assert.match(evidence, /prove-isolated-release-runtime\.sh/);
  assert.match(evidence, /--runtime-proof-mode/);
  assert.match(evidence, /heartbeat-settlement-errors\.log/);
  assert.match(evidence, /assert_no_vitest_fixture_leaks/);
  assert.match(evidence, /PAPERCLIP_RELEASE_EVIDENCE_RUN_ID=/);
  assert.match(evidence, /VITEST_TEMP_BASE="\$\{RUNNER_TEMP:-\/tmp\}"/);
  assert.match(evidence, /mktemp -d "\$VITEST_TEMP_BASE\/paperclip-release-vitest/);
  assert.match(evidence, /rm -rf "\$VITEST_EVIDENCE_TMP"/);
  assert.doesNotMatch(evidence, /startsWith\("PAPERCLIP_VITEST_RUN_ID="\)/);
  assert.match(evidence, /stable test cleanup left/);
  assert.match(evidence, /CONNECTION_\(ENDED\|DESTROYED\)/);
  assert.match(evidence, /skipping late \(setup failure\|adapter failure\|run\) finalization/);
  assert.doesNotMatch(evidence, /--legacy-peer-deps/);
  assert.ok(
    evidence.indexOf('mv "$REPO_ROOT/cli/package.dev.json" "$REPO_ROOT/cli/package.json"') <
      evidence.indexOf('cp -p "$BACKUP_ROOT/$pkg_dir/package.json" "$REPO_ROOT/$pkg_dir/package.json"'),
    "the authoritative package backup must be restored after the temporary CLI development manifest",
  );
  assert.match(
    evidence,
    /for pkg_dir in server packages\/adapters\/claude-local packages\/adapters\/codex-local; do[\s\S]*rm -rf "\$REPO_ROOT\/\$pkg_dir\/skills"/,
  );
  assert.match(evidence, /BACKUP_ROOT\/cli-README\.md/);
  assert.match(
    evidence,
    /if \[\[ -f "\$BACKUP_ROOT\/cli-README\.md" \]\]; then[\s\S]*cp -p "\$BACKUP_ROOT\/cli-README\.md" "\$REPO_ROOT\/cli\/README\.md"[\s\S]*else[\s\S]*rm -f "\$REPO_ROOT\/cli\/README\.md"/,
  );

  const runtimeProof = readText("scripts/prove-isolated-release-runtime.sh");
  assert.match(runtimeProof, /setsid env -i/);
  assert.match(runtimeProof, /kill -TERM -- "-\$SMOKE_PID"/);
  assert.match(runtimeProof, /pgrep -g "\$SMOKE_PID"/);
  assert.match(runtimeProof, /before-live-runtime\.sha256/);
  assert.match(runtimeProof, /paperclip-staging\.service/);
  assert.match(runtimeProof, /sport = :3101 or sport = :3102/);
  assert.match(runtimeProof, /live runtime bytes changed during isolated proof/);

  const standaloneTestRunner = readText("scripts/test-standalone-public-packages.mjs");
  assert.match(standaloneTestRunner, /listStandalonePublicPackages/);
  assert.match(standaloneTestRunner, /"--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"/);
  assert.match(standaloneTestRunner, /missing its reproducibility lockfile/);
  assert.match(standaloneTestRunner, /"pnpm",\s*\n\s*\["exec", "vitest"/);
  assert.match(standaloneTestRunner, /"--root", packageRoot, "--config", configPath/);
});
