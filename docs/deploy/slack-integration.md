---
title: Slack Integration
summary: Configure Slack notifications and approval actions
---

Paperclip can post operational notifications to Slack and let board operators resolve approval requests from Slack buttons. Slack is only the human interface. Paperclip remains the source of truth for approvals, audit logs, and agent wakeups.

## What Slack Receives

Slack notifications are sent for:

- ticket creation
- blocked-agent alerts
- escalation alerts
- approval requests

Approval request messages include `Approve`, `Reject`, `Needs changes`, and `Open in Paperclip` actions. Button payloads contain only the approval identifier and requested action.

Slack messages must not include raw screenshots, uploaded images, passwords, MFA codes, recovery keys, payment card data, API tokens, or other credential-shaped values. Paperclip redacts and filters these fields before posting.

## Required Slack App Settings

Use Socket Mode when Paperclip is not publicly reachable. Socket Mode lets Paperclip receive Slack interactions over an outbound websocket, so no public inbound URL is required.

Create or update a Slack app with:

- Socket Mode enabled
- Interactivity enabled
- bot token scopes for posting messages
- an app-level token for Socket Mode
- the bot installed into the Slack workspace
- the bot invited to the approvals, alerts, and tickets channels

## Required Secrets

Store these as Paperclip company secrets or environment variables:

| Name | Purpose |
|------|---------|
| `SLACK_BOT_TOKEN` | Bot token used to post messages |
| `SLACK_APP_TOKEN` | App-level token used for Socket Mode |
| `SLACK_SIGNING_SECRET` | Verifies HTTP interaction requests if an HTTP endpoint is used |
| `SLACK_APPROVALS_CHANNEL_ID` | Channel for approval cards |
| `SLACK_ALERTS_CHANNEL_ID` | Channel for blocker and escalation alerts |
| `SLACK_TICKETS_CHANNEL_ID` | Channel for ticket-created notifications |
| `SLACK_USER_MAP_JSON` | JSON object mapping Slack user IDs to Paperclip board user IDs |

Example `SLACK_USER_MAP_JSON`:

```json
{"U1234567890":"local-board"}
```

Use the actual Slack user ID as the key and the Paperclip board user ID as the value. For a local trusted single-board setup, the Paperclip board user ID is often `local-board`.

## Approval Trust Boundary

Agents must not treat ordinary Slack messages as approval.

The approval path is:

1. Paperclip creates a pending approval.
2. Paperclip posts a Slack approval card containing the Paperclip approval ID.
3. The board operator clicks a Slack button.
4. Paperclip verifies the Slack interaction, maps the Slack user to a Paperclip board user, checks authorization, checks that the approval is still pending, records the decision, and writes an audit event.
5. Paperclip updates the Slack message so stale buttons cannot be reused.
6. Paperclip wakes or notifies the relevant agent with a structured approval event.

If any verification step fails, the Slack action is rejected and the Paperclip approval is not resolved.

## Smoke Tests

From the repository root, verify Slack channel delivery and Socket Mode:

```bash
./scripts/slack-smoke-test.sh
```

Expected result:

```text
approvals: ok
alerts: ok
tickets: ok
socket_mode: ok
```

To post a live test approval card:

```bash
cd server
pnpm exec tsx scripts/create-slack-approval-smoke-test.ts
```

Click one of the Slack approval buttons and verify the approval changes state in Paperclip before any agent acts on it.

## Operational Notes

- Keep `PAPERCLIP_API_URL` accurate so the `Open in Paperclip` button points to the right board URL.
- Keep Slack channel IDs stable. Channel names can change; IDs are the configuration source.
- If a Slack token, app token, signing secret, or former notification webhook is exposed, rotate it.
- Zapier or similar tools may be used later for outbound low-risk notification fan-out, but they must not become approval authority.
