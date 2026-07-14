import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPublishArgs,
  parseArgs,
  publishPackage,
  resolveTargetPackage,
} from "./bootstrap-npm-package.mjs";

test("parseArgs recognizes publish and skip-build flags", () => {
  assert.deepEqual(parseArgs(["@paperclipai/adapter-acpx-local", "--publish", "--skip-build"]), {
    help: false,
    selector: "@paperclipai/adapter-acpx-local",
    publish: true,
    skipBuild: true,
    otp: null,
  });
});

test("parseArgs accepts an explicit otp value", () => {
  assert.deepEqual(parseArgs(["packages/adapters/acpx-local", "--publish", "--otp", "123456"]), {
    help: false,
    selector: "packages/adapters/acpx-local",
    publish: true,
    skipBuild: false,
    otp: "123456",
  });
});

test("parseArgs safely supports equals-form otp and redacts unknown options", () => {
  assert.deepEqual(
    parseArgs(["packages/adapters/acpx-local", "--publish", "--otp=123456"]),
    {
      help: false,
      selector: "packages/adapters/acpx-local",
      publish: true,
      skipBuild: false,
      otp: "123456",
    },
  );
  assert.throws(() => parseArgs(["--otp="]), /expected a one-time password/);
  assert.throws(
    () => parseArgs(["--credential=SECRET_SENTINEL"]),
    (error) => error.message === "unknown option provided",
  );
});

test("parseArgs leaves otp null when omitted", () => {
  assert.deepEqual(parseArgs(["packages/adapters/acpx-local", "--publish"]), {
    help: false,
    selector: "packages/adapters/acpx-local",
    publish: true,
    skipBuild: false,
    otp: null,
  });
});

test("parseArgs returns help mode", () => {
  assert.deepEqual(parseArgs(["--help"]), {
    help: true,
    selector: null,
    publish: false,
    skipBuild: false,
    otp: null,
  });
});

test("resolveTargetPackage matches by package name or dir", () => {
  const packages = [
    { dir: "packages/a", name: "@paperclipai/a", pkg: {} },
    { dir: "packages/b", name: "@paperclipai/b", pkg: {} },
  ];

  assert.equal(resolveTargetPackage("@paperclipai/a", packages).dir, "packages/a");
  assert.equal(resolveTargetPackage("./packages/b", packages).name, "@paperclipai/b");
});

test("resolveTargetPackage includes the workspace diff plugin bootstrap package", () => {
  const pkg = resolveTargetPackage("@paperclipai/plugin-workspace-diff");

  assert.equal(pkg.dir, "packages/plugins/plugin-workspace-diff");
});

test("buildPublishArgs publishes an immutable tarball without lifecycle scripts", () => {
  assert.deepEqual(buildPublishArgs("/tmp/staged-package.tgz"), [
    "publish",
    "/tmp/staged-package.tgz",
    "--ignore-scripts",
    "--no-git-checks",
    "--access",
    "public",
  ]);
});

test("buildPublishArgs includes dry-run and otp flags when requested", () => {
  assert.deepEqual(buildPublishArgs("/tmp/staged-package.tgz", { dryRun: true, otp: "123456" }), [
    "publish",
    "/tmp/staged-package.tgz",
    "--ignore-scripts",
    "--no-git-checks",
    "--access",
    "public",
    "--dry-run",
    "--otp",
    "123456",
  ]);
});

test("publish failures never expose the otp or raw command output", () => {
  const fixture = mkdtempSync(join(tmpdir(), "paperclip-bootstrap-publish-"));
  const tarballPath = join(fixture, "staged-package.tgz");
  const bytes = Buffer.from("immutable staged bytes");
  const sentinelOtp = "OTP_SENTINEL_593817";
  writeFileSync(tarballPath, bytes);
  const staged = {
    tarballPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const failures = [
    () => ({
      status: 1,
      stdout: `raw args included --otp ${sentinelOtp}`,
      stderr: `registry failure repeated ${sentinelOtp}`,
    }),
    () => ({
      status: 1,
      stdout: `npm error EOTP one-time password ${sentinelOtp}`,
      stderr: "",
    }),
    () => ({ status: null, stdout: sentinelOtp, stderr: sentinelOtp }),
    () => ({ error: new Error(`spawn result ${sentinelOtp}`) }),
    () => {
      throw new Error(`spawn threw ${sentinelOtp}`);
    },
  ];

  try {
    for (const commandRunner of failures) {
      let capturedStdout = "";
      let capturedStderr = "";
      let thrown;
      const originalStdoutWrite = process.stdout.write;
      const originalStderrWrite = process.stderr.write;
      process.stdout.write = (chunk) => {
        capturedStdout += String(chunk);
        return true;
      };
      process.stderr.write = (chunk) => {
        capturedStderr += String(chunk);
        return true;
      };
      try {
        publishPackage(staged, sentinelOtp, (command, args) => {
          assert.equal(command, "pnpm");
          assert.ok(args.includes(sentinelOtp));
          return commandRunner();
        });
      } catch (error) {
        thrown = error;
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      assert.ok(thrown instanceof Error);
      const observable = `${capturedStdout}\n${capturedStderr}\n${thrown.message}`;
      assert.doesNotMatch(observable, new RegExp(sentinelOtp));
      assert.doesNotMatch(observable, /raw args included|registry failure repeated|spawn result|spawn threw/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("top-level option failures never expose split, equals, missing, or unknown otp values", () => {
  const script = new URL("./bootstrap-npm-package.mjs", import.meta.url).pathname;
  const sentinel = "OTP_OPTION_SENTINEL_817263";
  const cases = [
    ["--publish", "--otp", sentinel],
    ["--publish", "--otp"],
    ["--publish", `--otp=${sentinel}`],
    ["--publish", `--otp-${sentinel}`],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(result.status, 0);
    const observable = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.doesNotMatch(observable, new RegExp(sentinel));
    assert.doesNotMatch(observable, /--otp[-=]OTP_OPTION_SENTINEL/);
  }
});
