#!/usr/bin/env bash
set -euo pipefail

# Verify the exact @paperclipai/server tarball payload, not only the workspace
# dist that exists before npm applies package file-selection rules.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-packed-server.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

(
  cd "$REPO_ROOT/server"
  npm pack --ignore-scripts --loglevel error --pack-destination "$TMP_DIR" >/dev/null
)

shopt -s nullglob
tarballs=("$TMP_DIR"/*.tgz)
if [ "${#tarballs[@]}" -ne 1 ]; then
  echo "Packed server integrity check failed: expected exactly one tarball" >&2
  exit 1
fi

mkdir -p "$TMP_DIR/unpacked"
tar -xzf "${tarballs[0]}" -C "$TMP_DIR/unpacked"
"$REPO_ROOT/scripts/verify-package-integrity.sh" "$TMP_DIR/unpacked/package"
echo "Packed server integrity check passed"
