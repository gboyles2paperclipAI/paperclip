#!/usr/bin/env bash
# t1-spawn.sh — Generic subprocess wrapper with T1 secret env injection.
#
# Security properties:
#   §7.2-A: T1 secret values are injected into the child's env only — never
#           interpolated into argv strings where ps/procfs could expose them.
#   SL-1: reads from harness-written chmod 600 JSON file only.
#   SL-2: child stdout/stderr is captured and returned on this script's stdout.
#
# Usage:
#   PAPERCLIP_T1_KEYS=KEY1,KEY2 scripts/t1-spawn.sh <command> [args...]
#
# Environment:
#   PAPERCLIP_T1_ENV_PATH  Path to per-run chmod 600 T1 JSON file (set by harness).
#                          If unset or absent, the command runs without T1 injection.
#   PAPERCLIP_T1_KEYS      Comma-separated list of T1 env var names to inject into
#                          the child process environment. Required for injection.
#
# Example — run psql with DATABASE_URL injected via PGPASSWORD+DSN (§7.2-B):
#   PAPERCLIP_T1_KEYS=DATABASE_URL scripts/t1-spawn.sh bash -c '
#     export PGPASSWORD=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.password)")
#     psql "$DATABASE_URL" -c "SELECT 1"
#   '
#
# Example — generic credentialed command:
#   PAPERCLIP_T1_KEYS=RESEND_API_KEY scripts/t1-spawn.sh my-mailer-cli send ...

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: PAPERCLIP_T1_KEYS=KEY1,KEY2 $0 <command> [args...]" >&2
  exit 1
fi

T1_ENV_PATH="${PAPERCLIP_T1_ENV_PATH:-}"
T1_KEYS="${PAPERCLIP_T1_KEYS:-}"

# Collect KEY=VALUE pairs in a bash array. Values are read from the JSON file
# using Node.js and stored in shell variables — never placed in argv.
declare -A T1_VALS
if [[ -n "$T1_ENV_PATH" && -f "$T1_ENV_PATH" && -n "$T1_KEYS" ]]; then
  # Read all requested keys in a single Node.js call to avoid forking once per key.
  # Output format: one "KEY=<base64-value>" line per found key.
  while IFS='=' read -r KEY B64VAL; do
    [[ -z "$KEY" ]] && continue
    T1_VALS["$KEY"]=$(printf '%s' "$B64VAL" | base64 -d)
  done < <(
    PAPERCLIP_T1_ENV_PATH="$T1_ENV_PATH" PAPERCLIP_T1_KEYS="$T1_KEYS" \
    node --input-type=module <<'EOF' 2>/dev/null
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
const d = JSON.parse(readFileSync(process.env.PAPERCLIP_T1_ENV_PATH, 'utf8'));
const keys = process.env.PAPERCLIP_T1_KEYS.split(',').map(k => k.trim()).filter(Boolean);
for (const key of keys) {
  if (key in d) {
    const b64 = Buffer.from(d[key]).toString('base64');
    process.stdout.write(key + '=' + b64 + '\n');
  }
}
EOF
  ) || true
fi

# Run the command in a subshell with T1 vars exported to that subshell only.
# §7.2-A: values are in the child env, NOT in any process's argv.
# SL-2: capture all output — no stdio:inherit.
EXIT_CODE=0
OUTPUT=$(
  {
    for KEY in "${!T1_VALS[@]}"; do
      export "$KEY"="${T1_VALS[$KEY]}"
    done
    exec "$@"
  } 2>&1
) || EXIT_CODE=$?

printf '%s\n' "$OUTPUT"
exit "$EXIT_CODE"
