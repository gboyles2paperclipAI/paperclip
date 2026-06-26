#!/usr/bin/env bash
set -u

EVIDENCE="${EVIDENCE:-/home/paperclipadmin/fleet-finalization-20260625T175457Z}"
OUT_DIR="$EVIDENCE/monitoring"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUMMARY="$OUT_DIR/fleet-health-$STAMP.tsv"
DETAIL="$OUT_DIR/fleet-health-$STAMP.md"
LATEST="$OUT_DIR/fleet-health-latest.tsv"
PROM="$OUT_DIR/fleet-health-$STAMP.prom"

mkdir -p "$OUT_DIR"

write_row() {
  local host="$1" check="$2" status="$3" evidence="$4"
  evidence="$(printf '%s' "$evidence" | tr '\t\r\n' '   ' | sed 's/  */ /g; s/^ //; s/ $//')"
  printf '%s\t%s\t%s\t%s\n' "$host" "$check" "$status" "$evidence" >> "$SUMMARY"
}

metric() {
  local name="$1" labels="$2" value="$3"
  printf '%s{%s} %s\n' "$name" "$labels" "$value" >> "$PROM"
}

run_remote() {
  local host="$1"
  shift
  timeout 15s ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" "$@" 2>&1
}

probe_http() {
  timeout 8s curl -fsS --max-time 5 "$1" >/dev/null 2>&1
}

: > "$SUMMARY"
: > "$PROM"
printf 'host\tcheck\tstatus\tevidence\n' >> "$SUMMARY"
printf '# Fleet Health Check\n\nCollected UTC: `%s`\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DETAIL"

if systemctl is-active --quiet paperclip.service; then
  write_row paperclip01 paperclip_service_active PASS active
  metric paperclip_service_active 'host="paperclip01"' 1
else
  state="$(systemctl is-active paperclip.service 2>/dev/null || true)"
  write_row paperclip01 paperclip_service_active FAIL "$state"
  metric paperclip_service_active 'host="paperclip01"' 0
fi

if ss -ltn 2>/dev/null | awk '$4 ~ /127[.]0[.]0[.]1:3100$/ {found=1} END{exit found?0:1}'; then
  write_row paperclip01 paperclip_loopback_3100 PASS "127.0.0.1:3100"
  metric paperclip_loopback_3100 'host="paperclip01"' 1
else
  write_row paperclip01 paperclip_loopback_3100 FAIL "missing"
  metric paperclip_loopback_3100 'host="paperclip01"' 0
fi

if probe_http http://127.0.0.1:3100/; then
  write_row paperclip01 paperclip_http_responsive PASS "GET /"
  metric paperclip_http_responsive 'host="paperclip01"' 1
else
  write_row paperclip01 paperclip_http_responsive FAIL "GET / failed"
  metric paperclip_http_responsive 'host="paperclip01"' 0
fi

root_use="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
write_row paperclip01 root_fs_used_percent INFO "${root_use:-unknown}"
metric filesystem_used_percent 'host="paperclip01",mount="/"' "${root_use:-0}"

backup_archive="$(ls -1t /backups/fleet-finalization-*/paperclip01-app-state-*.tar.zst 2>/dev/null | head -1)"
if [ -n "$backup_archive" ] && [ -s "$backup_archive" ]; then
  age_seconds=$(( $(date +%s) - $(stat -c %Y "$backup_archive") ))
  write_row paperclip01 paperclip_backup_latest PASS "$backup_archive age_seconds=$age_seconds"
  metric backup_age_seconds 'host="paperclip01",job="app-state-zstd"' "$age_seconds"
else
  write_row paperclip01 paperclip_backup_latest FAIL "missing or empty archive"
  metric backup_age_seconds 'host="paperclip01",job="app-state-zstd"' -1
fi

if [ -f /var/run/reboot-required ]; then
  write_row paperclip01 reboot_required WARN "/var/run/reboot-required"
  metric reboot_required 'host="paperclip01"' 1
else
  write_row paperclip01 reboot_required PASS "not required"
  metric reboot_required 'host="paperclip01"' 0
fi

failed_count="$(systemctl --failed --no-legend --plain 2>/dev/null | awk 'NF {count++} END {print count + 0}')"
failed_units="$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | paste -sd, -)"
if [ -n "$failed_units" ]; then
  write_row paperclip01 failed_units WARN "$failed_units"
  metric failed_units 'host="paperclip01"' "$failed_count"
else
  write_row paperclip01 failed_units PASS "none"
  metric failed_units 'host="paperclip01"' 0
fi

for host in paperclipapi paperclipdb1; do
  if run_remote "$host" 'hostname >/dev/null'; then
    write_row "$host" ssh_reachable PASS reachable
    metric ssh_reachable "host=\"$host\"" 1
  else
    write_row "$host" ssh_reachable FAIL "unreachable"
    metric ssh_reachable "host=\"$host\"" 0
    continue
  fi

  listeners="$(run_remote "$host" 'ss -ltn 2>/dev/null | awk '"'"'NR>1 {print $4}'"'"' | sort -u | paste -sd, -')"
  write_row "$host" listeners INFO "${listeners:-none}"

  if [ "$host" = paperclipapi ]; then
    bad="$(run_remote "$host" 'ss -ltn 2>/dev/null | awk '"'"'$4 ~ /:(3100|5432|9100|11434)$/ {print $4}'"'"'')"
    if [ -z "$bad" ]; then
      write_row "$host" no_disallowed_runtime_ports PASS "no 3100/5432/9100/11434"
      metric disallowed_runtime_ports "host=\"$host\"" 0
    else
      write_row "$host" no_disallowed_runtime_ports FAIL "$bad"
      metric disallowed_runtime_ports "host=\"$host\"" "$(printf '%s\n' "$bad" | sed '/^$/d' | wc -l)"
    fi
    svc="$(run_remote "$host" 'systemctl is-active paperclipapi.service 2>/dev/null || true; systemctl is-enabled paperclipapi.service 2>/dev/null || true')"
    write_row "$host" paperclipapi_service_state INFO "$svc"
  fi

  if [ "$host" = paperclipdb1 ]; then
    pg_listeners="$(run_remote "$host" 'ss -ltn 2>/dev/null | awk '"'"'$4 ~ /:5432$/ {print $4}'"'"' | sort -u | paste -sd, -')"
    case "$pg_listeners" in
      *0.0.0.0:5432*|*\[::\]:5432*) write_row "$host" postgres_private_listener FAIL "$pg_listeners"; metric postgres_private_listener "host=\"$host\"" 0 ;;
      *100.87.125.126:5432*127.0.0.1:5432*|*127.0.0.1:5432*100.87.125.126:5432*) write_row "$host" postgres_private_listener PASS "$pg_listeners"; metric postgres_private_listener "host=\"$host\"" 1 ;;
      *) write_row "$host" postgres_private_listener WARN "${pg_listeners:-missing}"; metric postgres_private_listener "host=\"$host\"" 0 ;;
    esac
    clients="$(run_remote "$host" 'ss -tn state established "( sport = :5432 )" 2>/dev/null | awk '"'"'NR>1 {print $5}'"'"' | sed '"'"'s/:.*//'"'"' | sort -u | paste -sd, -')"
    write_row "$host" postgres_clients INFO "${clients:-none}"

    backup_df="$(run_remote "$host" 'df -P /srv/backup 2>&1')"
    backup_used="$(printf '%s\n' "$backup_df" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
    backup_device="$(printf '%s\n' "$backup_df" | awk 'NR==2 {print $1}')"
    backup_mount="$(printf '%s\n' "$backup_df" | awk 'NR==2 {print $6}')"
    if [[ "$backup_mount" = "/srv/backup" && "$backup_used" =~ ^[0-9]+$ ]]; then
      if [ "$backup_used" -ge 90 ]; then
        write_row "$host" srv_backup_used_percent CRITICAL "mount=/srv/backup used_percent=$backup_used warn=80 critical=90 device=${backup_device:-unknown}"
        metric filesystem_threshold_state "host=\"$host\",mount=\"/srv/backup\",warn=\"80\",critical=\"90\"" 2
      elif [ "$backup_used" -ge 80 ]; then
        write_row "$host" srv_backup_used_percent WARN "mount=/srv/backup used_percent=$backup_used warn=80 critical=90 device=${backup_device:-unknown}"
        metric filesystem_threshold_state "host=\"$host\",mount=\"/srv/backup\",warn=\"80\",critical=\"90\"" 1
      else
        write_row "$host" srv_backup_used_percent PASS "mount=/srv/backup used_percent=$backup_used warn=80 critical=90 device=${backup_device:-unknown}"
        metric filesystem_threshold_state "host=\"$host\",mount=\"/srv/backup\",warn=\"80\",critical=\"90\"" 0
      fi
      metric filesystem_used_percent "host=\"$host\",mount=\"/srv/backup\"" "$backup_used"
    else
      write_row "$host" srv_backup_used_percent FAIL "${backup_df:-df /srv/backup produced no output}"
      metric filesystem_used_percent "host=\"$host\",mount=\"/srv/backup\"" -1
      metric filesystem_threshold_state "host=\"$host\",mount=\"/srv/backup\",warn=\"80\",critical=\"90\"" 3
    fi
  fi

  remote_root_use="$(run_remote "$host" 'df -P / | awk '"'"'NR==2 {gsub(/%/,"",$5); print $5}'"'"'')"
  write_row "$host" root_fs_used_percent INFO "${remote_root_use:-unknown}"
  metric filesystem_used_percent "host=\"$host\",mount=\"/\"" "${remote_root_use:-0}"
done

if timeout 15s ssh -o BatchMode=yes -o ConnectTimeout=8 paperclipai 'hostname' >/dev/null 2>&1; then
  write_row paperclipai ssh_reachable PASS reachable
  metric ssh_reachable 'host="paperclipai"' 1
else
  write_row paperclipai ssh_reachable FAIL "blocked or unreachable"
  metric ssh_reachable 'host="paperclipai"' 0
fi

{
  printf '## Summary TSV\n\n```text\n'
  cat "$SUMMARY"
  printf '```\n\n## Prometheus Textfile Sample\n\n```text\n'
  cat "$PROM"
  printf '```\n'
} >> "$DETAIL"

ln -sfn "$SUMMARY" "$LATEST"
ln -sfn "$PROM" "$OUT_DIR/fleet-health-latest.prom"
ln -sfn "$DETAIL" "$OUT_DIR/fleet-health-latest.md"

cat "$SUMMARY"
