#!/usr/bin/env bash
# SH-3/SH-6 harness output filter — FUL-5429, FUL-12630
# Masks PAPERCLIP_API_KEY=<value>, other PAPERCLIP_*_KEY/TOKEN/SECRET values,
# and Tailscale SSH auth-challenge URLs before log persistence.
#
# Usage (pipe mode):  some_command | scripts/redact-run-output.sh
# Usage (file mode):  scripts/redact-run-output.sh <logfile> [logfile2 ...]
#
# Exit 0: no secret values were masked.
# Exit 1: at least one value was masked — caller must log a SH-3 redaction event.
set -euo pipefail

_redact() {
  sed -E \
    -e 's/(PAPERCLIP_API_KEY=)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's/(PAPERCLIP_[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)=)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's@https://login[.]tailscale[.]com/a/[^[:space:]]+@[TAILSCALE_AUTH_URL_REDACTED]@g'
}

if [[ $# -eq 0 ]]; then
  # Pipe mode: buffer stdin, mask, emit masked output, flag if anything changed.
  tmp_in=$(mktemp)
  tmp_out=$(mktemp)
  trap 'rm -f "$tmp_in" "$tmp_out"' EXIT

  cat > "$tmp_in"
  _redact < "$tmp_in" > "$tmp_out"
  cat "$tmp_out"

  if ! cmp -s "$tmp_in" "$tmp_out"; then
    echo "[redact-run-output] SH-3: secret value masked from run-log output — log a redaction event" >&2
    exit 1
  fi
else
  # File mode: mask each file in-place.
  any_masked=0
  for f in "$@"; do
    if [[ ! -f "$f" ]]; then
      echo "[redact-run-output] WARNING: not a regular file, skipping: $f" >&2
      continue
    fi
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    _redact < "$f" > "$tmp"
    if ! cmp -s "$f" "$tmp"; then
      echo "[redact-run-output] SH-3: masking secret value in: $f" >&2
      mv "$tmp" "$f"
      any_masked=1
    else
      rm -f "$tmp"
    fi
  done
  exit "$any_masked"
fi
