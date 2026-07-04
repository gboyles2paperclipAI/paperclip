# Paperclip Dashboard and Backlog Wrapup - 2026-07-02T23:42:35Z

## Result

PARTIAL.

Runtime and dashboard usability are stabilized, local fixes are committed, and the live dashboard no longer loads the 14k historical issue set from `/FUL/inbox/all`. Remaining work is not a Paperclip runtime blocker: Stripe preview requires Grant's manual browser smoke test, production Stripe remains blocked by design, and OOM root cause remains unknown until a fatal report or direct repro exists.

## Runtime Posture

- `paperclip.service`: active/enabled.
- `paperclip-staging.service`: inactive/disabled.
- Listener: `127.0.0.1:3100` only.
- Health: `/api/health` returned `status=ok`, `version=0.3.1`, `deploymentMode=local_trusted`, `deploymentExposure=private`, `authReady=true`.
- Restart: one controlled systemd-managed reload was performed after interrupting the looping DevOps run, so the packaged shared validator patch would load. New process start: `2026-07-02T23:40:06.068Z`.
- Memory guardrails after reload: `MemoryHigh=10G`, `MemoryMax=12G`, `OOMPolicy=stop`, memory current about 888 MB and peak about 1.2 GB at validation.

## Changes

- Raised heartbeat concurrency caps to 6 in source and live packaged runtime.
- Fixed `/inbox/all` active issue loading to request only `backlog,todo,in_progress,in_review,blocked` instead of paging through all historical issues.
- Fixed `/inbox/all` status-filter usability: when issue filters are active under "All categories", unrelated approvals/alerts/failed runs are hidden so matching issue rows are visible.
- Added shared validator compatibility for legacy `request_confirmation` payloads from agent tools. The validator now fills `payload.version=1` and derives `payload.prompt` from title/summary when legacy callers omit those fields.
- Deployed rebuilt UI static assets to the packaged runtime.
- Patched packaged shared validator artifact in the runtime and restarted the service to load it.

## Files Changed

Committed source changes:

- `server/src/services/heartbeat.ts`
- `ui/src/pages/Inbox.tsx`
- `ui/src/pages/Inbox.test.tsx`
- `packages/shared/src/validators/issue.ts`
- `packages/shared/src/issue-thread-interactions.test.ts`

Live packaged runtime changes:

- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/server/dist/services/heartbeat.js`
- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/server/ui-dist`
- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/shared/dist/validators/issue.js`

Backups:

- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/server/dist/services/heartbeat.js.backup-concurrency-20260702T2324Z`
- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/server/ui-dist.backup-inbox-all-20260702T233441Z`
- `/home/paperclipadmin/.local/share/node/node-v22.22.3-linux-x64/lib/node_modules/@paperclipai/shared/dist/validators/issue.js.backup-request-confirmation-20260702T233930Z`

## Commits

- `5d93b2798 fix(heartbeat): raise local concurrency caps to six`
- `ba11bbd1a fix(ui): bound inbox all issue loading`
- `712baf1af fix(shared): accept legacy request confirmation payloads`
- Prior preserved fix still present: `26531429f fix(shared): remove duplicate AgentApiKeyScope exports`

No upstream GitHub write occurred.

## Validation

- `pnpm exec vitest run ui/src/pages/Inbox.test.tsx`: passed, 13 tests.
- `pnpm --filter @paperclipai/ui build`: passed. Existing CSS `::highlight` and chunk-size warnings only.
- `pnpm exec vitest run packages/shared/src/issue-thread-interactions.test.ts packages/shared/src/validators/issue.test.ts`: passed, 37 tests.
- `pnpm --filter @paperclipai/shared typecheck`: passed.
- `pnpm exec vitest run packages/shared/src/validators/issue.test.ts`: passed, 26 tests.
- Browser checks with system Chrome:
  - `/FUL/dashboard`: no failed responses, no console errors, no "failed to fetch".
  - `/FUL/inbox/all`: no failed responses, no console errors, no "failed to fetch".
  - `/FUL/issues`: no failed responses, no console errors.
  - `/FUL/routines`: no failed responses, no console errors.
  - `/FUL/projects`: no failed responses, no console errors.
  - `/FUL/agents`: no failed responses, no console errors.
- Inbox All live request evidence: issue requests are bounded to one active issue page with `status=backlog,todo,in_progress,in_review,blocked`; no 14k pagination.
- Inbox All filter evidence:
  - In Progress filter rendered 1 matching issue.
  - Backlog filter rendered 5 matching issues.
  - Blocked filter rendered 1 matching issue.
  - Approvals were hidden while issue status filters were active.
- Watchdog timers: `paperclip-platform-watchdog.timer` and `paperclip-watchdog.timer` active and scheduled every minute.
- Post-restart journal scan since `2026-07-02T23:40:06Z`: no fatal/OOM/validation-error/ZodError/error matches.

## Board State

Dashboard at validation:

- Tasks: `open=7`, `inProgress=1`, `blocked=1`, `done=12576`.
- Agents: `active=30`, `running=1`, `paused=0`, `error=0`.
- Pending approvals: `0`.

Active/open issues:

- `FUL-14806` - `in_review` / active DevOps run: Stripe sandbox/test keys in preview; waiting for manual checkout smoke test.
- `FUL-14003` - `blocked`: production Stripe live keys remain gated.
- `FUL-12735` - `backlog`: Provider Health Signal running log.
- `FUL-7043` - `backlog`: CSOT weekly config audit running log.
- `FUL-14703` - `backlog`: Daily operations summary running log.
- `FUL-3844` - `backlog`: Next 15 migration, documented as dormant/post-MVP.
- `FUL-14769` - `backlog`: Upload backend provider/config still requires approval.

## Stripe Preview

`FUL-14806` is in review. DevOps Lead posted evidence that Stripe preview env var names are present and preview deployment is ready. It asks Grant to manually smoke test checkout in preview without completing payment. Production Stripe live-key activation remains blocked on `FUL-14003`.

## OOM Status

No Node fatal report exists in `/var/lib/paperclip-node-diagnostics`, so OOM/leak classification remains `unknown/no report yet`. The leak is not declared fixed. Existing OOM evidence helper/runbook remains:

- `/home/paperclipadmin/paperclip-src/scripts/collect-paperclip-oom-evidence-20260702.sh`

## Remaining Risks

- `FUL-14806` still has one running DevOps Lead run. It is producing output and no longer generating validator errors.
- Stripe preview still requires Grant's manual checkout smoke test.
- Production Stripe remains intentionally blocked.
- OOM root cause remains pending a fatal report or direct repro.
- Pre-existing dirty files remain in the worktree and were not reverted.

## Exact Next Action

Grant should open the Vercel preview deployment, start a checkout flow, verify the Stripe checkout page/session loads with test keys and no auth errors, then record the result on `FUL-14806`. After that, DevOps Lead can close the preview task or document the exact failure.

## Rollback

- Source rollback: `git revert 5d93b2798 ba11bbd1a 712baf1af` on the local branch if any committed change regresses behavior.
- Runtime heartbeat rollback: restore the heartbeat backup file, then reload/restart during a safe window.
- Runtime UI rollback: replace `ui-dist` with the `ui-dist.backup-inbox-all-20260702T233441Z` directory.
- Runtime validator rollback: restore the validator backup file and restart during a safe window.
