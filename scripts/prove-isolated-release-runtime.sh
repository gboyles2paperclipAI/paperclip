#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=""
OUTPUT=""
VERSION=""
SOURCE_COMMIT=""
PORT="31853"
MODE="isolated"
LIVE_PREFIX=""
SMOKE_PID=""
SMOKE_GROUP=""
TEMP_HOME=""

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    "Usage: $0 --install-root DIR --output DIR --version VERSION --source-commit SHA" \
    "  [--port PORT] [--mode isolated|host --live-prefix DIR]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root|--output|--version|--source-commit|--port|--mode|--live-prefix)
      [[ $# -ge 2 ]] || fail "$1 requires a value"
      case "$1" in
        --install-root) INSTALL_ROOT="$2" ;;
        --output) OUTPUT="$2" ;;
        --version) VERSION="$2" ;;
        --source-commit) SOURCE_COMMIT="$2" ;;
        --port) PORT="$2" ;;
        --mode) MODE="$2" ;;
        --live-prefix) LIVE_PREFIX="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unexpected argument: $1" ;;
  esac
done

for value in INSTALL_ROOT OUTPUT VERSION SOURCE_COMMIT; do
  [[ -n "${!value}" ]] || fail "missing required ${value,,}"
done
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] \
  || fail "source commit must be a full lowercase object id"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 1024 && PORT < 65536 )) \
  || fail "port must be an unprivileged TCP port"
[[ "$MODE" == "isolated" || "$MODE" == "host" ]] || fail "invalid proof mode"
if [[ "$MODE" == "host" ]]; then
  [[ -n "$LIVE_PREFIX" && -d "$LIVE_PREFIX" ]] || fail "host mode requires a live prefix"
fi

for command in cmp curl env find jq node pgrep realpath rg setsid sha256sum ss; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
if [[ "$MODE" == "host" ]]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is required in host mode"
fi

INSTALL_ROOT="$(realpath "$INSTALL_ROOT")"
OUTPUT="$(realpath -m "$OUTPUT")"
CLI="$INSTALL_ROOT/node_modules/.bin/paperclipai"
SERVER_ROOT="$INSTALL_ROOT/node_modules/@paperclipai/server"
[[ -x "$CLI" ]] || fail "installed Paperclip CLI is unavailable"
[[ -f "$SERVER_ROOT/dist/BUILD_COMMIT" ]] || fail "installed build marker is unavailable"
[[ "$(tr -d '\r\n' < "$SERVER_ROOT/dist/BUILD_COMMIT")" == "$SOURCE_COMMIT" ]] \
  || fail "installed build marker does not match the source commit"
[[ "$($CLI --version)" == "$VERSION" ]] || fail "installed CLI version does not match"

mkdir -p "$OUTPUT"
TEMP_HOME="$OUTPUT/disposable-home"
TMP_ROOT="$OUTPUT/tmp"
rm -rf -- "$TEMP_HOME" "$TMP_ROOT"
mkdir -m 700 "$TEMP_HOME" "$TMP_ROOT"

listener_exists() {
  ss -H -ltn "( sport = :$PORT )" | rg -q .
}

stop_smoke() {
  if [[ -n "$SMOKE_PID" ]]; then
    kill -TERM -- "-$SMOKE_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! pgrep -g "$SMOKE_PID" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    if pgrep -g "$SMOKE_PID" >/dev/null 2>&1; then
      kill -KILL -- "-$SMOKE_PID" 2>/dev/null || true
    fi
    wait "$SMOKE_PID" 2>/dev/null || true
    SMOKE_PID=""
  fi
}

cleanup() {
  stop_smoke
  rm -rf -- "$TEMP_HOME" "$TMP_ROOT"
}
trap cleanup EXIT

hash_live_runtime() {
  local destination="$1"
  (
    cd "$LIVE_PREFIX"
    find lib/node_modules/paperclipai lib/node_modules/@paperclipai \
      -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum
  ) > "$destination"
}

capture_host_state() {
  local phase="$1"
  systemctl is-active paperclip.service > "$OUTPUT/${phase}-paperclip-active.txt"
  systemctl is-enabled paperclip.service > "$OUTPUT/${phase}-paperclip-enabled.txt"
  systemctl is-active paperclip-staging.service \
    > "$OUTPUT/${phase}-staging-active.txt" 2>/dev/null || true
  ss -H -ltn "( sport = :3100 or sport = :3101 or sport = :3102 )" \
    > "$OUTPUT/${phase}-listeners.txt"
  curl -fsS --max-time 5 http://127.0.0.1:3100/api/health \
    | jq '{status, version, buildCommit}' > "$OUTPUT/${phase}-live-health.json"
  hash_live_runtime "$OUTPUT/${phase}-live-runtime.sha256"
}

assert_expected_host_state() {
  local phase="$1"
  [[ "$(< "$OUTPUT/${phase}-paperclip-active.txt")" == "active" ]] \
    || fail "paperclip.service is not active"
  [[ "$(< "$OUTPUT/${phase}-paperclip-enabled.txt")" == "enabled" ]] \
    || fail "paperclip.service is not enabled"
  [[ "$(< "$OUTPUT/${phase}-staging-active.txt")" == "inactive" ]] \
    || fail "paperclip-staging.service is active"
  [[ "$(ss -H -ltn "( sport = :3100 )" | wc -l)" -eq 1 ]] \
    || fail "expected exactly one live listener on port 3100"
  if ss -H -ltn "( sport = :3101 or sport = :3102 )" | rg -q .; then
    fail "unexpected staging Paperclip listener exists"
  fi
}

listener_exists && fail "isolated runtime port is already in use"
if [[ "$MODE" == "host" ]]; then
  capture_host_state before
  assert_expected_host_state before
fi

NODE_BIN="$(command -v node)"
SANITIZED_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin"
setsid env -i \
  PATH="$SANITIZED_PATH" \
  HOME="$TEMP_HOME" \
  TMPDIR="$TMP_ROOT" \
  PAPERCLIP_HOME="$TEMP_HOME" \
  PAPERCLIP_INSTANCE_ID="release-proof-${SOURCE_COMMIT:0:12}" \
  HOST="127.0.0.1" \
  PORT="$PORT" \
  PAPERCLIP_MIGRATION_AUTO_APPLY="true" \
  PAPERCLIP_MIGRATION_PROMPT="never" \
  "$CLI" onboard --yes > "$OUTPUT/isolated-runtime.log" 2>&1 &
SMOKE_PID=$!
SMOKE_GROUP="$SMOKE_PID"

health_ready=false
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" \
    -o "$OUTPUT/isolated-health.json"; then
    health_ready=true
    break
  fi
  kill -0 "$SMOKE_PID" 2>/dev/null || fail "isolated runtime exited before health was ready"
  sleep 1
done
[[ "$health_ready" == "true" ]] || fail "isolated runtime health timed out"

curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" -o "$OUTPUT/isolated-index.html"
jq -e \
  --arg version "$VERSION" \
  --arg source "$SOURCE_COMMIT" \
  '.status == "ok" and .version == $version and .buildCommit == $source' \
  "$OUTPUT/isolated-health.json" >/dev/null \
  || fail "isolated health does not match governed version and source commit"
rg -q '<div id="root">' "$OUTPUT/isolated-index.html" \
  || fail "isolated static UI root mount is missing"

stop_smoke
for _ in $(seq 1 20); do
  listener_exists || break
  sleep 1
done
listener_exists && fail "isolated runtime listener survived shutdown"
if pgrep -g "$SMOKE_GROUP" >/dev/null 2>&1; then
  fail "isolated runtime process group survived shutdown"
fi

if rg --pcre2 -q \
  '(?:ghp_|gho_|github_pat_|sk-)[A-Za-z0-9_-]{12,}|Authorization:\s*(?!\[(?:REDACTED|redacted)\])\S+' \
  "$OUTPUT/isolated-runtime.log"; then
  fail "isolated runtime log contains credential-shaped output"
fi

if [[ "$MODE" == "host" ]]; then
  capture_host_state after
  assert_expected_host_state after
  cmp -s "$OUTPUT/before-live-runtime.sha256" "$OUTPUT/after-live-runtime.sha256" \
    || fail "live runtime bytes changed during isolated proof"
  cmp -s "$OUTPUT/before-paperclip-active.txt" "$OUTPUT/after-paperclip-active.txt" \
    || fail "paperclip.service active state changed"
  cmp -s "$OUTPUT/before-paperclip-enabled.txt" "$OUTPUT/after-paperclip-enabled.txt" \
    || fail "paperclip.service enabled state changed"
  cmp -s "$OUTPUT/before-staging-active.txt" "$OUTPUT/after-staging-active.txt" \
    || fail "staging service state changed"
  cmp -s "$OUTPUT/before-listeners.txt" "$OUTPUT/after-listeners.txt" \
    || fail "live Paperclip listeners changed"
  cmp -s "$OUTPUT/before-live-health.json" "$OUTPUT/after-live-health.json" \
    || fail "live health identity changed"
fi

jq -n \
  --arg status PASS \
  --arg mode "$MODE" \
  --arg version "$VERSION" \
  --arg sourceCommit "$SOURCE_COMMIT" \
  --argjson port "$PORT" \
  '{status:$status, mode:$mode, version:$version, sourceCommit:$sourceCommit, port:$port, processGroupTerminated:true, listenerTerminated:true, liveStateUnchanged:($mode == "host")}' \
  > "$OUTPUT/result.json"

printf 'Isolated runtime proof PASS: %s\n' "$OUTPUT"
