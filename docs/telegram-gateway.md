# Telegram Gateway plugin

PI WEB includes a bundled/local plugin package at `pi-web-plugins/telegram-gateway` for bridging trusted Telegram users into persistent PI WEB sessions.

It is designed for private deployments: the gateway uses Telegram long polling, so Telegram never needs inbound access to your PI WEB server. PI WEB can remain on localhost, Tailscale, WireGuard, an SSH tunnel, or another private network.

## Components

- `pi-web-plugins/telegram-gateway/pi-web-plugin.ts` — PI WEB UI panel with setup instructions.
- `pi-web-plugins/telegram-gateway/gateway.mjs` — dependency-free Node.js bridge.
- `pi-web-plugins/telegram-gateway/config.example.json` — secret-free config template.

## Runtime flow

```text
Telegram user
  -> Telegram Bot API
  -> gateway.mjs long polling
  -> optional agentRouting channel wrapper
  -> PI WEB /api/machines/<machine>/sessions
  -> Pi Coding Agent session/subsessions
  -> gateway.mjs
  -> Telegram Bot API
```

Each Telegram user/chat gets a stable isolated PI WEB session mapping in the gateway state file. `/new` creates a fresh PI WEB session.

When `agentRouting.enabled` is set in the gateway config, the gateway becomes a Telegram channel adapter for the layered automation system. Normal Telegram messages are wrapped with Telegram user/chat identity, linked PI WEB workspace, bot label, and instructions that tell the PI WEB session to use available agent/subsession tools for broad research, implementation, and review tasks. This does not replace Better Auth or workspace policy; it only adds channel context after the Telegram user has been allowed.

Assistant replies are Telegram-formatted by default. The gateway asks PI WEB to avoid markdown tables and then rewrites any GitHub-style markdown table that still appears into bullet/key-value lines before chunking and sending the message.

## Quick start

Run the setup wizard:

```bash
node /home/nick/code/pi-web-vigilante/pi-web-plugins/telegram-gateway/setup.mjs
```

It verifies the BotFather token, asks you to send `/start`, detects your Telegram numeric user ID, writes `~/.pi-web/telegram-gateway/config.json`, and can symlink the plugin into `~/.pi-web/plugins/telegram-gateway`.

Then start the gateway with the command printed by the wizard, using the real token in `TELEGRAM_BOT_TOKEN`.

Reload PI WEB and open the **Telegram** workspace tab for in-app instructions.

## Security defaults

- Unknown Telegram user IDs are denied.
- Admin-only `/setcwd` controls workspace routing.
- Secrets are not required in plugin source or config if `TELEGRAM_BOT_TOKEN` is used.
- No public webhook listener is opened.
- `agentRouting` is prompt-layer orchestration guidance only; it must not grant broader workspace, tool, container, or deployment access.
