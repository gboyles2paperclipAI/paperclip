#!/usr/bin/env bash
# safe-preview-probe.sh — HTTP probe via curl with T1 secret injection.
#
# Security properties:
#   §7.2-B / SH-10: secrets injected via curl --config file, NEVER in argv.
#   §7.2-A: no T1 secret value appears in any process argument list.
#   SL-1: reads from harness-written chmod 600 JSON file only.
#   SL-2: child stdout/stderr is captured and returned on this script's stdout;
#          never passed through as stdio:inherit.
#
# Usage:
#   scripts/safe-preview-probe.sh <url> [options]
#
# Options:
#   --bypass-key KEY    Name of the T1 key for x-vercel-protection-bypass header
#                       (default: PAPERCLIP_BYPASS_TOKEN)
#   --auth-key KEY      Name of the T1 key for Authorization: Bearer header
#   --method METHOD     HTTP method (default: GET)
#   -- [curl-args...]   Extra args passed verbatim to curl (must not contain secret values)
#
# Environment:
#   PAPERCLIP_T1_ENV_PATH  Path to per-run chmod 600 T1 JSON file written by the
#                          harness. If unset or the file is absent, the probe runs
#                          without token injection (flag-OFF / legacy path).
#
# Exit code: curl's exit code. Output: captured stdout+stderr on this script's stdout.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <url> [--bypass-key KEY] [--auth-key KEY] [--method METHOD] [-- curl-args...]" >&2
  exit 1
fi

URL="$1"; shift

BYPASS_KEY="PAPERCLIP_BYPASS_TOKEN"
AUTH_KEY=""
CURL_METHOD=""
EXTRA_CURL_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bypass-key) BYPASS_KEY="$2"; shift 2 ;;
    --auth-key)   AUTH_KEY="$2";   shift 2 ;;
    --method)     CURL_METHOD="$2"; shift 2 ;;
    --)           shift; EXTRA_CURL_ARGS+=("$@"); break ;;
    *)            EXTRA_CURL_ARGS+=("$1"); shift ;;
  esac
done

T1_ENV_PATH="${PAPERCLIP_T1_ENV_PATH:-}"
BYPASS_TOKEN=""
AUTH_TOKEN=""

# Read specific token values from the JSON file using Node.js as the parser.
# Key names are passed via env vars (PAPERCLIP_T1_KEY), not interpolated into the
# script body — no risk of argv injection even if the key name contains special chars.
if [[ -n "$T1_ENV_PATH" && -f "$T1_ENV_PATH" ]]; then
  if [[ -n "$BYPASS_KEY" ]]; then
    BYPASS_TOKEN=$(PAPERCLIP_T1_ENV_PATH="$T1_ENV_PATH" PAPERCLIP_T1_KEY="$BYPASS_KEY" \
      node --input-type=module <<'EOF' 2>/dev/null
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(process.env.PAPERCLIP_T1_ENV_PATH, 'utf8'));
process.stdout.write(d[process.env.PAPERCLIP_T1_KEY] ?? '');
EOF
    ) || true
  fi

  if [[ -n "$AUTH_KEY" ]]; then
    AUTH_TOKEN=$(PAPERCLIP_T1_ENV_PATH="$T1_ENV_PATH" PAPERCLIP_T1_KEY="$AUTH_KEY" \
      node --input-type=module <<'EOF' 2>/dev/null
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(process.env.PAPERCLIP_T1_ENV_PATH, 'utf8'));
process.stdout.write(d[process.env.PAPERCLIP_T1_KEY] ?? '');
EOF
    ) || true
  fi
fi

# Build a curl config file (man curl-config(1)).
# §7.2-B / SH-10: all secrets flow through --config, never through argv.
CURL_CFG=$(mktemp)
chmod 600 "$CURL_CFG"
trap 'rm -f "$CURL_CFG"' EXIT

{
  printf 'silent\n'
  printf 'show-error\n'
  [[ -n "$CURL_METHOD" ]] && printf 'request = "%s"\n' "$CURL_METHOD"
  [[ -n "$BYPASS_TOKEN" ]] && printf 'header = "x-vercel-protection-bypass: %s"\n' "$BYPASS_TOKEN"
  [[ -n "$AUTH_TOKEN" ]]   && printf 'header = "Authorization: Bearer %s"\n' "$AUTH_TOKEN"
} >> "$CURL_CFG"

# SL-2: capture all child output — no stdio:inherit / pipe pass-through.
EXIT_CODE=0
OUTPUT=$(curl --config "$CURL_CFG" "${EXTRA_CURL_ARGS[@]}" -- "$URL" 2>&1) || EXIT_CODE=$?

printf '%s\n' "$OUTPUT"
exit "$EXIT_CODE"
