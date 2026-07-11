#!/usr/bin/env bash
set -euo pipefail

# verify-package-integrity.sh - Fail fast if a built Paperclip package is
# missing mandatory runtime safety markers.
#
# Usage:
#   ./scripts/verify-package-integrity.sh <built-dist-or-package-path>
#
# The target may be server/dist, an installed @paperclipai/server package root,
# a paperclipai package root, paperclipai/dist/index.js, or a node_modules/prefix
# containing both paperclipai and @paperclipai/server. This script verifies only.
# It never installs or mutates package contents.

target="${1:-}"

if [ -z "$target" ]; then
  echo "Usage: $0 <built-dist-or-package-path>" >&2
  exit 2
fi

if [ ! -e "$target" ]; then
  echo "Package integrity check failed: target does not exist: $target" >&2
  exit 1
fi

dist_dir=""
cli_entrypoint=""

abs_path() {
  local path="$1"
  if [ -d "$path" ]; then
    (cd "$path" && pwd -P)
  else
    local dir
    dir="$(dirname "$path")"
    local base
    base="$(basename "$path")"
    (cd "$dir" && printf '%s/%s\n' "$(pwd -P)" "$base")
  fi
}

is_paperclipai_package_root() {
  local dir="$1"
  [ -f "$dir/package.json" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"paperclipai"' "$dir/package.json"
}

detect_cli_entrypoint() {
  local candidate="$1"

  if [ -f "$candidate" ]; then
    case "$candidate" in
      */paperclipai/dist/index.js|*/cli/dist/index.js|*/dist/index.js)
        cli_entrypoint="$(abs_path "$candidate")"
        ;;
    esac
    return
  fi

  if [ -f "$candidate/dist/index.js" ] && is_paperclipai_package_root "$candidate"; then
    cli_entrypoint="$(abs_path "$candidate/dist/index.js")"
    return
  fi

  if [ -f "$candidate/lib/node_modules/paperclipai/dist/index.js" ]; then
    cli_entrypoint="$(abs_path "$candidate/lib/node_modules/paperclipai/dist/index.js")"
    return
  fi

  if [ -f "$candidate/paperclipai/dist/index.js" ]; then
    cli_entrypoint="$(abs_path "$candidate/paperclipai/dist/index.js")"
  fi
}

detect_server_dist() {
  local candidate="$1"

  if [ -f "$candidate/routes/agents.js" ]; then
    dist_dir="$(abs_path "$candidate")"
    return
  fi

  if [ -d "$candidate" ]; then
    if [ -f "$candidate/dist/routes/agents.js" ]; then
      dist_dir="$(abs_path "$candidate/dist")"
      return
    fi

    if [ -f "$candidate/server/dist/routes/agents.js" ]; then
      dist_dir="$(abs_path "$candidate/server/dist")"
      return
    fi

    if [ -f "$candidate/lib/node_modules/@paperclipai/server/dist/routes/agents.js" ]; then
      dist_dir="$(abs_path "$candidate/lib/node_modules/@paperclipai/server/dist")"
      return
    fi

    if [ -f "$candidate/@paperclipai/server/dist/routes/agents.js" ]; then
      dist_dir="$(abs_path "$candidate/@paperclipai/server/dist")"
      return
    fi
  fi
}

resolve_server_dist_from_cli() {
  local entrypoint="$1"
  local package_root
  package_root="$(cd "$(dirname "$entrypoint")/.." && pwd -P)"
  local node_modules_root
  node_modules_root="$(dirname "$package_root")"
  local repo_root
  repo_root="$(dirname "$package_root")"

  local candidates=(
    "$node_modules_root/@paperclipai/server/dist"
    "$repo_root/server/dist"
  )

  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate/routes/agents.js" ]; then
      dist_dir="$(abs_path "$candidate")"
      return
    fi
  done
}

target_abs="$(abs_path "$target")"
detect_cli_entrypoint "$target_abs"
detect_server_dist "$target_abs"

if [ -n "$cli_entrypoint" ] && [ -z "$dist_dir" ]; then
  resolve_server_dist_from_cli "$cli_entrypoint"
fi

if [ -z "$dist_dir" ]; then
  echo "Package integrity check failed: could not find @paperclipai/server dist/routes/agents.js from target: $target" >&2
  exit 1
fi

agents_js="$dist_dir/routes/agents.js"
agent_auth_jwt_js="$dist_dir/agent-auth-jwt.js"
better_auth_js="$dist_dir/auth/better-auth.js"
board_chat_js="$dist_dir/routes/board-chat.js"
companies_js="$dist_dir/routes/companies.js"
config_js="$dist_dir/config.js"
workspace_runtime_js="$dist_dir/services/workspace-runtime.js"
missing=()

require_in_file() {
  local file="$1"
  local marker="$2"
  local label="$3"

  if ! grep -Fq "$marker" "$file"; then
    missing+=("$label in $file")
  fi
}

require_in_dist() {
  local marker="$1"
  local label="$2"

  if ! grep -R --include='*.js' --include='*.mjs' --include='*.cjs' -Fq "$marker" "$dist_dir"; then
    missing+=("$label")
  fi
}

forbid_in_file() {
  local file="$1"
  local marker="$2"
  local label="$3"

  if [ -f "$file" ] && grep -Fq "$marker" "$file"; then
    missing+=("$label in $file")
  fi
}

if [ -n "$cli_entrypoint" ]; then
  require_in_file "$cli_entrypoint" "@paperclipai/server" "service entrypoint imports published @paperclipai/server"
  require_in_file "$cli_entrypoint" "authenticated mode requires BETTER_AUTH_SECRET" "CLI authenticated-mode requires dedicated auth secret marker"
  forbid_in_file "$cli_entrypoint" "BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()" "CLI auth check must not fall back to agent JWT secret"
  forbid_in_file "$cli_entrypoint" "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)" "CLI auth failure copy must not advertise agent JWT secret fallback"
fi

require_in_file "$agents_js" "parseInt(limitParam, 10) || 50)) : 50" "heartbeat-runs default limit cap in routes/agents.js"
require_in_file "$agents_js" "heartbeat.list(companyId, agentId, limit, { summary })" "heartbeat-runs capped list call in routes/agents.js"
require_in_dist "pending_issue_thread_interaction" "#51 pending issue thread interaction marker"
require_in_dist "premiumManagedMaxConcurrentRuns" "#51 premium managed concurrency marker"
require_in_file "$board_chat_js" "buildSafeInheritedProcessEnv" "board-chat safe child env marker"
require_in_file "$workspace_runtime_js" "sanitizeRuntimeServiceBaseEnv" "workspace-runtime safe child env marker"
require_in_file "$config_js" "PAPERCLIP_ENABLE_COMPANY_DELETION" "company deletion explicit env marker"
require_in_file "$config_js" "toLowerCase() === \"true\"" "company deletion explicit true parser marker"
require_in_file "$companies_js" "Company deletion is disabled" "DELETE route disabled marker"
require_in_file "$companies_js" "companyDeletionEnabled !== true" "DELETE route fail-closed marker"
require_in_file "$agent_auth_jwt_js" "PAPERCLIP_AGENT_JWT_ENABLE_LEGACY_FALLBACK" "explicit legacy fallback opt-in marker"
require_in_file "$agent_auth_jwt_js" "legacyFallbackEnabled" "legacy fallback disabled-by-default marker"
require_in_file "$agent_auth_jwt_js" "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK" "legacy fallback disable guard marker"
forbid_in_file "$agent_auth_jwt_js" "BETTER_AUTH_SECRET" "agent JWT must not fall back to BETTER_AUTH_SECRET"
require_in_file "$better_auth_js" "BETTER_AUTH_SECRET must be set in authenticated mode" "Better Auth dedicated-secret requirement"
require_in_file "$better_auth_js" "BETTER_AUTH_SECRET and PAPERCLIP_AGENT_JWT_SECRET must be distinct" "Better Auth secret separation guard"
forbid_in_file "$better_auth_js" "BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET" "Better Auth must not fall back to agent JWT secret"
forbid_in_file "$better_auth_js" "BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()" "Better Auth trimmed secret must not fall back to agent JWT secret"

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Package integrity check failed for $dist_dir:" >&2
  for label in "${missing[@]}"; do
    echo "  missing: $label" >&2
  done
  exit 1
fi

if [ -n "$cli_entrypoint" ]; then
  echo "Package integrity check passed for service entrypoint $cli_entrypoint and server dist $dist_dir"
else
  echo "Package integrity check passed for $dist_dir"
fi
