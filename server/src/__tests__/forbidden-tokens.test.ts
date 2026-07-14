import { describe, expect, it, vi } from "vitest";

const {
  readPathExcludesFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  resolvePathExcludes,
  runForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reads path excludes from a comments-and-blank-lines file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const excludesFile = path.join(os.tmpdir(), `forbidden-token-excludes-${Date.now()}.txt`);
    fs.writeFileSync(
      excludesFile,
      [
        "# comment",
        "",
        "docs/deploy/help2day-dedicated-ops.md",
        "scripts/ops/help2day/fleet-health-check.sh # inline comment",
        "scripts/ops/help2day/monthly-restore-test.sh",
      ].join("\n"),
    );

    try {
      expect(readPathExcludesFile(excludesFile)).toEqual([
        "docs/deploy/help2day-dedicated-ops.md",
        "scripts/ops/help2day/fleet-health-check.sh",
        "scripts/ops/help2day/monthly-restore-test.sh",
      ]);
    } finally {
      fs.unlinkSync(excludesFile);
    }
  });

  it("returns no path excludes when the file is missing", () => {
    expect(readPathExcludesFile("/tmp/paperclip-missing-forbidden-token-excludes.txt")).toEqual([]);
  });

  it("resolves the tracked path exclude file under the repo root", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forbidden-token-repo-"));
    const scriptsDir = path.join(repoRoot, "scripts");
    fs.mkdirSync(scriptsDir);
    fs.writeFileSync(
      path.join(scriptsDir, "forbidden-tokens-path-excludes.txt"),
      "docs/deploy/help2day-dedicated-ops.md\n",
    );

    try {
      expect(resolvePathExcludes(repoRoot)).toEqual(["docs/deploy/help2day-dedicated-ops.md"]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves no path excludes when the tracked file is absent", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forbidden-token-repo-"));

    try {
      expect(resolvePathExcludes(repoRoot)).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports matches without leaking which token was searched", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce("server/file.ts:1:found\n")
      .mockImplementation(() => {
        throw new Error("not found");
      });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("  server/file.ts:1:[REDACTED forbidden token]");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    const errorOutput = error.mock.calls.flat().join("\n");
    expect(errorOutput).not.toContain("server/file.ts:1:found");
    expect(errorOutput).not.toContain("paperclip");
    expect(errorOutput).not.toContain("custom-token");
  });

  it("adds path excludes to the git grep command", () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip"],
      pathExcludes: [
        "docs/deploy/help2day-dedicated-ops.md",
        "scripts/ops/help2day/fleet-health-check.sh",
      ],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(0);
    expect(exec).toHaveBeenCalledWith(
      "git grep -in --no-color -- \"paperclip\" -- ':!pnpm-lock.yaml' ':!.git' ':!docs/deploy/help2day-dedicated-ops.md' ':!scripts/ops/help2day/fleet-health-check.sh'",
      { encoding: "utf8", cwd: "/repo", stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("keeps the git grep command unchanged when path excludes are empty", () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip"],
      pathExcludes: [],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(0);
    expect(exec).toHaveBeenCalledWith(
      "git grep -in --no-color -- \"paperclip\" -- ':!pnpm-lock.yaml' ':!.git'",
      { encoding: "utf8", cwd: "/repo", stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("quotes path excludes before adding them to the git grep command", () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip"],
      pathExcludes: ["docs/ops/operator's guide.md"],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(0);
    expect(exec).toHaveBeenCalledWith(
      "git grep -in --no-color -- \"paperclip\" -- ':!pnpm-lock.yaml' ':!.git' ':!docs/ops/operator'\\''s guide.md'",
      { encoding: "utf8", cwd: "/repo", stdio: ["pipe", "pipe", "pipe"] },
    );
  });
});
