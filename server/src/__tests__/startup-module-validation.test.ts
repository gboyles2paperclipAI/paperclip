import { describe, expect, it, vi } from "vitest";
import {
  runStartupModuleValidationOrExit,
  validateCriticalStartupModules,
} from "../startup-module-validation.js";

describe("startup module validation", () => {
  it("imports the critical database client module before server startup", async () => {
    const importer = vi.fn().mockResolvedValue({});

    await validateCriticalStartupModules({ importer });

    expect(importer).toHaveBeenCalledWith("@paperclipai/db/client");
  });

  it("reports the exact missing client.js path when the startup artifact is absent", async () => {
    const missingPath = "/srv/paperclip/packages/db/dist/client.js";
    const importer = vi.fn().mockRejectedValue(
      Object.assign(
        new Error(`Cannot find module '${missingPath}' imported from /srv/paperclip/server/dist/main.js`),
        {
          code: "ERR_MODULE_NOT_FOUND",
        },
      ),
    );

    await expect(validateCriticalStartupModules({ importer })).rejects.toMatchObject({
      exitCode: 2,
      expectedFileName: "client.js",
      missingPath,
      specifier: "@paperclipai/db/client",
    });
  });

  it("logs the missing artifact diagnostic and exits with status 2", async () => {
    const missingPath = "/srv/paperclip/packages/db/dist/client.js";
    const importer = vi.fn().mockRejectedValue(
      Object.assign(
        new Error(`Cannot find module '${missingPath}' imported from /srv/paperclip/server/dist/main.js`),
        {
          code: "ERR_MODULE_NOT_FOUND",
        },
      ),
    );
    const lines: string[] = [];
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runStartupModuleValidationOrExit({
        importer,
        writeError: (line) => lines.push(line),
        exit,
      }),
    ).rejects.toThrow("exit:2");

    expect(exit).toHaveBeenCalledWith(2);
    expect(lines).toEqual([
      "[paperclip] missing module: client.js",
      `[paperclip] missing module path: ${missingPath}`,
      "[paperclip] startup module validation failed for @paperclipai/db/client; exiting with status 2",
    ]);
  });

  it("falls back to the resolved module path when the import error omits a path", async () => {
    const resolvedPath = "/srv/paperclip/packages/db/dist/client.js";
    const importer = vi.fn().mockRejectedValue(new Error("module load failed"));

    await expect(
      validateCriticalStartupModules({
        importer,
        resolveModule: () => `file://${resolvedPath}`,
      }),
    ).rejects.toMatchObject({
      missingPath: resolvedPath,
    });
  });
});
