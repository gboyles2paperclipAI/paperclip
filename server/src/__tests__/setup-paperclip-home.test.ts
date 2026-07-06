import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePaperclipInstanceRoot } from "@paperclipai/shared/home-paths";

// Regression guard for FUL-15624: the server suite must never resolve the
// developer's real ~/.paperclip instance root, or tests that provision
// heartbeat workspaces leak empty per-agent UUID directories into
// ~/.paperclip/instances/default/workspaces on every run.
describe("test suite Paperclip home isolation", () => {
  it("defaults PAPERCLIP_HOME away from the real ~/.paperclip", () => {
    expect(process.env.PAPERCLIP_HOME?.trim()).toBeTruthy();
    const realHome = path.resolve(os.homedir(), ".paperclip");
    expect(resolvePaperclipInstanceRoot().startsWith(realHome + path.sep)).toBe(false);
  });
});
