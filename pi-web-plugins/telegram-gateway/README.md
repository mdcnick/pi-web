# PI WEB Telegram Gateway

A production-minded PI WEB plugin package that lets trusted Telegram users chat with isolated PI WEB / Pi Coding Agent sessions.

The plugin has two parts:

- `pi-web-plugin.js`: a browser-side PI WEB panel with setup guidance and launch helpers.
- `gateway.mjs`: a dependency-free Node.js long-polling Telegram bridge.

Long polling is intentional: your PI WEB can stay private on `127.0.0.1`, Tailscale, WireGuard, or another private network. Telegram does not need a public webhook into your machine.

## Security model

- Deny-by-default Telegram user allowlist.
- One private PI session per Telegram user/chat by default.
- Bot token is preferably supplied via `TELEGRAM_BOT_TOKEN`, not committed to disk.
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
- `defaultCwd`: absolute workspace path used for users without a route.
- `allowedTelegramUserIds`: numeric Telegram user IDs allowed to use the bot.
- optional `userRoutes.<telegramUserId>.cwd`: per-friend workspace path.

Create a bot with BotFather, then run with the token in the environment:

```bash
TELEGRAM_BOT_TOKEN='123:abc' node ~/.pi-web/plugins/telegram-gateway/gateway.mjs --config ~/.pi-web/telegram-gateway/config.json
```

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

Telegram users listed under a Clerk user record's `telegramUserIds` inherit that user's allowed `workspaces`.

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
Environment=TELEGRAM_BOT_TOKEN=replace-with-token-or-use-env-file
ExecStart=/usr/bin/node %h/.pi-web/plugins/telegram-gateway/gateway.mjs --config %h/.pi-web/telegram-gateway/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Prefer `EnvironmentFile=%h/.config/pi-web-telegram-gateway.env` for real secrets.

## Notes for publishing

This package is intentionally dependency-free and can be published as a standalone GitHub repository or npm/Pi package. Keep `config.example.json` secret-free.
