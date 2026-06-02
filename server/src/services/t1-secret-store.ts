import fsp from "node:fs/promises";
import path from "node:path";

// Matches T1 (durable secret) env var names. Extends the SENSITIVE_ENV_KEY_RE pattern
// used in scripts/migrate-inline-env-secrets.ts and server/src/services/secrets.ts
// with additional terms from the Stage 0 inventory (FUL-6377):
//   bypass — matches PAPERCLIP_BYPASS_TOKEN, HELP2DAY_QA_BYPASS_TOKEN
//   oidc   — matches VERCEL_OIDC_TOKEN
const T1_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connection[-_]?string|bypass|oidc)/i;

// Connection-string variables that embed credentials but don't match the regex above.
const T1_CREDENTIAL_URL_KEYS: ReadonlySet<string> = new Set(["DATABASE_URL"]);

/** Returns true if the env key identifies a T1 durable secret. */
export function isT1Key(key: string): boolean {
  return T1_CREDENTIAL_URL_KEYS.has(key) || T1_KEY_RE.test(key);
}

// In-memory store: runId → { envKey → value }.
// SL-1 compliant: secrets live only in process heap; this module never writes to disk
// on its own — call writeT1EnvFile explicitly when wrapper-script access is needed.
const _memStore = new Map<string, Record<string, string>>();

/**
 * Separates T1 keys from a resolved env record, stores the T1 values in memory,
 * and returns the sanitized env (T1 keys removed) plus the list of extracted keys.
 *
 * Call this before assembling the agent process env so that T1 secrets never
 * reach the agent's process.env when the isolation flag is ON.
 */
export function extractT1Secrets(
  runId: string,
  env: Record<string, string>,
): { sanitizedEnv: Record<string, string>; t1Keys: string[] } {
  const t1: Record<string, string> = {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isT1Key(key)) {
      t1[key] = value;
    } else {
      sanitized[key] = value;
    }
  }
  if (Object.keys(t1).length > 0) {
    _memStore.set(runId, t1);
  }
  return { sanitizedEnv: sanitized, t1Keys: Object.keys(t1) };
}

/** Returns the stored T1 secrets for a run (empty object if none / already cleared). */
export function getT1Secrets(runId: string): Record<string, string> {
  return _memStore.get(runId) ?? {};
}

/** Removes T1 secrets for a run from memory. */
export function clearT1Secrets(runId: string): void {
  _memStore.delete(runId);
}

/**
 * Returns the path of the per-run T1 env file.
 * Located under the agent workspace dir — not /tmp — so it stays within the
 * harness-controlled directory tree (SL-1).
 */
export function t1EnvFilePath(runId: string, agentWorkspaceDir: string): string {
  return path.join(agentWorkspaceDir, ".paperclip-run-secrets", runId, "t1.json");
}

/**
 * Writes the in-memory T1 secrets for a run to a chmod 600 JSON file.
 *
 * SL-1: the directory is chmod 700; the file is chmod 600 — readable only by
 * the owner (the harness process UID). No world- or group-readable permissions.
 *
 * Returns the absolute file path on success, or null if no T1 secrets were stored.
 */
export async function writeT1EnvFile(
  runId: string,
  agentWorkspaceDir: string,
): Promise<string | null> {
  const secrets = _memStore.get(runId);
  if (!secrets || Object.keys(secrets).length === 0) return null;

  const filePath = t1EnvFilePath(runId, agentWorkspaceDir);
  const dir = path.dirname(filePath);

  // chmod 700: directory accessible only by harness UID
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  // Write as compact JSON; chmod 600 immediately after (mode in writeFile can be
  // affected by process umask, so we also call chmod explicitly).
  const content = JSON.stringify(secrets);
  await fsp.writeFile(filePath, content, { mode: 0o600, flag: "w" });
  await fsp.chmod(filePath, 0o600);

  return filePath;
}

/**
 * Cleans up the per-run secrets directory and clears in-memory state.
 * Best-effort: ENOENT is silently ignored.
 */
export async function cleanupT1EnvFile(
  runId: string,
  agentWorkspaceDir: string,
): Promise<void> {
  const filePath = t1EnvFilePath(runId, agentWorkspaceDir);
  const dir = path.dirname(filePath);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; already removed is fine
  }
  clearT1Secrets(runId);
}
