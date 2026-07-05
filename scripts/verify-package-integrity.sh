#!/usr/bin/env bash
set -euo pipefail

# verify-package-integrity.sh - Fail fast if a built Paperclip server package is
# missing mandatory runtime safety markers.
#
# Usage:
#   ./scripts/verify-package-integrity.sh <built-dist-or-package-path>
#
# The target may be server/dist, an installed @paperclipai/server package root,
# or another package root containing dist/routes/agents.js. This script verifies
# only. It never installs or mutates package contents.

target="${1:-}"

if [ -z "$target" ]; then
  echo "Usage: $0 <built-dist-or-package-path>" >&2
  exit 2
fi

if [ ! -e "$target" ]; then
  echo "Package integrity check failed: target does not exist: $target" >&2
  exit 1
fi

if [ -f "$target/routes/agents.js" ]; then
  dist_dir="$target"
elif [ -f "$target/dist/routes/agents.js" ]; then
  dist_dir="$target/dist"
elif [ -f "$target/server/dist/routes/agents.js" ]; then
  dist_dir="$target/server/dist"
else
  echo "Package integrity check failed: could not find dist/routes/agents.js under $target" >&2
  exit 1
fi

agents_js="$dist_dir/routes/agents.js"
missing=()

require_in_file() {
  local file="$1"
  local marker="$2"
  local label="$3"

  if ! grep -Fq "$marker" "$file"; then
    missing+=("$label")
  fi
}

require_in_dist() {
  local marker="$1"
  local label="$2"

  if ! grep -R --include='*.js' --include='*.mjs' --include='*.cjs' -Fq "$marker" "$dist_dir"; then
    missing+=("$label")
  fi
}

require_in_file "$agents_js" "parseInt(limitParam, 10) || 50)) : 50" "heartbeat-runs default limit cap in routes/agents.js"
require_in_file "$agents_js" "heartbeat.list(companyId, agentId, limit, { summary })" "heartbeat-runs capped list call in routes/agents.js"
require_in_dist "pending_issue_thread_interaction" "#51 pending issue thread interaction marker"
require_in_dist "premiumManagedMaxConcurrentRuns" "#51 premium managed concurrency marker"

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Package integrity check failed for $dist_dir:" >&2
  for label in "${missing[@]}"; do
    echo "  missing: $label" >&2
  done
  exit 1
fi

echo "Package integrity check passed for $dist_dir"
