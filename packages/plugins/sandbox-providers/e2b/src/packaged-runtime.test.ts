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
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("packaged E2B runtime", () => {
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
});
