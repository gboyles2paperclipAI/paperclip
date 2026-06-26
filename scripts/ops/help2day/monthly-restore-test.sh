#!/usr/bin/env bash
set -u

EVIDENCE="${EVIDENCE:-/home/paperclipadmin/fleet-finalization-20260625T175457Z}"
OUT_DIR="$EVIDENCE/restore-tests"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULT="$OUT_DIR/monthly-restore-test-$STAMP.tsv"
DETAIL="$OUT_DIR/monthly-restore-test-$STAMP.md"

mkdir -p "$OUT_DIR"
: > "$RESULT"
printf 'scope\tcheck\tstatus\tevidence\n' >> "$RESULT"

row() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULT"
}

latest_archive="$(ls -1t /backups/fleet-finalization-*/paperclip01-app-state-*.tar.zst 2>/dev/null | head -1)"
if [ -z "$latest_archive" ]; then
  row paperclip01 archive_present FAIL "no /backups/fleet-finalization-* archive"
else
  row paperclip01 archive_present PASS "$latest_archive"
  archive_size="$(stat -c '%s' "$latest_archive" 2>/dev/null || printf '0')"
  if [ "${archive_size:-0}" -gt 0 ]; then
    row paperclip01 archive_nonempty PASS "size_bytes=$archive_size"
  else
    row paperclip01 archive_nonempty FAIL "size_bytes=$archive_size"
  fi

  restore_root="$OUT_DIR/sample-$STAMP"
  rm -rf "$restore_root"
  mkdir -p "$restore_root"
  if tar -I zstd -xf "$latest_archive" -C "$restore_root" \
    home/paperclipadmin/paperclip-src/package.json \
    home/paperclipadmin/paperclip-src/skills/paperclip/SKILL.md \
    home/paperclipadmin/fleet-finalization-20260625T175457Z/00-repatriation-verification.md \
    > "$OUT_DIR/monthly-restore-test-$STAMP.extract.log" 2>&1; then
    row paperclip01 representative_extract PASS "$restore_root"
  else
    row paperclip01 representative_extract FAIL "$OUT_DIR/monthly-restore-test-$STAMP.extract.log"
  fi

  [ -s "$restore_root/home/paperclipadmin/paperclip-src/package.json" ] \
    && row paperclip01 restored_package_json PASS present \
    || row paperclip01 restored_package_json FAIL missing
  [ -s "$restore_root/home/paperclipadmin/paperclip-src/skills/paperclip/SKILL.md" ] \
    && row paperclip01 restored_skill PASS present \
    || row paperclip01 restored_skill FAIL missing
  [ -s "$restore_root/home/paperclipadmin/fleet-finalization-20260625T175457Z/00-repatriation-verification.md" ] \
    && row paperclip01 restored_evidence PASS present \
    || row paperclip01 restored_evidence FAIL missing
fi

row paperclipdb1 pitr_restore NOT_RUN "requires privileged pgBackRest/WAL setup"
row paperclipai ollama_config_restore NOT_RUN "SSH access blocked"
row paperclipapi gateway_config_restore NOT_RUN "cleanup/gateway install not complete"

{
  printf '# Monthly Restore Test\n\nCollected UTC: `%s`\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '```text\n'
  cat "$RESULT"
  printf '```\n'
} > "$DETAIL"

ln -sfn "$RESULT" "$OUT_DIR/monthly-restore-test-latest.tsv"
ln -sfn "$DETAIL" "$OUT_DIR/monthly-restore-test-latest.md"

cat "$RESULT"
