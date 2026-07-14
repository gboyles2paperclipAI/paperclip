#!/usr/bin/env bash
set -euo pipefail

# build-npm.sh — Build the paperclipai CLI package for npm publishing.
#
# Uses esbuild to bundle all workspace code into a single file,
# keeping external npm dependencies as regular package dependencies.
#
# Usage:
#   ./scripts/build-npm.sh               # full build
#   ./scripts/build-npm.sh --skip-checks  # skip publishable-package forbidden-token check

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
DIST_DIR="$CLI_DIR/dist"

skip_checks=false
skip_typecheck=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=true ;;
    --skip-typecheck) skip_typecheck=true ;;
  esac
done

echo "==> Building paperclipai for npm"

# ── Step 1: TypeScript type-check ──────────────────────────────────────────────
if [ "$skip_typecheck" = false ]; then
  echo "  [1/7] Type-checking..."
  cd "$REPO_ROOT"
  pnpm -r typecheck
else
  echo "  [1/7] Skipping type-check (--skip-typecheck)"
fi

# ── Step 2: Bundle CLI with esbuild ────────────────────────────────────────────
echo "  [2/7] Bundling CLI with esbuild..."
cd "$CLI_DIR"
rm -rf dist

node --input-type=module -e "
import esbuild from 'esbuild';
import config from './esbuild.config.mjs';
await esbuild.build(config);
"

chmod +x dist/index.js

# ── Step 3: Validate bundled entrypoint syntax ─────────────────────────────────
echo "  [3/7] Verifying bundled entrypoint syntax..."
node --check "$DIST_DIR/index.js"

# ── Step 4: Back up dev package.json, generate publishable one ─────────────────
echo "  [4/7] Generating publishable package.json..."
cp "$CLI_DIR/package.json" "$CLI_DIR/package.dev.json"
node "$REPO_ROOT/scripts/generate-npm-package-json.mjs"

# Copy root README so npm shows the repo README on the package page
cp "$REPO_ROOT/README.md" "$CLI_DIR/README.md"

# ── Step 5: Scan the exact publishable npm file set ────────────────────────────
if [ "$skip_checks" = false ]; then
  echo "  [5/7] Scanning publishable package files for forbidden tokens..."
  node "$REPO_ROOT/scripts/check-forbidden-tokens.mjs" --npm-package-dir "$CLI_DIR"
else
  echo "  [5/7] Skipping publishable-package forbidden-token check (--skip-checks)"
fi

# ── Step 6: Validate service package entrypoint and resolved server dist ───────
echo "  [6/7] Verifying service package integrity..."
"$REPO_ROOT/scripts/verify-package-integrity.sh" "$CLI_DIR"

# ── Step 7: Summary ───────────────────────────────────────────────────────────
BUNDLE_SIZE=$(wc -c < "$DIST_DIR/index.js" | xargs)
echo "  [7/7] Build verification..."
echo ""
echo "Build complete."
echo "  Bundle: cli/dist/index.js (${BUNDLE_SIZE} bytes)"
echo "  Source map: cli/dist/index.js.map"
echo ""
echo "To preview a release: ./scripts/release.sh canary --dry-run"
echo "To publish a canary: ./scripts/release.sh canary"
echo "To publish a stable: ./scripts/release.sh stable"
echo "For one-time package bootstrap: pnpm run release:bootstrap-package -- @paperclipai/example"
echo "To restore:   mv cli/package.dev.json cli/package.json"
