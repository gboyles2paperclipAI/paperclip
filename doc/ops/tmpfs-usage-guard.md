# /tmp tmpfs Usage Guard

The `/tmp` pressure guard is `scripts/tmpfs-usage-guard.sh`.

Run it from the repository root every 15 minutes:

```sh
scripts/tmpfs-usage-guard.sh --apply --json
```

The guard trips when `/tmp` reaches either threshold:

- bytes used: `>= 75%`
- inodes used: `>= 80%`

When pressure is crossed, the script inventories only top-level `/tmp` path
metadata. It does not inspect file contents, and it skips secret-bearing path
names such as `.env*`, `.vercel`, and `.update-*`. JSON evidence redacts raw
entry paths and basenames, using per-run `tmp-entry-NNN` references plus
metadata such as type, owner uid, mode, mtime, size, and cleanup action.

With `--apply`, cleanup is intentionally narrow. The script removes only stale
directories that are:

- owned by the current user
- not symlinks
- under the same filesystem
- matching Paperclip/runtime transient naming patterns
- older than the stale cutoff
- not referenced by an active process via `/proc`

Use forced pressure only for dry-run validation:

```sh
scripts/tmpfs-usage-guard.sh --force-pressure --json
```

Do not schedule or run forced pressure with `--apply`; the script rejects that
combination.

## Scheduling

The approved cadence is no faster than every 15 minutes. A scheduler entry can
use either a Paperclip routine or a user-level host timer, but enabling that
entry is a runtime configuration change and should be applied through the
approved runtime-config path.

Cron expression:

```text
*/15 * * * *
```

Command:

```sh
cd /path/to/paperclip && scripts/tmpfs-usage-guard.sh --apply --json
```

The scheduler should capture the JSON output as redacted operational evidence
without printing file contents or secret-bearing environment values.
