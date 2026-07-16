import { describe, expect, it, vi } from "vitest";

const {
  readPathExcludesFile,
  resolveBoundedHostPathTokens,
  resolveForbiddenTokens,
  resolvePathExcludes,
  runForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("turns process account names into bounded host paths, never bare substring tokens", () => {
    const tokens = resolveBoundedHostPathTokens(
      { USER: "runner", LOGNAME: "runner" },
      { userInfo: () => ({ username: "runner" }) },
    );
    expect(tokens).toEqual([
      "/home/runner/",
      "/Users/runner/",
      "C:\\Users\\runner\\",
    ]);
    expect(tokens).not.toContain("runner");
  });

  it("combines explicit stable tokens with bounded account paths", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\naccount_fixture_6394\n");
    try {
      expect(
        resolveForbiddenTokens(
          tokensFile,
          { USER: "runner" },
          { userInfo: () => ({ username: "runner" }) },
        ),
      ).toEqual([
        "account_fixture_6394",
        "/home/runner/",
        "/Users/runner/",
        "C:\\Users\\runner\\",
      ]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reads path excludes from comments and blank lines", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const excludesFile = path.join(os.tmpdir(), `forbidden-token-excludes-${Date.now()}.txt`);
    fs.writeFileSync(excludesFile, "# comment\ndocs/ops/guide.md # reason\n\nserver/file.ts\n");
    try {
      expect(readPathExcludesFile(excludesFile)).toEqual(["docs/ops/guide.md", "server/file.ts"]);
    } finally {
      fs.unlinkSync(excludesFile);
    }
  });

  it("resolves the tracked path exclude file under the repo root", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forbidden-token-repo-"));
    fs.mkdirSync(path.join(repoRoot, "scripts"));
    fs.writeFileSync(
      path.join(repoRoot, "scripts/forbidden-tokens-path-excludes.txt"),
      "docs/ops/guide.md\n",
    );
    try {
      expect(resolvePathExcludes(repoRoot)).toEqual(["docs/ops/guide.md"]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("passes tokens and quote-bearing excludes as inert git argument-array entries", () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const status = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["account_fixture_6394"],
      pathExcludes: ["docs/operator's guide.md"],
      exec,
      log: vi.fn(),
      error: vi.fn(),
    });
    expect(status).toBe(0);
    expect(exec).toHaveBeenCalledWith(
      "git",
      [
        "grep",
        "-Fin",
        "--no-color",
        "--",
        "account_fixture_6394",
        "--",
        ":!pnpm-lock.yaml",
        ":!.git",
        ":!docs/operator's guide.md",
      ],
      { encoding: "utf8", cwd: "/repo", stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("treats status 1 as the only no-match result", () => {
    const log = vi.fn();
    expect(
      runForbiddenTokenCheck({
        repoRoot: "/repo",
        tokens: ["/home/runner/"],
        exec: vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "" }),
        log,
        error: vi.fn(),
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("  ✓  No forbidden tokens found.");
  });

  it("reports matches without leaking the token or matched content", () => {
    const error = vi.fn();
    const status = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["account_fixture_6394"],
      exec: vi.fn().mockReturnValue({
        status: 0,
        stdout: "server/file.ts:7:sensitive matched content\n",
        stderr: "",
      }),
      log: vi.fn(),
      error,
    });
    expect(status).toBe(1);
    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("server/file.ts:7:[REDACTED forbidden token]");
    expect(output).not.toContain("account_fixture_6394");
    expect(output).not.toContain("sensitive matched content");
  });

  it("fails closed generically on fatal git grep without leaking stderr or the token", () => {
    const error = vi.fn();
    const status = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["account_fixture_6394"],
      exec: vi.fn().mockReturnValue({
        status: 2,
        stdout: "",
        stderr: "fatal output containing account_fixture_6394",
      }),
      log: vi.fn(),
      error,
    });
    expect(status).toBe(2);
    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("scan failed before it could complete safely");
    expect(output).not.toContain("account_fixture_6394");
    expect(output).not.toContain("fatal output");
  });
});
