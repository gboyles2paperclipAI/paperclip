---
title: local_implicit production inventory
summary: Durable inventory of every production TypeScript occurrence of local_implicit for authenticated/private cutover readiness
---

# `local_implicit` production inventory

This document inventories every **current production TypeScript** occurrence of the string `local_implicit`. It is an inventory for cutover readiness review, **not** authorization to widen source changes.

## Inventory method

```sh
# From repo root — production TS/TSX only (no tests, no generated/build trees)
rg -n "local_implicit" -g '*.ts' -g '*.tsx' \
  -g '!**/node_modules/**' -g '!**/dist/**' \
  -g '!**/*.test.ts' -g '!**/__tests__/**' \
  -g '!doc/**' -g '!docs/**'
```

**Excluded trees (by design):**

- `node_modules/`, `dist/`, `ui/dist/`, Vite caches
- `**/*.test.ts`, `**/__tests__/**` (test fixtures freely mint `local_implicit` actors)
- `doc/**`, `docs/**` (this file and other documentation)
- Runtime secret-bearing / data trees (`.env*`, `data/`, instance roots)
- Generated OpenAPI plan drafts under `doc/plans/` (not production runtime)

## Count summary (re-run at inventory time)

| Scope | File count | Notes |
|-------|------------|--------|
| **Server production TS** | **17** | Matches native Security review count of 17 |
| UI production TS/TSX | 2 | Board UI capability checks only |
| **Total production TS/TSX** | **19** | Server + UI |

**Count differences vs native 17:** Native review counted **server** production TypeScript only (17 files). This inventory also lists **2 UI** files that reference `local_implicit` for client-side capability gates. No server file was omitted or added relative to that 17-file set. String occurrence count inside those files is higher than 17 because several files contain multiple references (type unions, branches, comments).

**Change required column:** For this bounded remediation, **no** `local_implicit` site requires source change. Authenticated mode already refuses headerless `local_implicit` board identity at `actorMiddleware`; remaining references are either type unions, `local_trusted`-only legitimacy checks, or capability shortcuts that only fire when the actor source is already `local_implicit`.

## Server inventory (17 files)

| # | File | Purpose | Authenticated / private disposition | Boundary test / evidence | Change required? |
|---|------|---------|--------------------------------------|---------------------------|------------------|
| 1 | `server/src/middleware/auth.ts` | Sets `source: "local_implicit"` only when `deploymentMode === "local_trusted"`. Authenticated mode starts as `{ type: "none", source: "none" }` until session/bearer/cloud-tenant resolves. | **Fail-closed in authenticated:** no headerless board identity. | `server/src/__tests__/auth-session-route.test.ts` (actor `type: "none"`; production companies routes 403/401). | No |
| 2 | `server/src/middleware/board-mutation-guard.ts` | Treats `local_implicit` as a board mutation actor source for guard policy. | Only meaningful when actor is already `local_implicit` (local_trusted). Authenticated headerless actors are `none` and never reach board mutation as local board. | Board mutation guard + auth-session fail-closed tests. | No |
| 3 | `server/src/routes/access.ts` | `isLocalImplicit(req)` helper for instance-admin shortcuts on access/bootstrap surfaces. | Authenticated private bootstrap/claim requires session source, not local_implicit (`bootstrap-claim-routes`, board-claim session gate). | `server/src/__tests__/bootstrap-claim-routes.test.ts`; board-claim session requirement in `access.ts` claim route. | No |
| 4 | `server/src/routes/authz.ts` | Org access, instance-admin, company access, and `getActorInfo` source mapping treat `local_implicit` as full board/admin in local_trusted. | Authenticated actors without session never get `local_implicit`. `assertAuthenticated` / `assertBoard` fail closed for `type: "none"`. | `authz-company-access` tests; production companies route fail-closed test. | No |
| 5 | `server/src/routes/companies.ts` | List/stats unfiltered for `local_implicit` or instance admin; create company requires `local_implicit` or instance admin. | Authenticated headerless → `assertBoard` 403 before list/create. Instance-admin create still requires real session/board_key admin. | `auth-session-route` production companies routes test; `companies-route-cross-company-authz.test.ts`. | No |
| 6 | `server/src/routes/company-skills.ts` | Instance-admin / local_implicit bypass for skill admin paths. | Same as other admin gates: no local_implicit actor in authenticated without session. | `company-skills-routes.test.ts` (none actor denied). | No |
| 7 | `server/src/routes/environments.ts` | Admin bypass for environment config routes. | Fail-closed via actor middleware + assert paths. | Environment route authz coverage in focused suites. | No |
| 8 | `server/src/routes/instance-settings.ts` | Instance settings admin gate. | Authenticated requires real instance admin (session/board_key). | Instance settings route tests (where present). | No |
| 9 | `server/src/routes/issues.ts` | Admin bypass for some issue ops; **explicit deny** of `local_implicit` interaction resolution when `deploymentMode !== "local_trusted"`. | Authenticated: local_implicit interaction accept/reject returns 403. | `issue-thread-interaction-routes.test.ts` (local_implicit 403 in authenticated). | No |
| 10 | `server/src/routes/routines.ts` | Admin bypass for routine management. | No headerless local_implicit in authenticated. | Routine route authz patterns. | No |
| 11 | `server/src/routes/sidebar-badges.ts` | Treats local_implicit / instance admin as broad badge visibility. | Authenticated headerless never receives local_implicit source. | Sidebar badge route tests. | No |
| 12 | `server/src/routes/teams-catalog.ts` | Admin bypass for teams catalog. | Same disposition as other admin routes. | Teams catalog route tests. | No |
| 13 | `server/src/services/authorization.ts` | Actor source union includes `local_implicit`; permission evaluation grants local board full power when source matches. | Only when actor source is already set — not assigned in authenticated without credentials. | `authorization-service` tests. | No |
| 14 | `server/src/services/environment-config.ts` | Optional `actorSource` type union includes `local_implicit` for audit/context. | Type/metadata only; does not mint identity. | Environment config service typing. | No |
| 15 | `server/src/services/resource-memberships.ts` | local_implicit / instance admin bypass for membership management. | Requires actor already elevated. | Resource membership route/service tests. | No |
| 16 | `server/src/services/secrets.ts` | Actor source typing + audit source mapping for secret operations. | Does not assign local_implicit; maps when context already carries it. | `secrets-service.test.ts`. | No |
| 17 | `server/src/types/express.d.ts` | Express `req.actor.source` union includes `local_implicit`. | Type contract only. | Compile-time. | No |

## UI inventory (2 files; not in native 17)

| # | File | Purpose | Authenticated / private disposition | Boundary test / evidence | Change required? |
|---|------|---------|--------------------------------------|---------------------------|------------------|
| 18 | `ui/src/components/IssueRunLedger.tsx` | Client capability: treat local_implicit or instance admin as privileged for ledger actions. | UI mirror of board access payload from API; authenticated clients do not receive local_implicit board access from the server. | Board access / auth UI flows; server is authoritative. | No |
| 19 | `ui/src/pages/IssueDetail.tsx` | Same privileged capability gate on issue detail. | Same as above. | Same as above. | No |

## Related authenticated fail-closed evidence (not `local_implicit` string sites)

- **HTTP:** `actorMiddleware` + production `companyRoutes` — unauthenticated authenticated-mode requests denied (`auth-session-route.test.ts`).
- **WS:** live events refuse unauthenticated board upgrade in authenticated mode (`live-events-ws` tests).
- **Board claim:** session source required; durable single-winner DB predicate on local-board `instance_admin` row after `SELECT … FOR UPDATE` (`board-claim.ts`, `board-claim.test.ts`).
- **Deployment docs:** `docs/deploy/deployment-modes.md` states headerless API access is denied in authenticated+private (no `local_implicit` board identity).

## Re-inventory checklist

When adding a new production reference to `local_implicit`:

1. Re-run the inventory command above.
2. Update this table (file, purpose, disposition, evidence, change-required).
3. Prefer authenticated-mode explicit denies (as in `issues.ts` interaction resolution) over silent privilege.
4. Do **not** introduce a path that assigns `source: "local_implicit"` outside `deploymentMode === "local_trusted"`.
