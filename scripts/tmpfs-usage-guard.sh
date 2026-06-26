#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob dotglob

usage() {
  cat <<'EOF'
Usage:
  scripts/tmpfs-usage-guard.sh [--apply] [--json] [--force-pressure]

Monitors /tmp tmpfs pressure using metadata-only checks.

Thresholds:
  bytes  >= 75%
  inodes >= 80%

When pressure is crossed, the script inventories top-level /tmp consumers by
path metadata only. With --apply, it removes only stale directories owned by
the current user whose names match narrow Paperclip/runtime transient patterns.

--force-pressure is for dry-run validation only and is rejected with --apply.
--du-timeout-seconds bounds each top-level size check.
--inventory-deadline-seconds bounds the whole inventory pass.
EOF
}

apply=false
json=false
force_pressure=false
tmp_dir="${TMPFS_GUARD_TMP_DIR:-/tmp}"
bytes_threshold="${TMPFS_GUARD_BYTES_THRESHOLD:-75}"
inodes_threshold="${TMPFS_GUARD_INODES_THRESHOLD:-80}"
stale_minutes="${TMPFS_GUARD_STALE_MINUTES:-720}"
max_inventory="${TMPFS_GUARD_MAX_INVENTORY:-25}"
du_timeout_seconds="${TMPFS_GUARD_DU_TIMEOUT_SECONDS:-5}"
inventory_deadline_seconds="${TMPFS_GUARD_INVENTORY_DEADLINE_SECONDS:-45}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=true
      shift
      ;;
    --json)
      json=true
      shift
      ;;
    --force-pressure)
      force_pressure=true
      shift
      ;;
    --tmp-dir)
      tmp_dir="${2:?missing path for --tmp-dir}"
      shift 2
      ;;
    --bytes-threshold)
      bytes_threshold="${2:?missing percent for --bytes-threshold}"
      shift 2
      ;;
    --inodes-threshold)
      inodes_threshold="${2:?missing percent for --inodes-threshold}"
      shift 2
      ;;
    --stale-minutes)
      stale_minutes="${2:?missing minutes for --stale-minutes}"
      shift 2
      ;;
    --max-inventory)
      max_inventory="${2:?missing count for --max-inventory}"
      shift 2
      ;;
    --du-timeout-seconds)
      du_timeout_seconds="${2:?missing seconds for --du-timeout-seconds}"
      shift 2
      ;;
    --inventory-deadline-seconds)
      inventory_deadline_seconds="${2:?missing seconds for --inventory-deadline-seconds}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$apply" == true && "$force_pressure" == true ]]; then
  echo "FAIL: --force-pressure is dry-run only and cannot be combined with --apply" >&2
  exit 2
fi

validate_integer() {
  local value_name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "FAIL: $value_name must be an integer" >&2
    exit 2
  fi
}

validate_integer bytes_threshold "$bytes_threshold"
validate_integer inodes_threshold "$inodes_threshold"
validate_integer stale_minutes "$stale_minutes"
validate_integer max_inventory "$max_inventory"
validate_integer du_timeout_seconds "$du_timeout_seconds"
validate_integer inventory_deadline_seconds "$inventory_deadline_seconds"

if [[ ! -d "$tmp_dir" ]]; then
  echo "FAIL: tmp dir does not exist: $tmp_dir" >&2
  exit 1
fi

current_uid="$(id -u)"
now_epoch="$(date +%s)"

df_bytes_line="$(df -Pk "$tmp_dir" | awk 'NR==2 { print $2, $3, $4, $5, $6 }')"
df_inodes_line="$(df -Pik "$tmp_dir" | awk 'NR==2 { print $2, $3, $4, $5, $6 }')"
read -r bytes_total_kb bytes_used_kb bytes_avail_kb bytes_percent_raw mount_path <<< "$df_bytes_line"
read -r inodes_total inodes_used inodes_avail inodes_percent_raw _inode_mount_path <<< "$df_inodes_line"

bytes_percent="${bytes_percent_raw%%%}"
inodes_percent="${inodes_percent_raw%%%}"

pressure=false
pressure_reasons=()
if (( bytes_percent >= bytes_threshold )); then
  pressure=true
  pressure_reasons+=("bytes")
fi
if (( inodes_percent >= inodes_threshold )); then
  pressure=true
  pressure_reasons+=("inodes")
fi
if [[ "$force_pressure" == true ]]; then
  pressure=true
  pressure_reasons+=("forced_dry_run")
fi

is_cleanup_candidate() {
  local path="$1"
  local name
  name="$(basename "$path")"

  case "$name" in
    .env|.env.*|.vercel|.update-*)
      return 1
      ;;
  esac

  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$(stat -c '%u' "$path" 2>/dev/null || echo '')" == "$current_uid" ]] || return 1

  case "$name" in
    paperclip-*|paperclipai-*|tmp-paperclip-*|paperclip-runtime-*|paperclip-agent-*|\
    vite-*|vitest-*|playwright-*|puppeteer_dev_chrome_profile-*|chrome-user-data-*|\
    chromium-*|tmp-vite-*|tmp-vitest-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_forbidden_secret_path_name() {
  local name="$1"
  case "$name" in
    .env|.env.*|.vercel|.update-*|*.env|*.env.*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

contains_forbidden_secret_path_name() {
  local path="$1"
  local forbidden
  forbidden="$(
    find "$path" -xdev \( \
      -name '.env' -o \
      -name '.env.*' -o \
      -name '.vercel' -o \
      -name '.update-*' -o \
      -name '*.env' -o \
      -name '*.env.*' \
    \) -print -quit 2>/dev/null || true
  )"
  [[ -n "$forbidden" ]]
}

has_active_process_reference() {
  local candidate="$1"
  local proc_path ref
  for proc_path in /proc/[0-9]*/cwd /proc/[0-9]*/root /proc/[0-9]*/exe /proc/[0-9]*/fd/*; do
    ref="$(readlink "$proc_path" 2>/dev/null || true)"
    [[ -n "$ref" ]] || continue
    ref="${ref% (deleted)}"
    if [[ "$ref" == "$candidate" || "$ref" == "$candidate/"* ]]; then
      return 0
    fi
  done
  return 1
}

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

json_bool() {
  if [[ "$1" == true ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

inventory_records=()
cleanup_records=()
inventory_truncated=false
removed_count=0
removed_kb=0

if [[ "$pressure" == true ]]; then
  inventory_started_epoch="$(date +%s)"
  while IFS= read -r -d '' entry; do
    if (( $(date +%s) - inventory_started_epoch >= inventory_deadline_seconds )); then
      inventory_truncated=true
      break
    fi
    entry_name="$(basename "$entry")"
    if is_forbidden_secret_path_name "$entry_name"; then
      continue
    fi
    entry_type="$(stat -c '%F' "$entry" 2>/dev/null || echo unknown)"
    entry_uid="$(stat -c '%u' "$entry" 2>/dev/null || echo unknown)"
    entry_mode="$(stat -c '%a' "$entry" 2>/dev/null || echo unknown)"
    entry_mtime="$(stat -c '%Y' "$entry" 2>/dev/null || echo 0)"
    entry_size_status="measured"
    entry_size_raw="$(timeout "${du_timeout_seconds}s" du -skx -- "$entry" 2>/dev/null | awk '{ print $1 }' || true)"
    entry_size_kb="${entry_size_raw:-0}"
    if [[ -z "$entry_size_raw" ]]; then
      entry_size_status="timeout_or_unreadable"
    fi
    inventory_records+=("$entry_size_kb"$'\t'"$entry"$'\t'"$entry_name"$'\t'"$entry_type"$'\t'"$entry_uid"$'\t'"$entry_mode"$'\t'"$entry_mtime"$'\t'"$entry_size_status")
  done < <(find "$tmp_dir" -mindepth 1 -maxdepth 1 -xdev -print0 2>/dev/null)

  if (( ${#inventory_records[@]} > 0 )); then
    mapfile -t inventory_records < <(printf '%s\n' "${inventory_records[@]}" | sort -rn -k1,1 | head -n "$max_inventory")
  fi

  cutoff_epoch=$((now_epoch - (stale_minutes * 60)))
  for record in "${inventory_records[@]}"; do
    IFS=$'\t' read -r size_kb path _name _type _uid _mode mtime _size_status <<< "$record"
    if ! is_cleanup_candidate "$path"; then
      continue
    fi
    if (( mtime > cutoff_epoch )); then
      cleanup_records+=("skipped_recent"$'\t'"$size_kb"$'\t'"$path"$'\t'"mtime newer than stale cutoff")
      continue
    fi
    if contains_forbidden_secret_path_name "$path"; then
      cleanup_records+=("skipped_forbidden_name"$'\t'"$size_kb"$'\t'"$path"$'\t'"contains forbidden secret-bearing path name")
      continue
    fi
    if has_active_process_reference "$path"; then
      cleanup_records+=("skipped_active_process"$'\t'"$size_kb"$'\t'"$path"$'\t'"active process references path")
      continue
    fi

    if [[ "$apply" == true ]]; then
      rm -rf --one-file-system -- "$path"
      cleanup_records+=("removed"$'\t'"$size_kb"$'\t'"$path"$'\t'"stale owned transient directory")
      removed_count=$((removed_count + 1))
      removed_kb=$((removed_kb + size_kb))
    else
      cleanup_records+=("would_remove"$'\t'"$size_kb"$'\t'"$path"$'\t'"stale owned transient directory")
    fi
  done
fi

emit_json() {
  local first
  local display_tmp_dir="$tmp_dir"
  if [[ "$tmp_dir" != "/tmp" ]]; then
    display_tmp_dir="[custom tmp dir redacted]"
  fi
  declare -A path_refs=()
  printf '{'
  printf '"timestamp":%s,' "$(json_string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
  printf '"tmpDir":%s,' "$(json_string "$display_tmp_dir")"
  printf '"mode":%s,' "$(json_string "$([[ "$apply" == true ]] && echo apply || echo dry_run)")"
  printf '"thresholds":{"bytesPercent":%s,"inodesPercent":%s,"staleMinutes":%s},' "$bytes_threshold" "$inodes_threshold" "$stale_minutes"
  printf '"limits":{"maxInventory":%s,"duTimeoutSeconds":%s,"inventoryDeadlineSeconds":%s},' "$max_inventory" "$du_timeout_seconds" "$inventory_deadline_seconds"
  printf '"usage":{"mount":%s,"bytes":{"totalKb":%s,"usedKb":%s,"availableKb":%s,"percent":%s},"inodes":{"total":%s,"used":%s,"available":%s,"percent":%s}},' \
    "$(json_string "$mount_path")" "$bytes_total_kb" "$bytes_used_kb" "$bytes_avail_kb" "$bytes_percent" \
    "$inodes_total" "$inodes_used" "$inodes_avail" "$inodes_percent"
  printf '"pressure":%s,' "$pressure"
  printf '"pressureReasons":['
  first=true
  for reason in "${pressure_reasons[@]}"; do
    [[ "$first" == true ]] || printf ','
    first=false
    printf '%s' "$(json_string "$reason")"
  done
  printf '],'
  printf '"inventory":['
  first=true
  record_index=0
  for record in "${inventory_records[@]}"; do
    IFS=$'\t' read -r size_kb path name type uid mode mtime size_status <<< "$record"
    [[ "$first" == true ]] || printf ','
    first=false
    record_index=$((record_index + 1))
    ref="$(printf 'tmp-entry-%03d' "$record_index")"
    path_refs["$path"]="$ref"
    cleanup_candidate=false
    if is_cleanup_candidate "$path"; then
      cleanup_candidate=true
    fi
    printf '{"ref":%s,"location":%s,"basenameLength":%s,"type":%s,"uid":%s,"mode":%s,"mtimeEpoch":%s,"sizeKb":%s,"sizeStatus":%s,"cleanupCandidate":%s}' \
      "$(json_string "$ref")" "$(json_string "top-level tmp entry")" "${#name}" "$(json_string "$type")" "$(json_string "$uid")" "$(json_string "$mode")" "$mtime" "$size_kb" "$(json_string "$size_status")" "$(json_bool "$cleanup_candidate")"
  done
  printf '],'
  printf '"inventoryTruncated":%s,' "$inventory_truncated"
  printf '"cleanup":['
  first=true
  for record in "${cleanup_records[@]}"; do
    IFS=$'\t' read -r action size_kb path reason <<< "$record"
    [[ "$first" == true ]] || printf ','
    first=false
    ref="${path_refs[$path]:-tmp-entry-unknown}"
    printf '{"action":%s,"ref":%s,"sizeKb":%s,"reason":%s}' \
      "$(json_string "$action")" "$(json_string "$ref")" "$size_kb" "$(json_string "$reason")"
  done
  printf '],'
  printf '"removed":{"count":%s,"sizeKb":%s}' "$removed_count" "$removed_kb"
  printf '}\n'
}

emit_text() {
  echo "tmpfs usage guard"
  echo "mode: $([[ "$apply" == true ]] && echo apply || echo dry_run)"
  echo "usage: bytes=${bytes_percent}% inodes=${inodes_percent}%"
  echo "pressure: $pressure (${pressure_reasons[*]:-none})"
  echo "inventory_count: ${#inventory_records[@]}"
  echo "cleanup_actions: ${#cleanup_records[@]}"
  echo "inventory_truncated: $inventory_truncated"
  echo "removed_count: $removed_count"
  echo "removed_size_kb: $removed_kb"
}

if [[ "$json" == true ]]; then
  emit_json
else
  emit_text
fi
