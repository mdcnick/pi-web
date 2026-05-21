# Pi Web Actions

Configurable workspace actions for Pi Web.

The plugin adds an **Actions** workspace tab. Actions create a new Pi Web terminal, send the configured shell command, and switch to that terminal so the user can monitor progress or take over.

## Configuration

Create `.pi-web/actions.json` in the workspace root where you want actions. The file is optional per workspace; workspaces without it simply show no actions.

```json
{
  "version": 1,
  "actions": [
    {
      "id": "docker.start",
      "title": "Start Docker",
      "group": "Docker",
      "description": "Start the local Docker Compose environment.",
      "command": "./docker/scripts/docker-compose-dev up -d"
    },
    {
      "id": "db.reset",
      "title": "Reset DB",
      "group": "Database",
      "command": "go -C klingit-go run ./cli db reset",
      "confirm": true
    }
  ]
}
```

Fields:

- `version`: must be `1`.
- `actions`: array of action definitions.
- `id`: stable action id, matching `^[a-z][a-z0-9.-]*$`.
- `title`: button label.
- `command`: literal shell command sent to the terminal.
- `description`: optional explanatory text.
- `group`: optional group heading.
- `confirm`: optional boolean. When true, the browser asks before dispatching the command.

Commands run in the workspace root because Pi Web creates the terminal for that workspace.

After editing `.pi-web/actions.json`, click **Refresh** in the Actions tab or reload the browser tab. The plugin does not watch the file automatically.

## Development in this monorepo

This package is developed as a separate npm package, not as a bundled Pi Web plugin. From the Pi Web repository, the single root dev command builds, watches, and auto-loads this package without symlinking it into `~/.pi-web/plugins`:

```bash
npm run dev
```

Then reload Pi Web and check discovery:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

Build the package before publishing or packing:

```bash
npm --workspace @jmfederico/pi-web-actions run build
npm pack --workspace @jmfederico/pi-web-actions --dry-run
```

## Beta/private API note

This plugin intentionally dogfoods private Pi Web browser APIs for reading workspace files and creating/writing terminals. Those APIs are not yet stable public plugin APIs, so compatibility is best-effort and may require updates alongside Pi Web releases.

## Notes

This plugin intentionally keeps v1 simple:

- static JSON only;
- no variables or templating;
- every action creates a new terminal;
- command prompting/extra input should be handled by the script itself.
