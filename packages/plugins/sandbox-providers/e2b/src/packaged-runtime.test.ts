import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("packaged E2B runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.E2B_API_KEY;
  });

  it("imports the built package in an isolated Node process", () => {
    execFileSync("pnpm", ["run", "build"], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const installRoot = mkdtempSync(path.join(tmpdir(), "paperclip-e2b-runtime-"));
    try {
      cpSync(path.join(packageRoot, "dist"), path.join(installRoot, "dist"), { recursive: true });
      const sdkRoot = path.join(installRoot, "node_modules", "@paperclipai", "plugin-sdk");
      mkdirSync(sdkRoot, { recursive: true });
      writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({
        type: "module",
        exports: "./index.js",
      }));
      writeFileSync(
        path.join(sdkRoot, "index.js"),
        "export const definePlugin = (definition) => ({ definition });\n",
      );
      symlinkSync(
        path.join(packageRoot, "node_modules", "e2b"),
        path.join(installRoot, "node_modules", "e2b"),
        "dir",
      );

      const entrypoint = pathToFileURL(path.join(installRoot, "dist", "index.js")).href;
      expect(() => execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", `await import(${JSON.stringify(entrypoint)})`],
        { cwd: installRoot, stdio: "pipe" },
      )).not.toThrow();
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("authenticates reusable-lease pause with config-only credentials", async () => {
    delete process.env.E2B_API_KEY;
    const sandbox = Object.create(Sandbox.prototype) as Sandbox;
    Object.defineProperty(sandbox, "sandboxId", { value: "sandbox-config-only" });

    const killSpy = vi.spyOn(sandbox, "kill").mockResolvedValue(undefined);
    vi.spyOn(Sandbox, "connect").mockResolvedValue(sandbox);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "e2b",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        template: "base",
        apiKey: "config-only-key",
        timeoutMs: 300_000,
        reuseLease: true,
      },
      providerLeaseId: "sandbox-config-only",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = new Request(fetchSpy.mock.calls[0]![0], fetchSpy.mock.calls[0]![1]);
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/sandboxes/sandbox-config-only/pause");
    expect(request.headers.get("x-api-key")).toBe("config-only-key");
    expect(killSpy).not.toHaveBeenCalled();
  });
});
