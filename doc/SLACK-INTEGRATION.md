# Slack Integration

Paperclip Slack messages are for operator action, not raw activity mirroring.

## Message policy

- Actionable messages start with `[ACTION REQUIRED]` and include `Action required: yes - ...`.
- Resolution/update messages use `[FYI - no action]` and include `Action required: no - ...`.
- Approval cards go to the approvals channel and include the expected owner, decision buttons, and next update.
- Blocked-agent and escalation alerts go to the alerts channel with owner, entity, evidence fields, and next update.
- Plain `issue.created` activity is not posted to Slack. Intake/ticket noise should be digested or handled by a separate exception-only workflow.

## Duplicate suppression

Repeated blocked-agent activity for the same company, issue, and blocker reason is suppressed for 30 minutes in the running server process. A changed blocker reason, a different issue, or the same reason after the window can post a fresh alert.
