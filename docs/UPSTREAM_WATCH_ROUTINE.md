# Paperclip Upstream Watch & Patch Management Routine

## 1. Introduction

This document outlines the "Upstream Watch & Patch Management" routine for the Paperclip runtime. The primary purpose of this routine is to regularly monitor key external dependencies (Node.js, pnpm, npm packages, and specific patched dependencies) for new releases, potential updates, and to highlight any local patch considerations.

This routine is essential for maintaining the security, stability, and up-to-dateness of the Paperclip platform by providing early visibility into available upstream changes.

## 2. Scope

The routine performs the following actions:

*   **Upstream Watch:**
    *   Monitors for new major, minor, and patch releases of direct `devDependencies` specified in `package.json` (e.g., `@playwright/test`, `typescript`, `vitest`, `esbuild`, `cross-env`).
    *   Monitors for new releases of the specified Node.js engine (version `>=20`).
    *   Monitors for new releases of `pnpm` (version `9.15.4`).
    *   Monitors for new releases of `rollup` (specified in `pnpm.overrides`).
    *   For `embedded-postgres` (a `pnpm.patchedDependencies` entry), it provides a reminder for manual review of its upstream source, as direct programmatic version checking is not implemented.

*   **Patch Management (Reporting):**
    *   Generates a report that indicates:
        *   Dependency name
        *   Current version (as per `package.json`)
        *   Latest upstream version
        *   Status (`up-to-date`, `new-patch-available`, `new-minor-available`, `new-major-available`, `patched-dependency-update`, `error`)
        *   Relevant release notes links (if available).
    *   Specifically flags `embedded-postgres` for manual review due to its patched nature, ensuring compatibility with new upstream versions is considered.

## 3. Architecture

The routine is implemented as a single TypeScript script: `scripts/upstream-watcher.ts`.

*   **`upstream-watcher.ts`:**
    *   Reads `package.json` to identify monitored dependencies.
    *   Utilizes `npm view` commands and direct API calls (e.g., Node.js releases API) to fetch the latest upstream versions.
    *   Compares current versions with latest upstream versions.
    *   Generates a detailed report in both JSON (to `stdout`) and Markdown (`UPSTREAM_REPORT.md` in the project root).

## 4. Execution Mechanism

The `upstream-watcher.ts` script is designed to be executed periodically via a `cron` job.

### Package.json Script

A convenience script has been added to the main `package.json` to easily invoke the watcher:

```json
"scripts": {
  // ... other scripts
  "watch:upstream": "./node_modules/.pnpm/node_modules/.bin/tsx scripts/upstream-watcher.ts"
}
```

This script can be run manually using `pnpm run watch:upstream` from the `paperclip-source` directory.

### Cron Job Setup (Infrastructure Responsibility)

The following `cron` job should be configured on the Paperclip runtime server. The recommended frequency is daily.

**Example Cron Entry (daily at 03:00 AM UTC):**

```cron
0 3 * * * cd /home/paperclipadmin/.paperclip/instances/default/workspaces/9c332d6d-e0d7-4478-9b73-ab102da0ea21/runtime-tools/paperclip-source && pnpm run watch:upstream > /var/log/paperclip-upstream-watch.log 2>&1
```

*   **`/home/paperclipadmin/.paperclip/instances/default/workspaces/9c332d6d-e0d7-4478-9b73-ab102da0ea21/runtime-tools/paperclip-source`**: This is the absolute path to the `paperclip-source` project directory. Ensure this path is correct on the server.
*   **`pnpm run watch:upstream`**: Executes the watcher script.
*   **`> /var/log/paperclip-upstream-watch.log 2>&1`**: Redirects both standard output (JSON report) and standard error to a log file for review. The Markdown report (`UPSTREAM_REPORT.md`) will also be updated in the project root.

## 5. Maintenance and Troubleshooting

*   **Reviewing Reports:** Regularly review the `UPSTREAM_REPORT.md` file in the project root and the `/var/log/paperclip-upstream-watch.log` for new dependency versions or errors.
*   **Updating Monitored Dependencies:** If new dependencies need to be monitored, or if existing ones need custom handling, modify the `scripts/upstream-watcher.ts` script.
*   **Patch Management for `embedded-postgres`:** For new versions of `embedded-postgres`, manually check its upstream repository (e.g., `https://github.com/vaxilu/embedded-postgres`) for changes and assess compatibility with existing local patches. Update the `pnpm.patchedDependencies` entry and the patch file as necessary.
*   **Script Errors:** If the `cron` job fails or reports errors, inspect `/var/log/paperclip-upstream-watch.log` for details. Common issues include network problems, `npm` registry access issues, or syntax errors in the script (which should be caught during development/testing).

## 6. Future Enhancements

*   **Automated Patching:** Implement logic to automatically apply non-breaking patch updates.
*   **Notification System:** Integrate with notification services (e.g., Slack, email) to proactively alert relevant teams about new updates or critical security vulnerabilities.
*   **Vulnerability Scanning:** Incorporate tools for scanning dependencies for known security vulnerabilities.
*   **Configurability:** Externalize the list of monitored dependencies into a separate configuration file (e.g., `upstream-config.json`) for easier management without code changes.

This documentation should be maintained alongside the `upstream-watcher.ts` script.
