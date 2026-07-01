#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../server"
pnpm exec tsx scripts/slack-smoke-test.ts
