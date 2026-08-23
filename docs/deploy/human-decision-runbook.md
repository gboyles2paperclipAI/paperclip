# Human decision runbook

Operator-facing guide to the quiescent human-decision system
(ADR-20260823-quiescent-coordination): what happens when an agent asks you for
a decision, what your approve/reject does, and how approved actions are
executed.

## What a decision request looks like

When an agent needs a human decision it creates an **approval** bound to a
**decision lease**. In one server transaction the anchor issue moves to
`in_review` with an evidence comment, and the issue plus its whole dependency
cone (children and transitively blocked issues) is **frozen**: agent writes are
rejected with `422 decision_freeze_active`, frozen issues disappear from every
agent work-picking surface, queued wakeups for them are drained, and active
runs on them are interrupted. You are notified through the normal approval
channels (dashboard, Slack card).

## The quiet-wait guarantee

While the decision is pending, nothing moves underneath it:

- No new runs start on any frozen issue; no child issues sprout from comment
  storms; repeated request replays cannot create duplicate approvals (decision
  idempotency keys make equivalent creates no-ops).
- Comments you post while deciding are recorded but wake nothing.
- Routines whose target sits inside the frozen cone produce quietly skipped
  runs, not failures.

There is no penalty for deciding slowly. The system waits quietly, however
long you take.

## Approve / reject / request revision

- **Approve** resolves the lease, releases the cone, and delivers exactly one
  continuation wake to the requesting agent with `revalidate: true` (the agent
  must re-verify state before acting on the outcome). Delivery is via a
  durable outbox: a crash between your click and the wake is retried until
  delivered exactly once.
- **Reject** does the same with disposition `rejected` — the requester is
  woken to stand down, not left hanging.
- **Request revision** does NOT release the cone. The owner gets one bounded
  revision wake, may edit its plan/resubmit, and everything else stays frozen
  until you decide.

Resume is **automatic**: you never need to nudge an agent after deciding; the
continuation outbox wakes it (and a background sweep redelivers if the first
attempt fails).

## Emergency release

If a cone is wedged (e.g. the decision row was deleted or you simply need the
work unfrozen NOW):

```
POST /api/decision-leases/{leaseId}/release
```

Board-authenticated, always one call, never consults the freeze gate. It
resolves the lease as `operator_override`, releases every member, and wakes
the owner. `GET /api/companies/{companyId}/decision-leases` lists leases and
their states.

Kill switch: starting the server with `PAPERCLIP_DECISION_FREEZE_DISABLED=1`
refuses to boot while leases are active unless
`PAPERCLIP_DECISION_FREEZE_DISABLED_RESOLVE_ALL=1` is also set, in which case
every active lease is resolved as `operator_override` (loud, logged) — the
switch resolves, it never abandons frozen work.

## The broker execution model (approved actions)

For the two governed host mutations — **activate_runtime_candidate** and
**quarantine_exact_file** — the agent that requested the decision does NOT
perform the mutation. The flow is:

1. The request rides the approval with exact content hashes (candidate
   tarball/prefix hashes and expected version for an activation; exact source
   path, content hash, and target path for a quarantine) plus a pre-declared
   inverse rollback operation. Nothing is enqueued while you decide.
2. On your **approve**, the server enqueues one `broker_operations` row and
   attaches a completion contract to every issue linked to the approval.
3. The **host broker** (a board-authenticated local process — agents cannot
   claim) claims the operation with a generation-fenced claim, re-verifies the
   recorded hashes immediately before execution (any mismatch → the same
   decision comes back to you for revision, never a silent variant), executes,
   and submits a receipt.
4. The receipt is validated against the contract's exact preimage — exact
   file, exact hashes, unrelated-file count unchanged — and forwarded to the
   linked issues. Only then can those issues go `done`. On failure the broker
   records preflight/rollback evidence; a rolled-back operation stays loudly
   nonterminal until the decision is revised.
5. The requesting agent is woken with instructions to **verify only** — the
   continuation payload states the broker executes.

What this means for you: approving one of these items authorizes exactly the
hashed artifact you saw at request time, nothing else, and the Slack/dashboard
card is a summary — the executed payload is always the server-side approval
row.
