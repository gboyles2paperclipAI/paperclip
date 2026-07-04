# Paperclip Runtime and Agent Operations

This host runs the Help2day Paperclip control plane as a private local service.

## Runtime Invariants

- `paperclip.service` must be active and enabled.
- `paperclip-staging.service` must stay inactive and disabled unless Grant explicitly approves a local-only staging test.
- The only Paperclip listener should be `127.0.0.1:3100`.
- `/api/health` should return `status=ok`, `version=0.3.1`, `deploymentMode=local_trusted`, and `deploymentExposure=private`.
- Do not print full process environments or raw service environment values. Use targeted checks only.

## Agent Operational Smoke

Use the no-wake smoke test to confirm every configured agent is addressable and operational without creating a heartbeat storm:

```bash
node scripts/check-paperclip-agents-operational.mjs
```

The script:

- checks the dashboard, agent list, per-agent detail route, and live-run route;
- verifies each active agent is not paused, error, or terminated;
- verifies local adapter working directories exist;
- records active-run progress when a run is already live;
- writes sanitized JSON and text reports under `final/agent-operational/`;
- does not wake, resume, create, or interrupt agents.

Treat any `fail` result as a blocker before starting new work. `warn` means the agent is reachable but has a non-critical configuration gap, such as a missing optional instructions file.

## Stripe Preview Gate

Stripe work should proceed in preview before production.

Production Stripe live keys stay blocked until all of the following are true:

- preview environment has test/sandbox Stripe variables configured;
- preview deployment is ready;
- Grant manually confirms the checkout flow creates a Stripe test checkout/session without auth errors;
- the result is recorded on `FUL-14806`;
- any preview-only fixes are committed and pushed to the Grant fork branch intended for promotion.

After preview passes, promote the same reviewed code/config path to production. Do not add or print live Stripe secrets in Paperclip comments, logs, reports, or git history.

## OOM Capture

OOM/leak status remains evidence-based. Do not declare the leak fixed unless a Node fatal report or direct repro identifies the root cause and a verified code fix is applied.

Use:

```bash
scripts/collect-paperclip-oom-evidence-20260702.sh
```

The helper writes safe evidence under `final/oom-evidence/` and avoids dumping secret-bearing environment sections.
