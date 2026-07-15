# Publishing to npm

Low-level reference for how Paperclip packages are prepared and published to npm.

For the maintainer workflow, use [doc/RELEASING.md](RELEASING.md). This document focuses on packaging internals.

## Current Release Entry Points

Use these scripts:

- [`scripts/release.sh`](../scripts/release.sh) for canary and stable publish flows
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) after pushing a stable tag
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) to repoint `latest`
- [`scripts/build-npm.sh`](../scripts/build-npm.sh) for the CLI packaging build

Paperclip no longer uses release branches or Changesets for publishing.

The company-governed Help2day path has an additional evidence-only entry point:

- [`scripts/build-help2day-release-evidence.sh`](../scripts/build-help2day-release-evidence.sh)
  builds and retains exact source-release evidence but has no registry, GitHub,
  install, migration, restart, or deployment write path

Its corresponding manual workflow is
[`help2day-source-release-evidence.yml`](../.github/workflows/help2day-source-release-evidence.yml).
It is not a publication workflow.

## Why the CLI needs special packaging

The CLI package, `paperclipai`, imports code from workspace packages such as:

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- adapter packages under `packages/adapters/`

Those workspace references are valid in development but not in a publishable npm package. The release flow rewrites versions temporarily, then builds a publishable CLI bundle.

## `build-npm.sh`

Run:

```bash
./scripts/build-npm.sh
```

This script:

1. runs `pnpm -r typecheck`
2. bundles the CLI entrypoint with esbuild into `cli/dist/index.js`
3. verifies the bundled entrypoint with `node --check`
4. rewrites `cli/package.json` into a publishable npm manifest and stores the dev copy as `cli/package.dev.json`
5. copies the repo `README.md` into `cli/README.md` for npm metadata
6. derives a preview CLI file manifest from `npm pack --dry-run --json --ignore-scripts` and scans every listed file for forbidden tokens unless `--skip-checks` is supplied

After the release script exits, the dev manifest and temporary files are restored automatically.
The canonical [`scripts/release.sh`](../scripts/release.sh) path does not pass
`--skip-checks`.

## Package discovery and versioning

Public packages are discovered from:

- `packages/`
- `server/`
- `ui/`
- `cli/`

The version rewrite step now uses [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs), which:

- finds all public packages
- sorts them topologically by internal dependencies
- rewrites each package version to the target release version
- rewrites internal `workspace:*` dependency references to the exact target version
- updates the CLI's displayed version string

Those rewrites are temporary. The working tree is restored after publish or dry-run.

After all workspace artifacts are built, versions are rewritten, and the CLI's
publish manifest is assembled, the canonical release flow runs each enabled
package's real `prepack`/`postpack` lifecycle once and writes the result into a
unique, trap-cleaned staging directory. It validates and scans the entries and
contents of every exact `.tgz`, verifies its embedded package name and version,
records its SHA-256 digest, and makes the tarball read-only. Staging must finish
for every package with `publishFromCi: true` before the first preview or real
publish command.

Both preview and real publish consume those already-scanned tarball paths with
`--ignore-scripts`; lifecycle scripts are not rerun. The helper verifies the
tarball digest immediately before each publish attempt (including the bounded
canary provenance retry), so changed bytes fail closed. The exit trap removes
only the marked staging root, on success or failure. The current manifest
contains 30 release-enabled packages, including the CLI and 29 non-CLI
packages; future enabled packages enter the same ordered boundary automatically.

Release staging also verifies every concrete `main`, `module`, `types`, `bin`,
and `exports` target inside each exact tarball. A missing standalone build or
entrypoint therefore fails before a package can cross the immutable staging
boundary.

## Help2day evidence bundle

The governed evidence command requires a clean exact source commit and emits:

- `release-manifest.json` binding the distribution version, full source commit,
  frozen upstream base, fork anchor, builder identity, UTC build timestamp,
  production lock hash, complete source-lock inventory hash, release-map hash,
  SBOM hash, installed-package proof hash, and every tarball hash
- `checksums.sha256` over the retained evidence files
- `sbom.cdx.json`, generated reproducibly from the lifecycle-disabled production
  graph resolved from the exact staged tarballs
- `security-results/` containing npm, OSV-Scanner, Grype, source-range gitleaks,
  package-content gitleaks, and a normalized fail-closed result
- `package-inventory/` containing all root and standalone lockfiles, their
  checksums, exact artifacts, and verification of every installed manifest and
  concrete entrypoint
- `test-results/`, `runtime-proof/`, and `release-report.md`

An unavailable or malformed scanner result is an error. npm and Grype must have
no high or critical production findings, and OSV findings require explicit
disposition before the evidence gate passes. Secret scanning uses the exact
source range and exact extracted package contents. No broad suppression is part
of this workflow.

On the shared Help2day host, serialize the complete command through the host
heavy-validation wrapper. For example:

```bash
/home/paperclipadmin/ai-collab/scripts/run-host-heavy-gate.sh \
  ./scripts/build-help2day-release-evidence.sh \
  --version 2026.715.0-help2day.1 \
  --output /home/paperclipadmin/ai-collab/backups/paperclip-release-<UTC> \
  --upstream-base <full-upstream-sha> \
  --fork-anchor <full-fork-sha> \
  --build-timestamp <canonical-utc-timestamp> \
  --builder-id <reviewable-builder-identity>
```

The output directory must be outside the source worktree and must not already
exist. The command restores temporary version rewrites and fails if the source
tree is not clean afterward.

Forbidden-token policy uses optional stable, explicit entries from the local
Git common directory's `hooks/forbidden-tokens.txt` (one per line, `#` comments
allowed) plus bounded current-account host paths such as `/home/<account>/` and
`/Users/<account>/`. Bare `USER`, `LOGNAME`, `USERNAME`, or OS account names are
never treated as substring tokens, so ordinary words such as `runner` do not
block CI. Release staging refuses to proceed if the effective policy is empty.

The required `help2day/main` pull-request workflow runs the complete release
registry and immutable-package regression suite, including lifecycle rewrite,
tarball identity/order/cleanup/no-rerun, runner-name, fatal-grep, and canonical
release bypass guards.

## `@paperclipai/ui` packaging

The UI package publishes prebuilt static assets, not the source workspace.

The `ui` package uses [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs) during `prepack` to swap in a lean publish manifest that:

- keeps the release-managed `name` and `version`
- publishes only `dist/`
- omits the source-only dependency graph from downstream installs

After packing or publishing, `postpack` restores the development manifest automatically.

### Manual first publish for `@paperclipai/ui`

If you need to publish only the UI package once by hand, use the real package name:

- `@paperclipai/ui`

Recommended flow from the repo root:

```bash
# optional sanity check: this 404s until the first publish exists
npm view @paperclipai/ui version

# make sure the dist payload is fresh
pnpm --filter @paperclipai/ui build

# confirm your local npm auth before the real publish
npm whoami

# safe staged-tarball preview
pnpm run release:bootstrap-package -- @paperclipai/ui

# one-time real publish of the same lifecycle-produced tarball boundary
pnpm run release:bootstrap-package -- @paperclipai/ui --publish --otp 123456
```

Notes:

- Run the bootstrap helper from the repo root.
- The helper runs `prepack`/`postpack` once to create and scan a temporary immutable tarball, then previews and publishes that exact tarball with lifecycle scripts disabled.
- If `npm view @paperclipai/ui version` already returns the same version that is in [`ui/package.json`](../ui/package.json), do not republish. Bump the version or use the normal repo-wide release flow in [`scripts/release.sh`](../scripts/release.sh).

If the first real publish returns npm `E404`, check npm-side prerequisites before retrying:

- `npm whoami` must succeed first. An expired or missing npm login will block the publish.
- For an organization-scoped package like `@paperclipai/ui`, the `paperclipai` npm organization must exist and the publisher must be a member with permission to publish to that scope.
- The initial publish must include `--access public` for a public scoped package.
- npm also requires either account 2FA for publishing or a granular token that is allowed to bypass 2FA.

## Version formats

Paperclip uses calendar versions:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- stable: `2026.318.0`
- canary: `2026.318.1-canary.2`

## Publish model

### Canary

Canaries publish under the npm dist-tag `canary`.

Example:

- `paperclipai@2026.318.1-canary.2`

This keeps the default install path unchanged while allowing explicit installs with:

```bash
npx paperclipai@canary onboard
```

The release script now verifies two things after a canary publish:

- the `canary` dist-tag resolves to the version that was just published
- every published internal `@paperclipai/*` dependency referenced by that manifest exists on npm

It also treats `latest -> canary` as a failure by default, because npm metadata can otherwise leave the default install path pointing at an unreleased canary dependency graph. Only pass `./scripts/release.sh canary --allow-canary-latest` when that `latest` behavior is explicitly intended.

### Stable

Stable publishes use the npm dist-tag `latest`.

Example:

- `paperclipai@2026.318.0`

Stable publishes do not create a release commit. Instead:

- package versions are rewritten temporarily
- packages are published from the chosen source commit
- git tag `vYYYY.MDD.P` points at that original commit

## Trusted publishing

The intended CI model is npm trusted publishing through GitHub OIDC.

That means:

- no long-lived `NPM_TOKEN` in repository secrets
- GitHub Actions obtains short-lived publish credentials
- trusted publisher rules are configured per workflow file

See [doc/RELEASE-AUTOMATION-SETUP.md](RELEASE-AUTOMATION-SETUP.md) for the GitHub/npm setup steps.

## Release enrollment for new public packages

Paperclip does not auto-publish every non-private workspace package anymore.
CI publishing is controlled by [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json).

When you add a new public package:

1. add it to the manifest and decide whether CI should publish it immediately
2. if CI should publish it, bootstrap the package on npm before merge
3. if CI should not publish it yet, keep `"publishFromCi": false`
4. only enable `"publishFromCi": true` after npm trusted publishing is configured for that package

PR CI now checks changed release-enabled package manifests against npm. That catches a missing first-publish bootstrap before the change reaches `master`.

### One-time bootstrap sequence for a new package

The first publish of a brand-new package still needs one human maintainer with npm write access.
After that, trusted publishing can take over.

Example for a newly added public package from the repo root:

```bash
# safe preview
pnpm run release:bootstrap-package -- @paperclipai/new-package

# one-time first publish from an authenticated maintainer machine
pnpm run release:bootstrap-package -- @paperclipai/new-package --publish --otp 123456
```

The helper script:

- checks that the package does not already exist on npm
- builds the target package unless `--skip-build` is passed
- runs the package lifecycle once, scans and hashes the exact staged tarball, then previews it with `pnpm publish <tarball> --dry-run --ignore-scripts --no-git-checks --access public`
- only publishes the same hash-verified tarball with `pnpm publish <tarball> --ignore-scripts --no-git-checks --access public` when `--publish --otp <code>` is provided

The helper intentionally uses `pnpm pack` for lifecycle/workspace normalization,
then sends the already-scanned tarball through pnpm's registry publication path.

For the real `--publish` step, the maintainer machine must already be authenticated to npm.
If `npm whoami` returns `401`, first run `npm logout --registry=https://registry.npmjs.org/` to clear any stale local auth, then run `npm login` or `npm adduser` locally as an npm org member, and finally rerun the helper.
That local human auth is fine for the one-time bootstrap publish; we just do not want the same auth model inside CI.
The helper now requires `--otp <code>` up front for `--publish`, so it fails before the real publish attempt if the one-time password is missing.

After that first publish succeeds:

1. open `https://www.npmjs.com/package/@paperclipai/new-package`
2. go to `Settings` → `Trusted publishing`
3. add repository `paperclipai/paperclip`
4. set workflow filename to `release.yml`
5. optionally go to `Settings` → `Publishing access` and enable `Require two-factor authentication and disallow tokens`
6. keep `publishFromCi: true` in [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json)

Once those steps are done, future canary and stable publishes for that package are automated through GitHub OIDC. The manual step is only the first package creation on npm.

## Rollback model

Rollback does not unpublish anything.

It repoints the `latest` dist-tag to a prior stable version:

```bash
./scripts/rollback-latest.sh 2026.318.0
```

This is the fastest way to restore the default install path if a stable release is bad.

## Related Files

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)
