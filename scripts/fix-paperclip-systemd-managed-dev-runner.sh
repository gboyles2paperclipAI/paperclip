#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="${PAPERCLIP_SYSTEMD_UNIT:-paperclip.service}"
DROPIN_DIR="${PAPERCLIP_SYSTEMD_DROPIN_DIR:-/etc/systemd/system/${UNIT_NAME}.d}"
DROPIN_FILE="${DROPIN_DIR}/90-repo-runtime.conf"
REPO_ROOT="${PAPERCLIP_REPO_ROOT:-/home/paperclipadmin/paperclip-src}"
PNPM_BIN="${PAPERCLIP_PNPM_BIN:-/usr/bin/pnpm}"
PATH_VALUE="${PAPERCLIP_SERVICE_PATH:-/home/paperclipadmin/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin}"

usage() {
  cat <<EOF
Usage: $0 [--check] [--apply]

Ensures ${UNIT_NAME} starts Paperclip through the repo managed dev runner
(\`pnpm dev\`) instead of directly starting @paperclipai/server.

Options:
  --check   Report whether the systemd drop-in is aligned.
  --apply   Write the corrected drop-in, daemon-reload, and restart the unit.
EOF
}

mode="check"
for arg in "$@"; do
  case "$arg" in
    --check) mode="check" ;;
    --apply) mode="apply" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage; exit 2 ;;
  esac
done

desired_content() {
  cat <<EOF
[Service]
WorkingDirectory=${REPO_ROOT}
ExecStart=
ExecStart=${PNPM_BIN} dev
Environment=PATH=${PATH_VALUE}
Environment=PAPERCLIP_SERVICE_RUNTIME=managed-dev-runner
EOF
}

current_exec_start() {
  systemctl cat "$UNIT_NAME" 2>/dev/null | awk '/^ExecStart=/{print}'
}

check_alignment() {
  local exec_start
  exec_start="$(current_exec_start || true)"

  if grep -q '^ExecStart=/usr/bin/pnpm --filter @paperclipai/server dev$' <<<"$exec_start"; then
    echo "FAIL: ${UNIT_NAME} directly starts @paperclipai/server and bypasses the managed dev runner." >&2
    return 1
  fi

  if ! grep -q "^ExecStart=${PNPM_BIN} dev$" <<<"$exec_start"; then
    echo "FAIL: ${UNIT_NAME} does not start via '${PNPM_BIN} dev'." >&2
    echo "Current ExecStart lines:" >&2
    printf '%s\n' "$exec_start" >&2
    return 1
  fi

  echo "PASS: ${UNIT_NAME} starts through the managed dev runner."
}

if [[ "$mode" == "check" ]]; then
  check_alignment
  exit $?
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: --apply must run as root. Use: sudo $0 --apply" >&2
  exit 1
fi

echo "Running runtime source preflight before restart..."
if ! node "${REPO_ROOT}/scripts/runtime-source-preflight.mjs" --repo-root "${REPO_ROOT}"; then
  echo "ABORT: restart blocked by runtime source preflight failure. Fix start-command/package-export mismatch first." >&2
  exit 1
fi

mkdir -p "$DROPIN_DIR"
if [[ -f "$DROPIN_FILE" ]]; then
  cp "$DROPIN_FILE" "${DROPIN_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi

desired_content >"$DROPIN_FILE"
chmod 0644 "$DROPIN_FILE"

systemctl daemon-reload
systemctl restart "$UNIT_NAME"

check_alignment
systemctl --no-pager --full status "$UNIT_NAME" | sed -n '1,24p'
