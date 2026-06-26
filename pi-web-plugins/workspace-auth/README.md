# PI WEB Workspace Auth

A PI WEB helper plugin, setup wizard, and policy template for mapping authenticated users to allowed workspaces.

This is the policy source of truth that both the future Clerk-protected PI WEB server and the Telegram Gateway can use:

```text
Clerk user ID -> allowed workspace paths
Telegram user ID -> linked Clerk user ID -> allowed workspace paths
```

## Setup

```bash
node ~/.pi-web/plugins/workspace-auth/setup.mjs
```

or from a source checkout:

```bash
node pi-web-plugins/workspace-auth/setup.mjs
```

The setup writes:

- `~/.pi-web/workspace-access.json` - user/workspace ACL policy
- `~/.pi-web/workspace-auth.env` - environment variables to source before starting PI WEB

## Policy file

Copy the example:

```bash
mkdir -p ~/.pi-web
cp ~/.pi-web/plugins/workspace-auth/workspace-access.example.json ~/.pi-web/workspace-access.json
$EDITOR ~/.pi-web/workspace-access.json
```

Example user record:

```json
{
  "users": {
    "user_abc123": {
      "label": "Alice",
      "email": "alice@example.com",
      "workspaces": ["/home/nick/pi-friends/alice"],
      "telegramUserIds": [123456789]
    }
  }
}
```

## Telegram Gateway integration

Set this in `~/.pi-web/telegram-gateway/config.json`:

```json
{
  "workspaceAccessPath": "~/.pi-web/workspace-access.json"
}
```

When this is set, Telegram access can be granted by adding a Telegram numeric user ID to the matching Clerk user record.

## Internal dashboard

Open a workspace, choose the **Access** panel, and use the Workspace Auth Dashboard to create/update the shared policy file, add Clerk users, mark admins, add allowed workspace paths, and link Telegram numeric user IDs. The dashboard writes the same policy JSON used by the PI WEB server and Telegram Gateway.

The dashboard calls the admin-only `/api/workspace-access` endpoint. When workspace auth is disabled, local PI WEB acts as the admin so you can bootstrap the first policy. When auth is enabled, only users listed in `admins` can edit it.

## Server-side enforcement

PI WEB now has a Clerk-ready workspace access controller. Enable the policy layer with:

```bash
export PI_WEB_WORKSPACE_AUTH=true
export PI_WEB_WORKSPACE_ACCESS=~/.pi-web/workspace-access.json
```

The browser login UI uses `CLERK_PUBLISHABLE_KEY` when set. If it is omitted, PI WEB derives the publishable key from `CLERK_ISSUER` / `PI_WEB_CLERK_ISSUER` for standard Clerk domains.

The enforcement adapter verifies Clerk session JWTs directly using Node built-ins. Configure either:

```bash
export CLERK_ISSUER=https://your-app.clerk.accounts.dev
```

or:

```bash
export CLERK_JWKS_URL=https://your-app.clerk.accounts.dev/.well-known/jwks.json
```

Optional audience check:

```bash
export CLERK_AUDIENCE=your-audience
```

PI WEB accepts Clerk JWTs from `Authorization: Bearer <token>`, the Clerk `__session` cookie, or the `access_token` websocket query parameter and resolves the user from the token `sub` claim.

For trusted reverse-proxy deployments only, you can also enable user headers:

```bash
export PI_WEB_TRUST_AUTH_HEADERS=true
```

Then PI WEB accepts `X-PI-WEB-USER-ID` or `X-Clerk-User-ID`. Do not enable this unless clients cannot spoof those headers.

Protected surfaces include project/workspace filtering, workspace files, file suggestions, git routes, terminal routes, session prompts/events when `cwd` is supplied, and admin-only project/workspace mutation routes.

## Clerk browser integration

When workspace auth is enabled, PI WEB serves `/api/workspace-access/public` before requiring authentication. The client loads Clerk, renders the Clerk sign-in card when there is no session, then forwards the active session token on HTTP requests and websocket upgrades.

Keep using the same `~/.pi-web/workspace-access.json` policy. Admins can edit it from the **Access** workspace panel after signing in.
