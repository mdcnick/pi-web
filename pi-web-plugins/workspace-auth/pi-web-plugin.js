const POLICY_PATH = "~/.pi-web/workspace-access.json";
const PLUGIN_PATH = "~/.pi-web/plugins/workspace-auth";

class WorkspaceAuthDashboard extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this.state = { loading: true, saving: false, error: undefined, settings: undefined, selectedUserId: "" };
    this.load();
  }

  get workspacePath() {
    return this.getAttribute("workspace-path") ?? "";
  }

  async load() {
    this.state = { ...this.state, loading: true, error: undefined };
    this.render();
    try {
      const response = await fetch("/api/workspace-access", { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      const firstUserId = Object.keys(value.policy?.users ?? {})[0] ?? "";
      this.state = { loading: false, saving: false, error: undefined, settings: value, selectedUserId: this.state.selectedUserId || firstUserId };
    } catch (error) {
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  async save(policy) {
    this.state = { ...this.state, saving: true, error: undefined };
    this.render();
    try {
      const response = await fetch("/api/workspace-access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      this.state = { ...this.state, saving: false, settings: value };
    } catch (error) {
      this.state = { ...this.state, saving: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  render() {
    if (this.shadowRoot === null) return;
    const settings = this.state.settings;
    const policy = settings?.policy ?? { admins: [], users: {} };
    const users = Object.values(policy.users ?? {});
    const selectedUser = policy.users?.[this.state.selectedUserId] ?? users[0];
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; color:var(--pi-text, #e5e7eb); }
        .wrap { display:grid; gap:14px; padding:2px; }
        .card { border:1px solid var(--pi-border, #374151); border-radius:12px; background:var(--pi-surface, #111827); padding:14px; }
        .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .grid { display:grid; grid-template-columns:minmax(180px, 260px) 1fr; gap:12px; }
        .users { display:grid; gap:6px; align-content:start; }
        button { border:1px solid var(--pi-border, #374151); border-radius:8px; background:var(--pi-surface-hover, #1f2937); color:inherit; padding:7px 10px; cursor:pointer; }
        button.primary { border-color:var(--pi-accent-border, #60a5fa); color:var(--pi-accent, #93c5fd); }
        button.danger { border-color:var(--pi-danger, #ef4444); color:var(--pi-danger, #f87171); }
        button.selected { background:var(--pi-selection-bg, #1e3a8a); }
        button:disabled { opacity:.55; cursor:not-allowed; }
        input, textarea { width:100%; box-sizing:border-box; border:1px solid var(--pi-border, #374151); border-radius:8px; background:var(--pi-bg, #030712); color:inherit; padding:8px; }
        textarea { min-height:76px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
        label { display:grid; gap:5px; font-size:12px; color:var(--pi-text-secondary, #9ca3af); }
        code { color:var(--pi-accent, #93c5fd); }
        .muted { color:var(--pi-text-secondary, #9ca3af); }
        .error { border-color:var(--pi-danger, #ef4444); color:var(--pi-danger, #f87171); }
        .ok { color:var(--pi-success, #34d399); }
        @media (max-width: 760px) { .grid { grid-template-columns:1fr; } }
      </style>
      <div class="wrap">
        <div class="card">
          <div class="row">
            <strong>Workspace Auth Dashboard</strong>
            ${settings === undefined ? "" : `<span class="muted">${settings.enabled ? "enforcement enabled" : "local/admin mode"}</span>`}
            ${this.state.saving ? `<span class="muted">saving…</span>` : ""}
          </div>
          ${settings === undefined ? "" : `
            <p class="muted">Policy file: <code>${escapeHtml(settings.path)}</code> · ${settings.exists ? `<span class="ok">exists</span>` : `<span class="muted">will be created on save</span>`}</p>
            <p class="muted">Current workspace: <code>${escapeHtml(this.workspacePath)}</code></p>
          `}
          ${this.state.error === undefined ? "" : `<p class="card error">${escapeHtml(this.state.error)}</p>`}
          <div class="row">
            <button id="refresh">Refresh</button>
            <button id="copy-env">Copy env</button>
          </div>
        </div>
        ${this.state.loading ? `<p class="muted">Loading…</p>` : `
          <div class="grid">
            <div class="card users">
              <div class="row"><strong>Users</strong><button id="add-user" class="primary">Add user</button></div>
              ${users.length === 0 ? `<p class="muted">No users yet.</p>` : users.map((user) => `
                <button class="${selectedUser?.id === user.id ? "selected" : ""}" data-select-user="${escapeAttr(user.id)}">
                  ${escapeHtml(user.label || user.email || user.id)}${policy.admins.includes(user.id) ? " · admin" : ""}
                </button>
              `).join("")}
            </div>
            <div class="card">
              ${selectedUser === undefined ? `<p class="muted">Add a user to begin.</p>` : this.renderUserForm(selectedUser, policy)}
            </div>
          </div>
        `}
      </div>
    `;
    this.bindEvents();
  }

  renderUserForm(user, policy) {
    return `
      <div class="row"><strong>Edit user</strong><button id="save-user" class="primary">Save user</button><button id="delete-user" class="danger">Delete</button></div>
      <p class="muted">Use the Clerk user ID as the user ID. Add one workspace path per line.</p>
      <label>User ID<input id="user-id" value="${escapeAttr(user.id)}" /></label>
      <label>Label<input id="user-label" value="${escapeAttr(user.label ?? "")}" /></label>
      <label>Email<input id="user-email" value="${escapeAttr(user.email ?? "")}" /></label>
      <label>Allowed workspaces<textarea id="user-workspaces">${escapeHtml((user.workspaces ?? []).join("\n"))}</textarea></label>
      <div class="row"><button id="add-current-workspace">Add current workspace</button></div>
      <label>Telegram user IDs <span class="muted">comma or newline separated integers</span><textarea id="user-telegram">${escapeHtml((user.telegramUserIds ?? []).join("\n"))}</textarea></label>
      <label class="row"><input id="user-admin" type="checkbox" ${policy.admins.includes(user.id) ? "checked" : ""} style="width:auto" /> Admin user</label>
    `;
  }

  bindEvents() {
    this.shadowRoot?.getElementById("refresh")?.addEventListener("click", () => this.load());
    this.shadowRoot?.getElementById("copy-env")?.addEventListener("click", () => this.copyEnv());
    this.shadowRoot?.getElementById("add-user")?.addEventListener("click", () => this.addUser());
    for (const button of this.shadowRoot?.querySelectorAll("[data-select-user]") ?? []) {
      button.addEventListener("click", () => {
        this.state = { ...this.state, selectedUserId: button.getAttribute("data-select-user") ?? "" };
        this.render();
      });
    }
    this.shadowRoot?.getElementById("add-current-workspace")?.addEventListener("click", () => this.addCurrentWorkspaceToTextarea());
    this.shadowRoot?.getElementById("save-user")?.addEventListener("click", () => this.saveUser());
    this.shadowRoot?.getElementById("delete-user")?.addEventListener("click", () => this.deleteUser());
  }

  policyCopy() {
    const policy = this.state.settings?.policy ?? { admins: [], users: {} };
    return JSON.parse(JSON.stringify(policy));
  }

  addUser() {
    const id = prompt("Clerk user ID", "user_");
    if (id === null || id.trim() === "") return;
    const userId = id.trim();
    const policy = this.policyCopy();
    policy.users[userId] = policy.users[userId] ?? { id: userId, label: "", workspaces: [], telegramUserIds: [] };
    this.state = { ...this.state, selectedUserId: userId, settings: { ...this.state.settings, policy } };
    this.render();
  }

  addCurrentWorkspaceToTextarea() {
    const textarea = this.shadowRoot?.getElementById("user-workspaces");
    if (!(textarea instanceof HTMLTextAreaElement) || this.workspacePath === "") return;
    const lines = splitLines(textarea.value);
    if (!lines.includes(this.workspacePath)) lines.push(this.workspacePath);
    textarea.value = lines.join("\n");
  }

  saveUser() {
    const oldUserId = this.state.selectedUserId;
    const userId = inputValue(this.shadowRoot, "user-id").trim();
    if (userId === "") {
      this.state = { ...this.state, error: "User ID is required" };
      this.render();
      return;
    }
    const policy = this.policyCopy();
    delete policy.users[oldUserId];
    policy.users[userId] = {
      id: userId,
      label: inputValue(this.shadowRoot, "user-label").trim() || undefined,
      email: inputValue(this.shadowRoot, "user-email").trim() || undefined,
      workspaces: splitLines(inputValue(this.shadowRoot, "user-workspaces")),
      telegramUserIds: parseTelegramIds(inputValue(this.shadowRoot, "user-telegram")),
    };
    policy.admins = policy.admins.filter((id) => id !== oldUserId && id !== userId);
    const adminInput = this.shadowRoot?.getElementById("user-admin");
    if (adminInput instanceof HTMLInputElement && adminInput.checked) policy.admins.push(userId);
    this.state = { ...this.state, selectedUserId: userId };
    this.save(policy);
  }

  deleteUser() {
    const userId = this.state.selectedUserId;
    if (userId === "" || !confirm(`Delete ${userId}?`)) return;
    const policy = this.policyCopy();
    delete policy.users[userId];
    policy.admins = policy.admins.filter((id) => id !== userId);
    this.state = { ...this.state, selectedUserId: Object.keys(policy.users)[0] ?? "" };
    this.save(policy);
  }

  copyEnv() {
    const path = this.state.settings?.path ?? POLICY_PATH;
    const text = `export PI_WEB_WORKSPACE_AUTH=true\nexport PI_WEB_WORKSPACE_ACCESS=${path}\n# export CLERK_PUBLISHABLE_KEY=pk_test_...\n# export PI_WEB_CLERK_ISSUER=https://your-clerk-domain\n# export PI_WEB_TRUST_AUTH_HEADERS=true`;
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}

function inputValue(root, id) {
  const input = root?.getElementById(id);
  return input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value : "";
}

function splitLines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function parseTelegramIds(value) {
  return value.split(/[\s,]+/u).map((part) => part.trim()).filter(Boolean).map((part) => Number(part)).filter((value) => Number.isInteger(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/gu, "&#39;");
}

if (!customElements.get("workspace-auth-dashboard")) {
  customElements.define("workspace-auth-dashboard", WorkspaceAuthDashboard);
}

const plugin = {
  apiVersion: 1,
  name: "Workspace Auth",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "workspace-auth.open",
          title: "Open Workspace Auth Panel",
          description: "Configure Clerk/workspace policy users and Telegram links.",
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
              <workspace-auth-dashboard workspace-path=${workspace.path}></workspace-auth-dashboard>
              <div style="margin-top:16px">
                <h3>CLI fallback</h3>
                <pre><code>node ${PLUGIN_PATH}/setup.mjs</code></pre>
                <p>
                  <button @click=${() => terminal.runCommand({
                    title: "Run Workspace Auth Setup",
                    command: `node ${PLUGIN_PATH}/setup.mjs`,
                    open: true,
                    metadata: { "workspace-auth.task": "setup" },
                  })}>Run setup wizard</button>
                </p>
              </div>
            </section>
          `,
        },
      ],
    },
  }),
};

export default plugin;
