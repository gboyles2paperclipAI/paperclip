import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Server tests exercise heartbeat workspace provisioning, which creates
// per-agent-id directories under the Paperclip instance root
// (resolveDefaultAgentWorkspaceDir + mkdir in services/heartbeat.ts). Tests
// insert agents with randomUUID() ids, so without an override every suite run
// leaks empty UUID-named directories into the developer's real
// ~/.paperclip/instances/default/workspaces (FUL-15624). Default the whole
// suite to an isolated throwaway home; tests that manage their own
// PAPERCLIP_HOME keep working because they assign the variable themselves.
if (!process.env.PAPERCLIP_HOME?.trim()) {
  try {
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-server-tests-"));
    process.env.PAPERCLIP_HOME = testHome;
    process.once("exit", () => {
      try {
        fs.rmSync(testHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS temp dir is reaped eventually anyway.
      }
    });
  } catch (err) {
    // If the temp dir cannot be created (e.g. tmpfs over quota), fall back to
    // the previous behavior instead of failing every test at setup.
    console.warn(
      `setup-paperclip-home: could not create isolated PAPERCLIP_HOME, tests will use the real instance root: ${String(err)}`,
    );
  }
}
