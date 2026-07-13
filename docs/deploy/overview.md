---
title: Deployment Overview
summary: Deployment modes at a glance
---

Paperclip supports three deployment configurations, from zero-friction local to internet-facing production.

## Deployment Modes

| Mode | Auth | Best For |
|------|------|----------|
| `local_trusted` | No login required | Single-operator local machine |
| `authenticated` + `private` | Login required | Private network (Tailscale, VPN, LAN) |
| `authenticated` + `public` | Login required | Internet-facing cloud deployment |

## Quick Comparison

### Local Trusted (Default)

- Loopback-only host binding (localhost)
- No human login flow (implicit `local-board` operator)
- Fastest local startup
- Best for: **single-operator** solo development and experimentation
- **Not for shared OS users, CI runners, or multi-agent hosts** — any local process can act as the board

### Authenticated + Private

- Login required via Better Auth
- Choose bind: `loopback` (recommended on shared multi-user hosts), or private network binds (`lan` / `tailnet`)
- Auto base URL mode (lower friction)
- Best for: shared hosts, multi-agent fleets, and team access over Tailscale or LAN
- Board Chat remains unavailable until separately hardened for a real browser-session instance admin

### Authenticated + Public

- Login required
- Explicit public URL required
- Stricter security checks
- Best for: cloud hosting, internet-facing deployment

## Choosing a Mode

- **Just trying Paperclip alone on your laptop?** Use `local_trusted` (the default)
- **Shared host / CI / multi-agent machine?** Use `authenticated` + `private` on loopback (or a private bind), then complete the board-claim flow
- **Sharing with a team on a private network?** Use `authenticated` + `private`
- **Deploying to the cloud?** Use `authenticated` + `public` — see [AWS ECS Fargate guide](aws-ecs.md)

Set the mode during onboarding:

```sh
pnpm paperclipai onboard
```

Or update it later:

```sh
pnpm paperclipai configure --section server
```
