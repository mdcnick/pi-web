# PI WEB Telegram Gateway

A production-minded PI WEB plugin package that lets trusted Telegram users chat with isolated PI WEB / Pi Coding Agent sessions.

The plugin has two parts:

- `pi-web-plugin.js`: a browser-side PI WEB panel with setup guidance and launch helpers.
- `gateway.mjs`: a dependency-free Node.js long-polling Telegram bridge.

Long polling is intentional: your PI WEB can stay private on `127.0.0.1`, Tailscale, WireGuard, or another private network. Telegram does not need a public webhook into your machine.

## Security model

- Deny-by-default Telegram user allowlist.
- One private PI session per allowed Telegram user/bot link by default.
- Preferred model: add the actual Telegram user's numeric ID, then attach the BotFather token for whichever bot that user/session should use.
- Dashboard/admin auth is separate; the Telegram Gateway allowlist is not the dashboard login system.
- Shared-control mode is supported: the gateway may use the PI WEB owner's internal/admin auth token to call the shared PI WEB API for Telegram users who never log into the dashboard.
- Execution remains isolated by workspace: every session API call includes the target `cwd`, so a PI WEB server with per-user session daemon routing sends `/home/will/...` sessions to Will's daemon/MCP credentials and `/home/nick/...` sessions to Nick's daemon/MCP credentials.
- Do not copy dashboard auth tokens into another user's MCP/runtime config; share the control-plane auth only at the Telegram gateway/API layer.
- Legacy single-bot mode still works with `TELEGRAM_BOT_TOKEN`, but the in-app UI is optimized for per-user bot-token routing.
- The gateway talks to PI WEB's normal local API; it does not expose a public HTTP server.
- `/setcwd` is admin-only because it controls which workspace future sessions start in.

## Install as a local PI WEB plugin

```bash
mkdir -p ~/.pi-web/plugins
ln -s /path/to/pi-web-plugins/telegram-gateway ~/.pi-web/plugins/telegram-gateway
```

Reload PI WEB and open the **Telegram** workspace tab.

## Easiest setup

Run the wizard. It verifies the bot token, asks you to send `/start` to the bot, auto-detects your Telegram numeric user ID, writes the config, and can symlink the plugin into PI WEB:

```bash
node /home/nick/code/pi-web-vigilante/pi-web-plugins/telegram-gateway/setup.mjs
```

Then start the gateway with the command printed by the wizard.

## Manual configure

```bash
mkdir -p ~/.pi-web/telegram-gateway
cp ~/.pi-web/plugins/telegram-gateway/config.example.json ~/.pi-web/telegram-gateway/config.json
$EDITOR ~/.pi-web/telegram-gateway/config.json
```

Set:

- `piWebBaseUrl`: your PI WEB web/API URL, usually `http://127.0.0.1:8504`.
- `defaultCwd`: fallback absolute workspace path.
- `sessionBots[]`: internal config rows for allowed Telegram users and their attached bot tokens.
  - `allowedTelegramUserIds`: the actual numeric Telegram user IDs allowed through that row.
  - `telegramBotToken`: the BotFather token for the bot that user/session should use.
  - `cwd`: workspace path for that user/session.
  - `sessionId`: optional existing PI WEB session ID; leave blank to let the gateway create/remember one.

Telegram-bound sessions are automatically protected: the gateway locks, pins, makes permanent, and blocks terminal access for configured/remembered session IDs when it starts or reloads, and again before forwarding user prompts.

Start one gateway process; it polls all configured user/bot rows and watches the config for changes, so adding another Telegram user/bot in the UI does not require manually restarting the gateway:

```bash
node ~/.pi-web/plugins/telegram-gateway/gateway.mjs --config ~/.pi-web/telegram-gateway/config.json
```

Legacy single-bot mode still works if you set top-level `allowedTelegramUserIds` and run with `TELEGRAM_BOT_TOKEN='123:abc'`.

## Shared workspace auth

For the Clerk/workspace model, create a shared access file:

```bash
mkdir -p ~/.pi-web
cp ~/.pi-web/plugins/workspace-auth/workspace-access.example.json ~/.pi-web/workspace-access.json
$EDITOR ~/.pi-web/workspace-access.json
```

Then set this in `~/.pi-web/telegram-gateway/config.json`:

```json
"workspaceAccessPath": "~/.pi-web/workspace-access.json"
```

Telegram users listed under a Clerk user record's `telegramUserIds` inherit that user's allowed `workspaces`. This is optional/advanced; the basic Telegram Gateway UI can simply allow a Telegram numeric ID and attach that user's bot token without using the dashboard auth file.

## Telegram commands

- `/start`, `/help` — show help.
- `/status` — show mapped workspace and session.
- `/new` — create a new isolated PI WEB session for this chat.
- `/setcwd /absolute/path` — admin-only; change this user's workspace for future sessions.

## Running as a service

A typical systemd user service:

```ini
[Unit]
Description=PI WEB Telegram Gateway
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.pi-web/plugins/telegram-gateway/gateway.mjs --config %h/.pi-web/telegram-gateway/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

If you intentionally use legacy single-bot mode, add `EnvironmentFile=%h/.config/pi-web-telegram-gateway.env` with `TELEGRAM_BOT_TOKEN=...`. For the normal per-user bot-token model, tokens live in the private `~/.pi-web/telegram-gateway/config.json` file written with mode `0600`.

## Notes for publishing

This package is intentionally dependency-free and can be published as a standalone GitHub repository or npm/Pi package. Keep `config.example.json` secret-free.
