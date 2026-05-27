#!/usr/bin/env bash
# FUL-3960 / FUL-3981 performance fix + request-volume monitor deploy script
# SAFE VERSION: syncs full dist/ closure; validates imports before restart;
# hard-fails unless all 4 post-restart conditions pass.
#
# Run with: sudo bash /home/paperclipadmin/paperclip-src/deploy-perf-fix.sh

set -euo pipefail

SRC=/home/paperclipadmin/paperclip-src
DEST=/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server
PORT=3100

BACKUP_TAG=$(date +%Y%m%d%H%M%S)
BACKUP_DIR="${DEST}/dist.bak-${BACKUP_TAG}"

# ── Step 1: Backup entire dist ──────────────────────────────────────────────
echo "[1/6] Backing up ${DEST}/dist → ${BACKUP_DIR} ..."
cp -r "${DEST}/dist" "${BACKUP_DIR}"
echo "  Backup created: ${BACKUP_DIR}"

# ── Step 2: Sync full dist closure ──────────────────────────────────────────
echo "[2/6] Syncing full server/dist/ closure (rsync) ..."
rsync -a --checksum \
  "${SRC}/server/dist/" "${DEST}/dist/"
echo "  Sync complete. Files in dest: $(find "${DEST}/dist" -name '*.js' | wc -l)"

# ── Step 3: Import-resolution preflight ─────────────────────────────────────
echo "[3/6] Import-resolution preflight ..."

PREFLIGHT_SCRIPT=$(cat <<'JSEOF'
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

const TARGET = process.argv[2];
const errors = [];
const visited = new Set();

function checkFile(filePath) {
  if (visited.has(filePath)) return;
  visited.add(filePath);
  if (!existsSync(filePath)) {
    errors.push(`MISSING: ${filePath}`);
    return;
  }
  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { return; }
  const dir = dirname(filePath);
  // Static import/export from './relative.js'
  const re = /(?:^|\n)\s*(?:import|export)\s.*?\bfrom\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const dep = resolve(dir, m[1]);
    if (dep.startsWith(TARGET) && dep.endsWith('.js')) {
      checkFile(dep);
    }
  }
}

checkFile(resolve(TARGET, 'app.js'));
checkFile(resolve(TARGET, 'routes/health.js'));
checkFile(resolve(TARGET, 'middleware/request-volume-monitor.js'));

if (errors.length > 0) {
  console.error('Preflight FAILED — missing imports:');
  errors.forEach(e => console.error('  ' + e));
  process.exit(1);
}
console.log(`Preflight OK — ${visited.size} files checked, 0 missing.`);
JSEOF
)

PREFLIGHT_TMP=$(mktemp --suffix=.mjs)
printf '%s' "$PREFLIGHT_SCRIPT" > "$PREFLIGHT_TMP"
if ! node "$PREFLIGHT_TMP" "${DEST}/dist" 2>&1; then
  rm -f "$PREFLIGHT_TMP"
  echo "  Preflight failed — restoring backup ..."
  rsync -a "${BACKUP_DIR}/" "${DEST}/dist/"
  echo "  Rollback complete. Service not restarted."
  exit 1
fi
rm -f "$PREFLIGHT_TMP"

# ── Step 4: Install UI assets ────────────────────────────────────────────────
echo "[4/6] Syncing UI assets ..."
rsync -a --delete "${SRC}/ui/dist/" "${DEST}/ui-dist/"
echo "  UI sync complete."

# ── Step 5: Restart service ──────────────────────────────────────────────────
echo "[5/6] Restarting paperclip.service ..."
systemctl restart paperclip.service
echo -n "  Waiting for startup "
for i in $(seq 1 15); do
  sleep 1
  printf "."
  if systemctl is-active paperclip.service --quiet 2>/dev/null; then break; fi
done
echo ""

# ── Step 6: 4-condition health verification ──────────────────────────────────
echo "[6/6] Post-restart verification ..."
FAIL=0

# Condition 1: service active
if systemctl is-active paperclip.service --quiet; then
  echo "  ✓ paperclip.service is active"
else
  echo "  ✗ FAIL: paperclip.service is not active"
  systemctl status paperclip.service --no-pager --lines=20 || true
  FAIL=1
fi

# Condition 2: port listening
if lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "  ✓ port ${PORT} is listening"
else
  echo "  ✗ FAIL: port ${PORT} not listening"
  FAIL=1
fi

# Condition 3: /api/health returns HTTP 200 JSON
HEALTH_CODE=$(curl -sf -o /tmp/deploy-health.json -w "%{http_code}" \
  "http://localhost:${PORT}/api/health" 2>/dev/null || echo "000")
if [ "${HEALTH_CODE}" = "200" ] && python3 -m json.tool /tmp/deploy-health.json > /dev/null 2>&1; then
  echo "  ✓ /api/health → HTTP 200 JSON"
  python3 -m json.tool /tmp/deploy-health.json | grep -E '"status"|"version"' | head -3 | sed 's/^/    /'
else
  echo "  ✗ FAIL: /api/health returned HTTP ${HEALTH_CODE} or non-JSON"
  cat /tmp/deploy-health.json 2>/dev/null || true
  FAIL=1
fi

# Condition 4: /api/health/load returns HTTP 200 JSON
LOAD_CODE=$(curl -sf -o /tmp/deploy-load.json -w "%{http_code}" \
  "http://localhost:${PORT}/api/health/load" 2>/dev/null || echo "000")
if [ "${LOAD_CODE}" = "200" ] && python3 -m json.tool /tmp/deploy-load.json > /dev/null 2>&1; then
  echo "  ✓ /api/health/load → HTTP 200 JSON"
  python3 -m json.tool /tmp/deploy-load.json | head -6 | sed 's/^/    /'
else
  echo "  ✗ FAIL: /api/health/load returned HTTP ${LOAD_CODE} or non-JSON"
  cat /tmp/deploy-load.json 2>/dev/null || true
  FAIL=1
fi

if [ "${FAIL}" -ne 0 ]; then
  echo ""
  echo "Deploy FAILED — one or more post-restart conditions were not met."
  echo "To rollback: sudo rsync -a '${BACKUP_DIR}/' '${DEST}/dist/' && sudo systemctl restart paperclip.service"
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo "Backup retained at: ${BACKUP_DIR}"
echo "Run 'curl -sf http://localhost:${PORT}/api/health/load | python3 -m json.tool' to inspect live counters."
