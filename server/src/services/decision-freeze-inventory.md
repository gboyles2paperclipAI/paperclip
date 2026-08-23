# Decision-freeze guard inventory (ADR-20260823 R2.4 / R2.13)

This file is the checked-in inventory the grep tests
`server/src/__tests__/wake-callsite-inventory.test.ts` and
`server/src/__tests__/done-write-inventory.test.ts` assert against. Every
`enqueueWakeup(` / `.wakeup(` call site under `server/src` (excluding tests and
the `enqueueWakeup` definition itself) must have exactly one classified row in
the wake table, and every `update(issues)` write that sets a terminal status
literal (`done`/`cancelled`) outside `issueService.update` must have exactly
one classified row in the done-write table. **Adding a new call site fails the
build until it is classified here.**

Identifiers are `wake:<file>#<n>` / `done:<file>#<n>` where `<n>` is the
1-based ordinal of the site within that file, in source order. Inserting a
site above existing ones renumbers the later sites — deliberately: a changed
file must be re-reviewed against this inventory.

## Wake-guard classifications

- `wake-guard` — the wake is issue-bound; `enqueueWakeup`'s decision-freeze
  membership check (PR-1, heartbeat.ts) skip-records it for frozen members.
- `mutation-gate` — the wake is agent-level (no issue id), so the wake router
  cannot gate it; frozen work is unreachable because the pick-work SQL
  exclusion (R3.4) hides members and the route mutation gate (R3.3) rejects
  any write the woken agent attempts against a member.
- `claim-recheck` — guarded by the in-transaction lease-membership re-check
  when `claimQueuedRun` stamps `issues.executionRunId` (R3.9).
- `recovery-durable-wait` — recovery/reconciler path; an active decision lease
  is a legitimate durable wait (`hasPersistedDurableWaitPath`), and the wake
  itself still passes through the `enqueueWakeup` membership check.
- `routine-suppression` — routine-dispatch path; a frozen target produces a
  suppressed run (`failureReason: "decision_freeze"`), never a wake (R2.14).
- `bypass-only` — sanctioned freeze-piercing wake carrying the server-internal
  `decisionFreezeBypass` option (outbox continuation / bounded revision wake).

## Wake call sites

| Site | Classification | Description |
| --- | --- | --- |
| `wake:routes/issues.ts#1` | wake-guard | resolved issue-thread-interaction continuation wake (`queueResolvedInteractionContinuationWakeup`) |
| `wake:routes/issues.ts#2` | wake-guard | recovery-action resolve route wakes the issue assignee |
| `wake:routes/issues.ts#3` | wake-guard | issue PATCH merged wake batch (status change, explicit reopen, blockers resolved, children completed, mentions) |
| `wake:routes/issues.ts#4` | wake-guard | issue checkout route wake to the checked-out agent |
| `wake:routes/issues.ts#5` | wake-guard | issue POST comments merged wake batch (comment, explicit reopen, mentions, blockers resolved, children completed) |
| `wake:routes/approvals.ts#1` | wake-guard | legacy non-lease approval approve wake to the requester (lease-bound approvals use the outbox instead) |
| `wake:routes/execution-workspaces.ts#1` | wake-guard | workspace restore wakes the restored source issue's assignee |
| `wake:routes/company-skills.ts#1` | wake-guard | skill-test harness issue wake |
| `wake:routes/agents.ts#1` | mutation-gate | manual agent wake endpoint (agent-level, no issue id) |
| `wake:routes/agents.ts#2` | mutation-gate | agent wake endpoint variant (agent-level, no issue id) |
| `wake:routes/issue-tree-control.ts#1` | wake-guard | tree-hold restore wake to the restored issue's assignee |
| `wake:services/productivity-review.ts#1` | wake-guard | productivity-review owner wake (issue-bound) |
| `wake:services/issue-assignment-wakeup.ts#1` | wake-guard | issue assignment wake to the new assignee |
| `wake:services/decision-leases.ts#1` | bypass-only | bounded revision wake (`decision:{leaseId}:revision:{eventId}`, revision bypass, anchor assignee only) |
| `wake:services/decision-leases.ts#2` | bypass-only | continuation outbox dispatch (`decision:{leaseId}:{disposition}`, continuation bypass, `revalidate: true`) |
| `wake:services/slack-integration.ts#1` | wake-guard | legacy non-lease Slack approval approve wake to the requester |
| `wake:services/heartbeat.ts#1` | wake-guard | issue-monitor recovery-issue wake (issue-bound) |
| `wake:services/heartbeat.ts#2` | wake-guard | issue-monitor recovery wake to the claimed issue's assignee |
| `wake:services/heartbeat.ts#3` | wake-guard | issue-monitor scheduled check wake (issue-bound) |
| `wake:services/heartbeat.ts#4` | wake-guard | stale in-review reviewer wake (issue-bound) |
| `wake:services/heartbeat.ts#5` | wake-guard | run-liveness continuation wake (issue context from the source run) |
| `wake:services/heartbeat.ts#6` | wake-guard | successful-run handoff wake (issue context from the source run) |
| `wake:services/heartbeat.ts#7` | mutation-gate | `heartbeatService.wake` facade (manual/on-demand agent-level wake) |
| `wake:services/heartbeat.ts#8` | mutation-gate | heartbeat timer scheduler wake (agent-level, no issue id) |
| `wake:services/task-watchdogs.ts#1` | wake-guard | task-watchdog evaluation wake (issue-bound payload) |
| `wake:services/plugin-host-services.ts#1` | wake-guard | plugin issue.requestWakeup (issue-bound) |
| `wake:services/plugin-host-services.ts#2` | wake-guard | plugin issue.requestWakeups batch (issue-bound) |
| `wake:services/plugin-host-services.ts#3` | mutation-gate | plugin agent invoke prompt wake (agent-level, no issue id) |
| `wake:services/plugin-host-services.ts#4` | mutation-gate | plugin session prompt wake (agent-level, no issue id) |
| `wake:services/recovery/service.ts#1` | recovery-durable-wait | recovery wake (stranded assigned issue) |
| `wake:services/recovery/service.ts#2` | recovery-durable-wait | recovery wake helper (owner re-dispatch) |
| `wake:services/recovery/service.ts#3` | recovery-durable-wait | recovery wake to the creator agent |
| `wake:services/recovery/service.ts#4` | recovery-durable-wait | recovery escalation owner wake |
| `wake:services/recovery/service.ts#5` | recovery-durable-wait | recovery owner wake (liveness reconciliation) |
| `wake:services/recovery/service.ts#6` | recovery-durable-wait | recovery-action owner wake |
| `wake:services/recovery/service.ts#7` | recovery-durable-wait | recovery owner-selection wake |
| `wake:services/recovery/service.ts#8` | recovery-durable-wait | recovery reconciler wake (issue graph liveness) |

Direct `heartbeat_runs` insert paths that bypass `enqueueWakeup`
(missing-comment retry, process-loss retry, max-turn continuation,
execution-review recovery, continuation/assignment recovery, deferred
promotion, no-issueId enqueue) are RED-file surfaces guarded in PR-1 via the
claim-time re-check (`claim-recheck`, R3.9) and the deferred-promotion /
retry-gate membership checks; they are not `enqueueWakeup(`/`.wakeup(` call
sites and so are outside this grep inventory's match set.

### Wake matcher scope and honest residual limits

The scanner matches `enqueueWakeup(` on ANY receiver, `.wakeup(` with optional
whitespace, bracket access (`["wakeup"](`), and bare destructured `wakeup(`
calls. Separately, it FAILS the build on aliasing shapes that would take
future calls out of its sight (`enqueueWakeup as x`, `{ wakeup: x } = …`,
`const x = heartbeat.wakeup`), so a rename cannot silently evade the
inventory — it trips the alias check instead.

What the grep still cannot see, honestly stated:

- a call whose name and `(` are split across lines (the per-line scan misses
  it; no such call style exists in this tree and review should reject one);
- an alias created through an intermediate object property and invoked under
  a different name (`deps.go = heartbeat.wakeup; deps.go(…)`) — the alias
  check catches the common assignment shapes, not every possible indirection;
- classification rows assert a site EXISTS and was reviewed, not that its
  guard behaves — behavioral proof lives in the freeze-guard and replay
  suites, not in this table.

## Done-write classifications

`issueService.update` (`server/src/services/issues.ts`) is the sanctioned
chokepoint for terminal status writes (R2.13). The FILE is scanned like every
other file (its own `.set(patch)` writes carry no terminal literal); the
scanner matches `update(issues)` AND every file-local `issues as <alias>`
import rename, with terminal literals in any quote style (`"done"`, `'done'`,
`` `done` ``).

### Done-write matcher residual limits, honestly stated

- a terminal status carried by an identifier or constant (`status: DONE`),
  assembled in a patch object built more than 600 characters before the
  `.set(...)`, or written through a raw `sql` template is outside this
  matcher's sight;
- classification rows assert a site exists and was reviewed, not that it is
  gated — `tree-control-cancel` and `pipeline-cancel` intentionally CAN write
  `cancelled` (contracts gate `done` only, R2.13); the behavioral guarantees
  live in issueService.update's gates and the replay suites.

- `tree-control-cancel` — `issue_tree_holds` cancel writes disposition
  `cancelled`; completion contracts gate `done` only (R2.13).
- `pipeline-cancel` — pipeline case cancel writes `cancelled` to linked
  execution issues; contracts gate `done` only (R2.13).

## Terminal `update(issues)` writes outside issueService.update

| Site | Classification | Description |
| --- | --- | --- |
| `done:services/issue-tree-control.ts#1` | tree-control-cancel | cancel-mode tree hold marks subtree issues `cancelled` |
| `done:services/pipelines.ts#1` | pipeline-cancel | pipeline case cancel marks linked execution issue `cancelled` |
