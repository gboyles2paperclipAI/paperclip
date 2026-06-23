# Paperclip runtime roles

Paperclip runtime hosts can declare exactly one role:

- `primary`
- `api-only`
- `scheduler-only`
- `staged`

Default application behavior remains `primary` when `PAPERCLIP_RUNTIME_ROLE` is unset, so existing local and production installs keep their current behavior. Production-like hosts should set the role explicitly and run preflight before traffic is routed.

## Roles

`primary` is the full runtime. It can serve API/UI, run heartbeat and routine scheduling, run startup recovery, start plugin jobs and plugin workers, auto-install bundled plugins, run startup reconciliation/backfills, flush feedback exports, schedule database backups, and apply migrations according to existing migration env flags.

`api-only` serves API/UI without work-producing background systems. It disables heartbeat scheduling, routine scheduling, startup recovery, startup reconciliation, plugin job scheduling, plugin workers, bundled plugin auto-install, feedback export flushing, scheduled database backups, and migration apply.

`staged` is the safest secondary-host validation mode. It has the same background disablement as `api-only` and rejects mutating HTTP methods with `runtime_role_staged_read_only`.

`scheduler-only` is reserved for a future split-host topology. In this branch it parses and reports as a valid role, but work-producing systems remain disabled because plugin workers can apply plugin-owned database migrations during activation and need a broader split-runtime design before they are safe on a secondary host.

## Secondary host example

For a staged secondary host:

```sh
PAPERCLIP_RUNTIME_ROLE=staged
HOST=127.0.0.1
PORT=3100
PAPERCLIP_MIGRATION_PROMPT=never
PAPERCLIP_MIGRATION_AUTO_APPLY=false
PAPERCLIP_DB_BACKUP_ENABLED=false
PAPERCLIP_OPEN_ON_LISTEN=false
```

The staged host must stay out of public routing until cutover is approved.

## Health contract

`GET /api/health` includes:

- `runtime.runtimeRole`
- `runtime.heartbeatSchedulerEnabled`
- `runtime.routineSchedulerEnabled`
- `runtime.pluginSchedulerEnabled`
- `runtime.pluginWorkersEnabled`
- `runtime.pluginAutoInstallEnabled`
- `runtime.databaseBackupSchedulerEnabled`
- `runtime.startupRecoveryEnabled`
- `runtime.startupReconciliationEnabled`
- `runtime.migrationMode`

These fields contain no secrets or raw env values.

## Preflight

Run preflight after the service is listening and before routing traffic:

```sh
PAPERCLIP_RUNTIME_ROLE=staged \
  scripts/ops/paperclip-runtime-role-preflight.sh \
  --url http://127.0.0.1:3100 \
  --production-db-host 100.87.125.126
```

For `api-only` and `staged`, preflight fails if any scheduler, plugin worker, plugin auto-install, startup recovery/reconciliation, backup scheduler, or migration apply path is enabled.

Do not run two `primary` hosts against the same production database.
