---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for **single-operator local use only**.

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
- **Authentication**: no login required (implicit local board identity)
- **Use case**: solo local development and experimentation on a machine only you use
- **Board identity**: auto-created `local-board` user with instance-admin privileges

**Not suitable for:**

- Shared OS user accounts (multiple people logging into the same host)
- CI runners or multi-agent hosts where other processes can reach loopback
- Any environment where untrusted local processes share the machine

On a shared host, any local process can call the API as the board operator. Prefer `authenticated` + `private` on loopback (or a private bind) instead.

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies. This is the recommended posture for shared hosts, multi-agent fleets, and any machine more than one operator can access.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN) **or** shared-host loopback hardening.

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required when binding beyond loopback
- **Bind**: choose `loopback` (recommended on shared multi-user hosts), `lan`, `tailnet`, or `custom`
- **Headerless API access**: denied through the central authenticated actor path (no `local_implicit` board identity). Production TypeScript inventory: [local-implicit-inventory.md](./local-implicit-inventory.md).

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Recommended shared-host cutover (source-only prep; operator applies live mode later):

```sh
# Prefer loopback + authenticated/private so local processes cannot act as board
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=loopback
```

Allow custom Tailscale hostnames:

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Paperclip emits a one-time claim URL at startup if `local-board` is still the only instance admin:

```
/board-claim/<token>?code=<code>
```

A signed-in browser session user visits this URL to claim board ownership. The claim transaction is atomic and:

- Promotes the signed-in user to instance admin
- Ensures active **owner** company membership (and default owner grants) for the claiming user on every company
- Revokes every active board API key owned by `local-board`
- Cancels every pending CLI authentication challenge from the local-board window
- Archives active `local-board` company memberships and deletes residual `local-board` permission grants
- Removes the `local-board` instance-admin role
- Writes non-secret activity/audit evidence for each cleanup category

Any failure rolls back owner promotion and cleanup together so the instance never ends in mixed ownership. Already-revoked keys, already-cancelled/approved/expired CLI challenges, and non-`local-board` credentials (including agent API keys) are left alone.

Agent keys and other users' credentials created during the `local_trusted` window are **not** auto-revoked; inventory them by non-secret metadata and rotate only what the operator intends.

## Board Chat in authenticated mode

Board Chat (`POST /api/board/chat/stream`) is **unavailable** in `authenticated` mode by design. It is only safe for single-operator `local_trusted` instances (it spawns a local CLI with elevated local authority). Do not add a board-key or agent bypass for Board Chat during an authenticated/private cutover. Re-enable only after a separately hardened design that requires a real browser-session instance admin.

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```
