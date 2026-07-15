#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION=""
OUTPUT=""
UPSTREAM_BASE=""
FORK_ANCHOR=""
BUILD_TIMESTAMP=""
BUILDER_ID=""
STAGE_ROOT=""
EXTRACT_ROOT=""
BACKUP_ROOT=""

usage() {
  printf '%s\n' \
    "Usage: $0 --version YYYY.MDD.P-help2day.N --output DIR \\" \
    "  --upstream-base SHA --fork-anchor SHA --build-timestamp ISO_UTC --builder-id ID" \
    "" \
    "Builds and retains source-release evidence only. It has no registry, GitHub, or runtime write path."
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|--output|--upstream-base|--fork-anchor|--build-timestamp|--builder-id)
      [[ $# -ge 2 ]] || fail "$1 requires a value"
      case "$1" in
        --version) VERSION="$2" ;;
        --output) OUTPUT="$2" ;;
        --upstream-base) UPSTREAM_BASE="$2" ;;
        --fork-anchor) FORK_ANCHOR="$2" ;;
        --build-timestamp) BUILD_TIMESTAMP="$2" ;;
        --builder-id) BUILDER_ID="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unexpected argument: $1" ;;
  esac
done

for value in VERSION OUTPUT UPSTREAM_BASE FORK_ANCHOR BUILD_TIMESTAMP BUILDER_ID; do
  [[ -n "${!value}" ]] || fail "missing required ${value,,}"
done

for command in git node pnpm npm jq sha256sum tar gitleaks osv-scanner grype; do
  command -v "$command" >/dev/null 2>&1 || fail "required tool is unavailable: $command"
done

[[ -x "$REPO_ROOT/node_modules/.bin/cyclonedx-npm" ]] || fail "pinned cyclonedx-npm is not installed"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || fail "source worktree must be clean"

SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
cd "$REPO_ROOT"
node --input-type=module - "$VERSION" "$SOURCE_COMMIT" "$UPSTREAM_BASE" "$FORK_ANCHOR" "$BUILD_TIMESTAMP" <<'NODE'
import {
  validateBuildTimestamp,
  validateFullCommit,
  validateHelp2dayVersion,
} from "./scripts/release-provenance.mjs";
const [version, source, upstream, fork, timestamp] = process.argv.slice(2);
validateHelp2dayVersion(version);
validateFullCommit(source, "source commit");
validateFullCommit(upstream, "upstream base");
validateFullCommit(fork, "fork anchor");
validateBuildTimestamp(timestamp);
NODE

git -C "$REPO_ROOT" merge-base --is-ancestor "$UPSTREAM_BASE" "$SOURCE_COMMIT" \
  || fail "upstream base is not an ancestor of source commit"
git -C "$REPO_ROOT" merge-base --is-ancestor "$FORK_ANCHOR" "$SOURCE_COMMIT" \
  || fail "fork anchor is not an ancestor of source commit"

OUTPUT="$(realpath -m "$OUTPUT")"
case "$OUTPUT/" in
  "$REPO_ROOT/"*) fail "evidence output must be outside the source worktree" ;;
esac
[[ ! -e "$OUTPUT" ]] || fail "evidence output already exists"
mkdir -m 700 "$OUTPUT"
touch "$OUTPUT/.paperclip-release-evidence"
mkdir -p "$OUTPUT/packages" "$OUTPUT/package-inventory" "$OUTPUT/security-results" \
  "$OUTPUT/test-results" "$OUTPUT/runtime-proof" "$OUTPUT/work"

restore_sources() {
  if [[ -n "$BACKUP_ROOT" && -d "$BACKUP_ROOT" ]]; then
    while IFS=$'\t' read -r pkg_dir _name _version; do
      [[ -n "$pkg_dir" ]] || continue
      cp -p "$BACKUP_ROOT/$pkg_dir/package.json" "$REPO_ROOT/$pkg_dir/package.json"
    done < "$BACKUP_ROOT/release-packages.tsv"
    cp -p "$BACKUP_ROOT/cli-src-index.ts" "$REPO_ROOT/cli/src/index.ts"
  fi
  if [[ -f "$REPO_ROOT/cli/package.dev.json" ]]; then
    mv "$REPO_ROOT/cli/package.dev.json" "$REPO_ROOT/cli/package.json"
  fi
  if [[ -f "$BACKUP_ROOT/cli-README.md" ]]; then
    cp -p "$BACKUP_ROOT/cli-README.md" "$REPO_ROOT/cli/README.md"
  else
    rm -f "$REPO_ROOT/cli/README.md"
  fi
}

cleanup() {
  restore_sources
  if [[ -n "$STAGE_ROOT" && -d "$STAGE_ROOT" ]]; then
    node --input-type=module - "$STAGE_ROOT" <<'NODE' || true
import { cleanupReleaseStageRoot } from "./scripts/stage-release-packages.mjs";
cleanupReleaseStageRoot(process.argv[2]);
NODE
  fi
  [[ -z "$EXTRACT_ROOT" || ! -d "$EXTRACT_ROOT" ]] || rm -rf "$EXTRACT_ROOT"
  [[ -z "$BACKUP_ROOT" || ! -d "$BACKUP_ROOT" ]] || rm -rf "$BACKUP_ROOT"
}
trap cleanup EXIT

run_logged() {
  local label="$1"
  shift
  "$@" > >(tee "$OUTPUT/test-results/${label}.log") 2>&1
}

BACKUP_ROOT="$(mktemp -d "$OUTPUT/work/source-backup.XXXXXX")"
node "$REPO_ROOT/scripts/release-package-map.mjs" list > "$BACKUP_ROOT/release-packages.tsv"
while IFS=$'\t' read -r pkg_dir _name _version; do
  [[ -n "$pkg_dir" ]] || continue
  mkdir -p "$BACKUP_ROOT/$pkg_dir"
  cp -p "$REPO_ROOT/$pkg_dir/package.json" "$BACKUP_ROOT/$pkg_dir/package.json"
done < "$BACKUP_ROOT/release-packages.tsv"
cp -p "$REPO_ROOT/cli/src/index.ts" "$BACKUP_ROOT/cli-src-index.ts"
if [[ -f "$REPO_ROOT/cli/README.md" ]]; then
  cp -p "$REPO_ROOT/cli/README.md" "$BACKUP_ROOT/cli-README.md"
fi

cd "$REPO_ROOT"
run_logged typecheck pnpm -r typecheck
run_logged tests pnpm test:run
run_logged standalone-tests node scripts/test-standalone-public-packages.mjs
run_logged workspace-build pnpm build
run_logged standalone-build node scripts/build-standalone-public-packages.mjs
run_logged prepare-server-ui bash scripts/prepare-server-ui-dist.sh
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -R "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
run_logged package-integrity bash scripts/verify-package-integrity.sh server/dist
run_logged packed-server-integrity bash scripts/verify-packed-server-integrity.sh

node scripts/release-package-map.mjs set-version "$VERSION"
run_logged cli-build bash scripts/build-npm.sh --skip-typecheck

STAGE_ROOT="$(node --input-type=module - "$OUTPUT/work" <<'NODE'
import { createReleaseStageRoot } from "./scripts/stage-release-packages.mjs";
process.stdout.write(createReleaseStageRoot(process.argv[2]));
NODE
)"
node scripts/stage-release-packages.mjs stage "$STAGE_ROOT" > "$OUTPUT/work/staged-packages.tsv"

: > "$OUTPUT/package-inventory/artifacts.tsv"
while IFS=$'\t' read -r pkg_dir pkg_name pkg_version tarball_path tarball_sha256; do
  [[ -n "$pkg_dir" ]] || continue
  destination="$OUTPUT/packages/$(basename "$tarball_path")"
  cp -p "$tarball_path" "$destination"
  [[ "$(sha256sum "$destination" | awk '{print $1}')" == "$tarball_sha256" ]] \
    || fail "copied artifact hash drifted"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$pkg_dir" "$pkg_name" "$pkg_version" "$destination" "$tarball_sha256" \
    >> "$OUTPUT/package-inventory/artifacts.tsv"
done < "$OUTPUT/work/staged-packages.tsv"

EXPECTED_COUNT="$(node scripts/release-package-map.mjs list | awk 'NF { count += 1 } END { print count + 0 }')"
ACTUAL_COUNT="$(awk 'NF { count += 1 } END { print count + 0 }' "$OUTPUT/package-inventory/artifacts.tsv")"
[[ "$ACTUAL_COUNT" -eq "$EXPECTED_COUNT" ]] || fail "artifact count does not match release map"

AUDIT_ROOT="$OUTPUT/work/production-graph"
mkdir -p "$AUDIT_ROOT"
node --input-type=module - "$OUTPUT/package-inventory/artifacts.tsv" "$AUDIT_ROOT/package.json" "$VERSION" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [indexPath, outputPath, version] = process.argv.slice(2);
const dependencies = {};
for (const line of readFileSync(indexPath, "utf8").trim().split(/\r?\n/)) {
  const [, name, artifactVersion, path] = line.split("\t");
  if (artifactVersion !== version || dependencies[name]) throw new Error("invalid artifact graph input");
  dependencies[name] = pathToFileURL(path).href;
}
writeFileSync(outputPath, `${JSON.stringify({ name: "paperclip-help2day-release-graph", version, private: true, dependencies }, null, 2)}\n`);
NODE

run_logged production-lock npm install --prefix "$AUDIT_ROOT" --package-lock-only --ignore-scripts \
  --no-audit --no-fund --omit=dev --legacy-peer-deps
cp -p "$AUDIT_ROOT/package-lock.json" "$OUTPUT/package-inventory/package-lock.json"
cp -p "$REPO_ROOT/pnpm-lock.yaml" "$OUTPUT/package-inventory/pnpm-lock.yaml"
mkdir -p "$OUTPUT/package-inventory/source-lockfiles"
SOURCE_LOCKFILES=(
  pnpm-lock.yaml
  packages/plugins/sandbox-providers/cloudflare/pnpm-lock.yaml
  packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml
  packages/plugins/sandbox-providers/e2b/pnpm-lock.yaml
  packages/plugins/sandbox-providers/exe-dev/pnpm-lock.yaml
  packages/plugins/sandbox-providers/kubernetes/pnpm-lock.yaml
  packages/plugins/sandbox-providers/modal/pnpm-lock.yaml
  packages/plugins/sandbox-providers/novita/pnpm-lock.yaml
)
for lockfile in "${SOURCE_LOCKFILES[@]}"; do
  [[ -f "$REPO_ROOT/$lockfile" ]] || fail "required source lockfile is missing: $lockfile"
  mkdir -p "$OUTPUT/package-inventory/source-lockfiles/$(dirname "$lockfile")"
  cp -p "$REPO_ROOT/$lockfile" "$OUTPUT/package-inventory/source-lockfiles/$lockfile"
done
(
  cd "$OUTPUT/package-inventory/source-lockfiles"
  sha256sum "${SOURCE_LOCKFILES[@]}" > ../source-lockfiles.sha256
)
cp -p "$REPO_ROOT/scripts/release-package-manifest.json" \
  "$OUTPUT/package-inventory/release-package-manifest.json"

run_logged production-install npm ci --prefix "$AUDIT_ROOT" --ignore-scripts \
  --no-audit --no-fund --omit=dev --legacy-peer-deps
node scripts/verify-installed-release-packages.mjs \
  "$OUTPUT/package-inventory/artifacts.tsv" "$AUDIT_ROOT" \
  "$OUTPUT/package-inventory/installed-packages.json"

"$REPO_ROOT/node_modules/.bin/cyclonedx-npm" \
  --package-lock-only --omit dev --output-reproducible --spec-version 1.6 \
  --output-format JSON --validate --output-file "$OUTPUT/sbom.cdx.json" \
  "$AUDIT_ROOT/package.json" \
  > "$OUTPUT/test-results/sbom.log" 2>&1

set +e
npm audit --prefix "$AUDIT_ROOT" --package-lock-only --ignore-scripts --omit=dev --json \
  > "$OUTPUT/security-results/npm-audit.json" \
  2> "$OUTPUT/security-results/npm-audit.stderr.log"
printf '%s\n' "$?" > "$OUTPUT/security-results/npm-audit.exit"
osv-scanner scan --format json --sbom "$OUTPUT/sbom.cdx.json" \
  > "$OUTPUT/security-results/osv.json" \
  2> "$OUTPUT/security-results/osv.stderr.log"
printf '%s\n' "$?" > "$OUTPUT/security-results/osv.exit"
grype "sbom:$OUTPUT/sbom.cdx.json" -o json \
  > "$OUTPUT/security-results/grype.json" \
  2> "$OUTPUT/security-results/grype.stderr.log"
printf '%s\n' "$?" > "$OUTPUT/security-results/grype.exit"
set -e

EXTRACT_ROOT="$(mktemp -d "$OUTPUT/work/package-content.XXXXXX")"
while IFS=$'\t' read -r _pkg_dir _pkg_name _pkg_version tarball_path _sha; do
  destination="$EXTRACT_ROOT/$(basename "$tarball_path" .tgz)"
  mkdir "$destination"
  tar -xzf "$tarball_path" -C "$destination"
done < "$OUTPUT/package-inventory/artifacts.tsv"

set +e
gitleaks detect --source "$REPO_ROOT" --log-opts="$FORK_ANCHOR..$SOURCE_COMMIT" \
  --redact --no-banner --report-format json \
  --report-path "$OUTPUT/security-results/source-range-gitleaks.json" \
  > "$OUTPUT/security-results/source-range-gitleaks.log" 2>&1
printf '%s\n' "$?" > "$OUTPUT/security-results/source-range-gitleaks.exit"
gitleaks detect --no-git --source "$EXTRACT_ROOT" --redact --no-banner \
  --report-format json --report-path "$OUTPUT/security-results/package-gitleaks.json" \
  > "$OUTPUT/security-results/package-gitleaks.log" 2>&1
printf '%s\n' "$?" > "$OUTPUT/security-results/package-gitleaks.exit"
set -e

node scripts/release-provenance.mjs \
  --version "$VERSION" \
  --source-commit "$SOURCE_COMMIT" \
  --upstream-base "$UPSTREAM_BASE" \
  --fork-anchor "$FORK_ANCHOR" \
  --build-timestamp "$BUILD_TIMESTAMP" \
  --builder-id "$BUILDER_ID" \
  --lockfile "$OUTPUT/package-inventory/package-lock.json" \
  --source-lockfiles "$OUTPUT/package-inventory/source-lockfiles.sha256" \
  --release-map "$OUTPUT/package-inventory/release-package-manifest.json" \
  --sbom "$OUTPUT/sbom.cdx.json" \
  --artifact-index "$OUTPUT/package-inventory/artifacts.tsv" \
  --installed-packages "$OUTPUT/package-inventory/installed-packages.json" \
  --output "$OUTPUT/release-manifest.json"

security_status=0
node scripts/verify-release-security-results.mjs \
  --npm-audit "$OUTPUT/security-results/npm-audit.json" \
  --osv "$OUTPUT/security-results/osv.json" \
  --grype "$OUTPUT/security-results/grype.json" \
  --output "$OUTPUT/security-results/summary.json" \
  || security_status=$?

source_scan_status="$(cat "$OUTPUT/security-results/source-range-gitleaks.exit")"
package_scan_status="$(cat "$OUTPUT/security-results/package-gitleaks.exit")"

restore_sources
rm -rf "$BACKUP_ROOT"
BACKUP_ROOT=""
node --input-type=module - "$STAGE_ROOT" <<'NODE'
import { cleanupReleaseStageRoot } from "./scripts/stage-release-packages.mjs";
cleanupReleaseStageRoot(process.argv[2]);
NODE
STAGE_ROOT=""
rm -rf "$EXTRACT_ROOT"
EXTRACT_ROOT=""
rm -rf "$OUTPUT/work"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || fail "evidence build did not restore a clean source tree"

node --input-type=module - "$OUTPUT" "$SOURCE_COMMIT" "$VERSION" "$ACTUAL_COUNT" \
  "$security_status" "$source_scan_status" "$package_scan_status" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, source, version, count, security, sourceScan, packageScan] = process.argv.slice(2);
const scanner = JSON.parse(readFileSync(join(root, "security-results/summary.json"), "utf8"));
const status = security === "0" && sourceScan === "0" && packageScan === "0" ? "PASS" : "BLOCKED";
writeFileSync(join(root, "release-report.md"), [
  "# Help2day Paperclip source-release evidence",
  "",
  `- Status: ${status}`,
  `- Source commit: \`${source}\``,
  `- Governed version: \`${version}\``,
  `- Immutable packages: ${count}`,
  `- Dependency security: ${scanner.status}`,
  `- Source-range gitleaks exit: ${sourceScan}`,
  `- Package-content gitleaks exit: ${packageScan}`,
  "- Runtime activation: not performed",
  "",
].join("\n"));
NODE

(
  cd "$OUTPUT"
  find . -type f ! -name checksums.sha256 -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum > checksums.sha256
)

[[ "$security_status" -eq 0 ]] || fail "dependency security policy failed; retained evidence at $OUTPUT"
[[ "$source_scan_status" -eq 0 ]] || fail "source-range secret scan requires review; retained evidence at $OUTPUT"
[[ "$package_scan_status" -eq 0 ]] || fail "package-content secret scan requires review; retained evidence at $OUTPUT"

printf 'Release evidence PASS: %s\n' "$OUTPUT"
