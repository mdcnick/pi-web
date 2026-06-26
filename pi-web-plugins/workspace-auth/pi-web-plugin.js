const POLICY_PATH = "~/.pi-web/workspace-access.json";
const PLUGIN_PATH = "~/.pi-web/plugins/workspace-auth";

const plugin = {
  apiVersion: 1,
  name: "Workspace Auth",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "workspace-auth.open",
          title: "Open Workspace Auth Panel",
          description: "Show Clerk/workspace policy setup and Telegram linking guidance.",
          group: "Access Control",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => context.selectWorkspaceTool("workspace-auth:workspace.auth"),
        },
      ],
      workspaceLabels: [
        {
          id: "workspace-auth-label",
          order: 80,
          items: () => [{ type: "text", text: "acl", title: "Workspace Auth policy helper available" }],
        },
      ],
      workspacePanels: [
        {
          id: "workspace.auth",
          title: "Access",
          order: 300,
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
              <path d="m9 12 2 2 4-4"></path>
            </svg>
          `,
          render: ({ workspace, terminal }) => html`
            <section class="toolbar"><strong>Workspace Auth</strong></section>
            <section class="viewer">
              <p>
                Use Clerk user IDs as the canonical identity, then map each user to the workspace paths they may access.
                Telegram IDs link back to the same user record.
              </p>
              <p class="muted">Current workspace: <code>${workspace.path}</code></p>

              <h3>1. Install this plugin locally</h3>
              <pre><code>mkdir -p ~/.pi-web/plugins
ln -s /home/nick/code/pi-web-vigilante/pi-web-plugins/workspace-auth ~/.pi-web/plugins/workspace-auth</code></pre>

              <h3>2. Create the shared access policy</h3>
              <pre><code>node ${PLUGIN_PATH}/setup.mjs</code></pre>
              <p class="muted">Or manually:</p>
              <pre><code>mkdir -p ~/.pi-web
cp ${PLUGIN_PATH}/workspace-access.example.json ${POLICY_PATH}
$EDITOR ${POLICY_PATH}</code></pre>
              <p>
                Add this workspace to a user's <code>workspaces</code> array if they should access it:
              </p>
              <pre><code>"${workspace.path}"</code></pre>

              <h3>3. Link Telegram Gateway to this policy</h3>
              <pre><code>// ~/.pi-web/telegram-gateway/config.json
"workspaceAccessPath": "${POLICY_PATH}"</code></pre>

              <p>
                <button @click=${() => terminal.runCommand({
                  title: "Run Workspace Auth Setup",
                  command: `node ${PLUGIN_PATH}/setup.mjs`,
                  open: true,
                  metadata: { "workspace-auth.task": "setup" },
                })}>Run setup wizard</button>
              </p>

              <h3>Server-side enforcement</h3>
              <pre><code>export PI_WEB_WORKSPACE_AUTH=true
export PI_WEB_WORKSPACE_ACCESS=${POLICY_PATH}</code></pre>
              <p class="muted">
                Set <code>CLERK_ISSUER</code> or <code>CLERK_JWKS_URL</code> to verify Clerk JWTs from
                <code>Authorization: Bearer</code> or the Clerk <code>__session</code> cookie. Only use
                <code>PI_WEB_TRUST_AUTH_HEADERS=true</code> behind a proxy that strips spoofed client headers.
              </p>
            </section>
          `,
        },
      ],
    },
  }),
};

export default plugin;
