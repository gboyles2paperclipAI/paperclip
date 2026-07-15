# Upstream divergence register

This register records intentional Help2day differences from public Paperclip. It is a review aid, not release approval. Every entry must stay tied to an owning issue and exact commits. Update it during each upstream reconciliation and retire entries when the divergence disappears.

| Area | Reason | Requirement | Owner issue | Relevant commits | Expected conflict area | Classification | Retirement condition |
|---|---|---|---|---|---|---|---|
| Release identity and evidence | Public upstream version metadata does not identify Help2day-governed bytes or bind exact artifacts to source evidence. | Security and release governance | AIC-132, AIC-134 | `2ab9e4694`, `64948026d`, `71ad4cdfe`, `343721777` | package manifests, lockfiles, release scripts, workflows | Help2day-specific | Upstream provides an equivalent immutable provenance, exact-artifact audit, SBOM, and installed-entrypoint contract accepted by Help2day governance. |
| Cursor SDK dependency | The previously resolved Cursor SDK transport chain included a vulnerable dependency. | Security | AIC-133 | `2248cb3a6` | Cursor adapter package metadata and lockfile | Security-required | A later supported upstream Cursor SDK line is independently verified to retain an equal or better dependency posture and is adopted upstream. |
| Premium run admission | Global premium concurrency admission must be atomic across service instances. | Cost and execution safety | AIC-130 | `ad6aabba2` | heartbeat run claiming and PostgreSQL transaction logic | Upstreamable | Equivalent atomic admission ships upstream and reconciliation proves semantic parity. |
| Execution workspace ownership and cancellation | A task must not inherit another issue's isolated workspace, and cancellation must terminate verified descendants before terminal settlement. | Workspace integrity and execution safety | AIC-085, AIC-089, AIC-093, AIC-094 | `ea535a632` | heartbeat dispatch, execution workspace reuse, local process supervision | Upstreamable | Upstream enforces issue-bound workspace ownership and identity-safe process-tree termination with equivalent adversarial tests. |
| Help2day operational governance | Source publication and production runtime activation require separate approvals and evidence. | Company governance | AIC-114, AIC-132 | Pending final reconciliation commit | release documentation, CODEOWNERS, workflows | Help2day-specific | No retirement planned unless the company governance model changes through an approved RED decision. |

## Update contract

For every reconciliation:

1. Compare this register with the exact upstream range and candidate range.
2. Replace abbreviated commit references with the final governed commit set in the release evidence.
3. Add newly discovered divergences before source approval.
4. Mark an entry retired only when the replacement is present, tested, and linked to review evidence.
5. Do not use this file to waive a security, publication, or runtime gate.
