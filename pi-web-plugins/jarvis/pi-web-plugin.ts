import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Jarvis",
  activate: ({ pluginId, html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "jarvis.open",
          title: "Open Jarvis",
          description: "Open Jarvis inside the current workspace.",
          group: "Jarvis",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => {
            if (context.state.selectedWorkspace === undefined) return;
            context.selectWorkspaceTool(`${pluginId}:jarvis.panel`);
          },
        },
        {
          id: "jarvis.open-standalone",
          title: "Open Standalone Jarvis",
          description: "Open the full-screen Jarvis command center in a new tab.",
          group: "Jarvis",
          run: (context) => {
            const cwd = context.state.selectedWorkspace?.path;
            const query = cwd === undefined || cwd === "" ? "" : `?cwd=${encodeURIComponent(cwd)}`;
            window.open(`/jarvis${query}`, "_blank", "noopener,noreferrer");
          },
        },
      ],
      workspacePanels: [
        {
          id: "jarvis.panel",
          title: "Jarvis",
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
              <path d="M12 18v3"></path>
              <path d="M8 21h8"></path>
            </svg>
          `,
          order: 15,
          render: (context) => {
            const src = `/jarvis?embedded=1&cwd=${encodeURIComponent(context.workspace.path)}`;
            return html`
              <iframe
                title="Jarvis"
                src=${src}
                style="width:100%;height:calc(100dvh - 150px);min-height:720px;border:0;border-radius:18px;background:#05070d;display:block;"
                allow="microphone"
              ></iframe>
            `;
          },
        },
      ],
    },
  }),
};

export default plugin;
