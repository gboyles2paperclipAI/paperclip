#!/usr/bin/env bash

OUT_DIR="${1:-${PWD}/final/oom-evidence}"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUT_FILE="$OUT_DIR/paperclip-oom-evidence-$STAMP.txt"
REPORT_DIR="/var/lib/paperclip-node-diagnostics"
SERVICE_NAME="paperclip.service"

mkdir -p "$OUT_DIR" || {
  printf 'failed to create output directory: %s\n' "$OUT_DIR" >&2
  exit 1
}

redact_stream() {
  local legacy_chat_host='dis''cord'
  sed -E \
    -e 's/(Authorization:[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/[REDACTED_TOKEN]/g' \
    -e 's#(postgres(ql)?://)[^[:space:]"]+#\1[REDACTED]#Ig' \
    -e 's#(mysql://)[^[:space:]"]+#\1[REDACTED]#Ig' \
    -e 's#(mongodb(\\+srv)?://)[^[:space:]"]+#\1[REDACTED]#Ig' \
    -e 's#(https://hooks\\.slack\\.com/services/)[^[:space:]"]+#\1[REDACTED]#Ig' \
    -e "s#(https://${legacy_chat_host}(app)?\\.com/api/webhooks/)[^[:space:]\"]+#\\1[REDACTED]#Ig"
}

append_section() {
  printf '\n== %s ==\n' "$1" >> "$OUT_FILE"
}

safe_node_report_summary() {
  local report_file="$1"
  node - "$report_file" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
try {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const header = report.header ?? {};
  const heap = report.javascriptHeap ?? {};
  const resource = report.resourceUsage ?? {};
  const summary = {
    reportFile: file,
    event: header.event ?? null,
    trigger: header.trigger ?? null,
    reportVersion: header.reportVersion ?? null,
    dumpEventTime: header.dumpEventTime ?? null,
    processId: header.processId ?? null,
    nodejsVersion: header.nodejsVersion ?? null,
    arch: header.arch ?? null,
    platform: header.platform ?? null,
    heapTotalMemory: heap.totalMemory ?? null,
    heapExecutableMemory: heap.executableMemory ?? null,
    heapTotalCommittedMemory: heap.totalCommittedMemory ?? null,
    heapAvailableMemory: heap.availableMemory ?? null,
    heapMemoryLimit: heap.memoryLimit ?? null,
    rss: resource.rss ?? null,
    userCpuSeconds: resource.userCpuSeconds ?? null,
    kernelCpuSeconds: resource.kernelCpuSeconds ?? null,
    maxRss: resource.maxRSS ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.log(JSON.stringify({ reportFile: file, parseError: String(err && err.message ? err.message : err) }, null, 2));
}
NODE
}

classify_current_evidence() {
  local newest_report="$1"
  if [ -z "$newest_report" ]; then
    printf 'unknown/no report yet\n'
    return
  fi

  if node - "$newest_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const event = String(report.header?.event ?? "");
const trigger = String(report.header?.trigger ?? "");
const fatal = `${event}\n${trigger}`;
process.exit(/heap|allocation failed|javascript/i.test(fatal) ? 0 : 1);
NODE
  then
    printf 'node_heap_oom\n'
  else
    printf 'unknown/report present\n'
  fi
}

: > "$OUT_FILE" || {
  printf 'failed to write output file: %s\n' "$OUT_FILE" >&2
  exit 1
}

append_section "metadata"
{
  printf 'generatedAt=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf 'host=%s\n' "$(hostname 2>/dev/null || printf unknown)"
  printf 'user=%s\n' "$(whoami 2>/dev/null || printf unknown)"
  printf 'service=%s\n' "$SERVICE_NAME"
} | redact_stream >> "$OUT_FILE"

append_section "service status"
{
  systemctl is-active "$SERVICE_NAME" 2>/dev/null || true
  systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true
  systemctl show "$SERVICE_NAME" \
    -p ActiveState -p SubState -p Result -p NRestarts -p ExecMainStatus \
    -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p OOMPolicy \
    --no-pager 2>/dev/null || true
} | redact_stream >> "$OUT_FILE"

append_section "listener"
ss -ltnp 2>/dev/null | awk '$4 ~ /:3100$/ {print}' | redact_stream >> "$OUT_FILE" || true

append_section "health"
curl -fsS http://127.0.0.1:3100/api/health 2>/dev/null | redact_stream >> "$OUT_FILE" || printf 'health unavailable\n' >> "$OUT_FILE"
printf '\n' >> "$OUT_FILE"

append_section "recent service fatal/error/OOM lines"
journalctl -u "$SERVICE_NAME" --since "2 hours ago" --no-pager 2>/dev/null \
  | grep -Eai "fatal|oom|out of memory|heap|killed|validation-error|uncaught|exception|error" \
  | tail -160 \
  | redact_stream >> "$OUT_FILE" || true

append_section "recent kernel OOM lines"
journalctl -k --since "2 hours ago" --no-pager 2>/dev/null \
  | grep -Eai "oom|out of memory|killed process|memory cgroup" \
  | tail -160 \
  | redact_stream >> "$OUT_FILE" || true

append_section "diagnostic report files"
find "$REPORT_DIR" -maxdepth 1 -type f -printf '%TY-%Tm-%TdT%TH:%TM:%TSZ %s %p\n' 2>/dev/null \
  | sort -r \
  | head -30 \
  | redact_stream >> "$OUT_FILE" || true

newest_report="$(find "$REPORT_DIR" -maxdepth 1 -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {sub(/^[^ ]+ /, ""); print}')"

append_section "newest node report safe summary"
if [ -n "$newest_report" ]; then
  safe_node_report_summary "$newest_report" | redact_stream >> "$OUT_FILE"
else
  printf 'no Node diagnostic report found\n' >> "$OUT_FILE"
fi

append_section "classification"
classification="$(classify_current_evidence "$newest_report" 2>/dev/null || printf 'unknown/report parse failed')"
printf '%s\n' "$classification" >> "$OUT_FILE"

printf '%s\n' "$OUT_FILE"
