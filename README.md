# Pi Web POC

Small web wrapper around `@mariozechner/pi-coding-agent`.

## What it does

- Add/list projects.
- Discover workspaces from `git worktree list --porcelain`.
- For non-git projects, show the project folder as the only workspace.
- List Pi sessions for a workspace using Pi's default session storage.
- Start Pi sessions, chat over WebSocket events, and stop individual session runtimes.

## State

This POC intentionally keeps state minimal:

- Projects: `~/.pi-web/projects.json`
- Workspaces: discovered from git, not stored
- Sessions/chat history: Pi default JSONL session storage
- Active session runtimes/WebSockets: memory only in `pi-web-sessiond`

## Run

```bash
npm install
npm run dev
```

Open the Vite URL, usually <http://localhost:5173>.

The session runtime owner is split into a tiny long-lived daemon. To iterate on only the web/API/UI process while keeping active Pi sessions alive, run these in separate terminals:

```bash
npm run dev:sessiond
npm run dev:web
npm run dev:client
```

Then restart `dev:web` or `dev:client` freely; active Pi sessions continue in `dev:sessiond`.

### systemd user services for local development

This repository is commonly run as two systemd user services:

- `pi-web-sessiond.service`: runs `npm run start:sessiond` without autoreload or automatic restart.
- `pi-web-ui-dev.service`: runs `npm run dev:web` and `npm run dev:client` together, giving backend autoreload via `tsx watch` and Vite UI HMR.

Example units live in `~/.config/systemd/user/` on the development host:

```ini
# ~/.config/systemd/user/pi-web-sessiond.service
[Unit]
Description=Pi Web session daemon

[Service]
Type=simple
WorkingDirectory=/srv/dev/pi-web
ExecStart=/bin/bash -lc 'exec npm run start:sessiond'
Restart=no

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/pi-web-ui-dev.service
[Unit]
Description=Pi Web UI dev server
After=pi-web-sessiond.service
Wants=pi-web-sessiond.service

[Service]
Type=simple
WorkingDirectory=/srv/dev/pi-web
ExecStart=/bin/bash -lc 'trap "kill 0" EXIT; npm run dev:web & npm run dev:client & wait'
Restart=no

[Install]
WantedBy=default.target
```

After creating or changing units:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-web-sessiond.service
systemctl --user enable --now pi-web-ui-dev.service
```

Useful logs:

```bash
journalctl --user -u pi-web-sessiond.service -f
journalctl --user -u pi-web-ui-dev.service -f
```

Because `sessiond` is intentionally not watched or restarted automatically, code changes that affect `src/server/sessiond.ts` or session runtime ownership require manually restarting `pi-web-sessiond.service`:

```bash
systemctl --user restart pi-web-sessiond.service
```

Restarting only the UI dev service is enough for changes in the web/API/UI processes.

For deployment:

```bash
npm run build
npm run start:sessiond
PI_WEB_PORT=3000 npm start
```

Then proxy Traefik to `http://127.0.0.1:3000`.

The web server defaults to `127.0.0.1:3000`. Use `PI_WEB_HOST=0.0.0.0` only if you want to bind directly on all interfaces. The session daemon defaults to a private Unix socket at `~/.pi-web/sessiond.sock`; override with `PI_WEB_SESSIOND_SOCKET` or use TCP with `PI_WEB_SESSIOND_PORT` plus `PI_WEB_SESSIOND_URL` for the web process.

## Notes

- The backend uses your normal Pi auth/model settings from `~/.pi/agent`.
- Slash commands that belong to Pi's interactive TUI, such as `/model`, are not implemented in this POC UI yet. Plain prompts and extension/prompt-template handling go through the SDK path.
- Browser disconnects and web-server restarts do not stop active Pi sessions. Only the explicit `Stop session` action aborts/disposes that one session runtime.
