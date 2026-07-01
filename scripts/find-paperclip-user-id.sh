#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ROOT="${PAPERCLIP_INSTANCE_ROOT:-${HOME}/.paperclip/instances/default}"
CONFIG_PATH="${PAPERCLIP_CONFIG_PATH:-${INSTANCE_ROOT}/config.json}"
ENV_PATH="${PAPERCLIP_ENV_PATH:-${INSTANCE_ROOT}/.env}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is not installed or not on PATH" >&2
  exit 1
fi

CONNECTION_STRING="$(
  CONFIG_PATH="$CONFIG_PATH" ENV_PATH="$ENV_PATH" node <<'NODE'
const fs = require("node:fs");

function fromConfig(path) {
  try {
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const candidates = [
      config?.database?.connectionString,
      config?.db?.connectionString,
      config?.connectionString,
    ];
    return candidates.find((value) => typeof value === "string" && value.trim());
  } catch {
    return null;
  }
}

function fromEnv(path) {
  try {
    const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (!match) continue;
      return match[1].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    return null;
  }
  return null;
}

const value = fromConfig(process.env.CONFIG_PATH) ?? fromEnv(process.env.ENV_PATH);
if (value) process.stdout.write(value);
NODE
)"

QUERY='select
  cm.principal_id,
  coalesce(cm.membership_role, '"'"''"'"') as membership_role,
  cm.status,
  coalesce(u.email, '"'"''"'"') as email,
  coalesce(u.name, '"'"''"'"') as name
from company_memberships cm
left join "user" u on u.id = cm.principal_id
where cm.principal_type = '"'"'user'"'"'
order by
  case when cm.status = '"'"'active'"'"' then 0 else 1 end,
  case when cm.membership_role in ('"'"'owner'"'"', '"'"'admin'"'"') then 0 else 1 end,
  cm.created_at desc;'

echo "Paperclip board user candidates:"
echo

if [[ -n "$CONNECTION_STRING" ]]; then
  psql "$CONNECTION_STRING" -P pager=off -c "$QUERY"
  exit 0
fi

HOST="${PAPERCLIP_DB_HOST:-127.0.0.1}"
PORT="${PAPERCLIP_DB_PORT:-54329}"
DB="${PAPERCLIP_DB_NAME:-paperclipdb1}"
USER_NAME="${PAPERCLIP_DB_USER:-${USER:-paperclipadmin}}"

psql -h "$HOST" -p "$PORT" -U "$USER_NAME" -d "$DB" -P pager=off -c "$QUERY"
