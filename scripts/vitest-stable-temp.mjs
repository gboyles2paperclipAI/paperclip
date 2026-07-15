import os from "node:os";

export function selectVitestTempRootParent(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    return os.tmpdir();
  }

  return env.TMPDIR || "/tmp";
}
