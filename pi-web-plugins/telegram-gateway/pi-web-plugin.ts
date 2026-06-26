import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const CONFIG_PATH = "~/.pi-web/telegram-gateway/config.json";
const PLUGIN_PATH = "~/.pi-web/plugins/telegram-gateway";
const RUN_COMMAND = `TELEGRAM_BOT_TOKEN="paste-token-here" node ${PLUGIN_PATH}/gateway.mjs --config ${CONFIG_PATH}`;

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Telegram Gateway",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "gateway.open",
          title: "Open Telegram Gateway Panel",
          description: "Show setup and launch commands for the Telegram-to-PI-WEB gateway.",
          group: "Integrations",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => { context.selectWorkspaceTool("telegram-gateway:workspace.telegram"); },
        },
        {
          id: "gateway.terminal",
          title: "Open Terminal for Telegram Gateway",
          description: "Open the workspace terminal; the Telegram panel contains the copyable run command.",
          group: "Integrations",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => {
            context.selectWorkspaceTool("telegram-gateway:workspace.telegram");
            context.openTerminal();
          },
        },
      ],
      workspaceLabels: [
        {
          id: "telegram-label",
          order: 90,
          items: () => [{ type: "text", text: "telegram", title: "Telegram Gateway plugin available" }],
        },
      ],
      workspacePanels: [
        {
          id: "workspace.telegram",
          title: "Telegram",
          order: 320,
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 3 10 14"></path>
              <path d="m21 3-7 18-4-7-7-4 18-7Z"></path>
            </svg>
          `,
          render: ({ workspace, terminal }) => html`
            <section class="toolbar"><strong>Telegram Gateway</strong></section>
            <section class="viewer">
              <p>
                Bridge trusted Telegram users into isolated PI WEB sessions with the dependency-free
                <code>gateway.mjs</code> long-polling service.
              </p>
              <p class="muted">
                Current workspace: <code>${workspace.path}</code>
              </p>

              <h3>Fast path: run the setup wizard</h3>
              <pre><code>node /home/nick/code/pi-web-vigilante/pi-web-plugins/telegram-gateway/setup.mjs</code></pre>
              <p class="muted">
                The wizard verifies your BotFather token, detects your Telegram user ID after you send <code>/start</code>,
                writes config, and can install the plugin symlink.
              </p>

              <h3>Manual 1. Install this plugin locally</h3>
              <pre><code>mkdir -p ~/.pi-web/plugins
ln -s /path/to/pi-web-plugins/telegram-gateway ~/.pi-web/plugins/telegram-gateway</code></pre>

              <h3>Manual 2. Create config</h3>
              <pre><code>mkdir -p ~/.pi-web/telegram-gateway
cp ${PLUGIN_PATH}/config.example.json ${CONFIG_PATH}
$EDITOR ${CONFIG_PATH}</code></pre>
              <p class="muted">
                Set <code>defaultCwd</code> or a per-user route to <code>${workspace.path}</code>, add Telegram numeric user IDs,
                and keep your bot token out of git.
              </p>

              <h3>Manual 3. Run the gateway</h3>
              <pre><code>${RUN_COMMAND}</code></pre>
              <p>
                <button @click=${() => terminal.runCommand({
                  title: "Run Telegram Gateway",
                  command: RUN_COMMAND,
                  open: true,
                  metadata: { "telegram-gateway.task": "run" },
                })}>Open terminal with run command</button>
              </p>

              <h3>Telegram commands</h3>
              <ul>
                <li><code>/start</code>, <code>/help</code> — show usage.</li>
                <li><code>/status</code> — show workspace and active PI session.</li>
                <li><code>/new</code> — create a fresh isolated session for that chat.</li>
                <li><code>/setcwd /absolute/path</code> — admin-only workspace routing.</li>
              </ul>

              <h3>Security checklist</h3>
              <ul>
                <li>Use <code>TELEGRAM_BOT_TOKEN</code> or an env file, not a committed token.</li>
                <li>Keep <code>allowedTelegramUserIds</code> tight; unknown users are denied.</li>
                <li>Give non-technical friends a safe workspace/profile with limited repo scope.</li>
                <li>Run over private PI WEB/Tailscale/localhost; no public webhook is needed.</li>
              </ul>
            </section>
          `,
        },
      ],
    },
  }),
};

export default plugin;
