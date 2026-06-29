# PI WEB Workspace Auth

A PI WEB helper plugin, setup wizard, and policy template for mapping authenticated users to allowed workspaces.

This is the policy source of truth that both Better Auth-protected PI WEB and the Telegram Gateway can use:

```text
Better Auth user ID -> allowed workspace paths
Telegram user ID -> linked Better Auth user ID -> allowed workspace paths
```

Legacy Clerk user IDs still work during migration, but Better Auth IDs should be treated as the target canonical identity.

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

When this is set, Telegram access can be granted by adding a Telegram numeric user ID to the matching Better Auth user record.

## Internal dashboard

Open a workspace, choose the **Access** panel, and use the Workspace Auth Dashboard to create/update the shared policy file, add Better Auth users, mark admins, add allowed workspace paths, and link Telegram numeric user IDs. The dashboard writes the same policy JSON used by the PI WEB server and Telegram Gateway.

The dashboard calls the admin-only `/api/workspace-access` endpoint. When workspace auth is disabled, local PI WEB acts as the admin so you can bootstrap the first policy. When auth is enabled, only users listed in `admins` can edit it.

## Server-side enforcement

PI WEB's current enforcement layer is policy-first and can be keyed by Better Auth user IDs. The older browser login path is still Clerk-ready until the full Better Auth browser/runtime migration lands. Enable the policy layer with:

```bash
export PI_WEB_WORKSPACE_AUTH=true
export PI_WEB_WORKSPACE_ACCESS=~/.pi-web/workspace-access.json
```

Better Auth infra credentials are server-side only. Keep them in `~/.pi-web/workspace-auth.env` or your systemd env, never in git or browser code:

```bash
export BETTER_AUTH_API_URL=https://api.better-auth.com
export BETTER_AUTH_KV_URL=https://kv.better-auth.com
export BETTER_AUTH_API_KEY=replace-with-private-key
```

The browser login UI still uses `CLERK_PUBLISHABLE_KEY` when set. If it is omitted, PI WEB derives the publishable key from `CLERK_ISSUER` / `PI_WEB_CLERK_ISSUER` for standard Clerk domains.

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

## Browser auth migration note

When workspace auth is enabled today, PI WEB serves `/api/workspace-access/public` before requiring authentication. The current browser login implementation still loads Clerk, renders the Clerk sign-in card when there is no session, then forwards the active session token on HTTP requests and websocket upgrades.

The next Better Auth migration step is to replace that browser login/runtime with Better Auth while keeping the same `~/.pi-web/workspace-access.json` policy and Access panel. Admins can edit the policy from the **Access** workspace panel after signing in.
