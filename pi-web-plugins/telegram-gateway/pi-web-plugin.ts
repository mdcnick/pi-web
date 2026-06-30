import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

interface TelegramGatewayUser {
  telegramUserId: number;
  label?: string | undefined;
  cwd?: string | undefined;
  sessionId?: string | undefined;
  admin?: boolean | undefined;
  botId?: string | undefined;
  botLabel?: string | undefined;
  botToken?: string | undefined;
  botTokenConfigured?: boolean | undefined;
  enabled?: boolean | undefined;
}

interface TelegramGatewaySettings {
  piWebBaseUrl: string;
  machineId: string;
  defaultCwd: string;
  workspaceAccessPath: string;
  statePath: string;
  users: TelegramGatewayUser[];
}

interface TelegramGatewayProcess {
  running: boolean;
  pid?: number | undefined;
  startedAt?: string | undefined;
  lastExit?: { code: number | null; signal: string | null; at: string } | undefined;
  lastError?: string | undefined;
  logs: string[];
}

interface TelegramGatewayResponse {
  path: string;
  exists: boolean;
  tokenConfigured: boolean;
  config: TelegramGatewaySettings;
  process: TelegramGatewayProcess;
}

interface TelegramDiscoveredUser {
  id: number;
  first_name?: string | undefined;
  last_name?: string | undefined;
  username?: string | undefined;
}

interface TelegramGatewayDashboardState {
  loading: boolean;
  saving: boolean;
  error?: string | undefined;
  message?: string | undefined;
  settings?: TelegramGatewayResponse | undefined;
  discovered: TelegramDiscoveredUser[];
}

class TelegramGatewayDashboard extends HTMLElement {
  private state: TelegramGatewayDashboardState = { loading: true, saving: false, discovered: [] };
  private pendingBotToken = "";

  connectedCallback(): void {
    this.attachShadow({ mode: "open" });
    void this.load();
  }

  get workspacePath(): string {
    return this.getAttribute("workspace-path") ?? "";
  }

  get machineId(): string {
    return this.getAttribute("machine-id") ?? "local";
  }

  get selectedSessionId(): string {
    return this.getAttribute("selected-session-id") ?? "";
  }

  async load(): Promise<void> {
    this.state = { ...this.state, loading: true, error: undefined, message: undefined };
    this.render();
    try {
      const value = await api<TelegramGatewayResponse>("/api/telegram-gateway");
      const config = { ...value.config };
      if (!value.exists || config.defaultCwd === "") config.defaultCwd = this.workspacePath;
      if (!value.exists) config.piWebBaseUrl = window.location.origin;
      if (config.machineId === "") config.machineId = this.machineId;
      this.state = { ...this.state, loading: false, settings: { ...value, config } };
    } catch (error) {
      this.state = { ...this.state, loading: false, error: formatError(error) };
    }
    this.render();
  }

  async save(successMessage = "Saved Telegram gateway settings."): Promise<boolean> {
    this.captureFormDraft();
    const body = this.readForm();
    if (body === undefined) return false;
    this.state = { ...this.state, saving: true, error: undefined, message: undefined };
    this.render();
    try {
      const value = await api<TelegramGatewayResponse>("/api/telegram-gateway", { method: "PUT", body });
      this.pendingBotToken = "";
      this.state = { ...this.state, saving: false, settings: value, message: successMessage };
      this.render();
      return true;
    } catch (error) {
      this.state = { ...this.state, saving: false, error: formatError(error) };
      this.render();
      return false;
    }
  }

  async saveBotToken(): Promise<void> {
    await this.save("Saved Telegram user bot tokens/settings.");
  }

  async start(): Promise<void> {
    if (!(await this.save())) return;
    await this.callAction("/api/telegram-gateway/start", "Gateway started.");
  }

  async stop(): Promise<void> {
    await this.callAction("/api/telegram-gateway/stop", "Gateway stop requested.");
  }

  async testToken(index: number): Promise<void> {
    const settings = this.captureFormDraft();
    const user = settings.config.users[index];
    if (user === undefined) return;
    this.state = { ...this.state, saving: true, error: undefined, message: undefined };
    this.render();
    try {
      const value = await api<{ bot?: { username?: string; first_name?: string } }>("/api/telegram-gateway/test-token", { method: "POST", body: { token: user.botToken ?? "", botId: user.botId } });
      const name = value.bot?.username === undefined ? value.bot?.first_name ?? "bot" : `@${value.bot.username}`;
      this.state = { ...this.state, saving: false, message: `Connected ${user.label ?? user.botLabel ?? "Telegram user"}'s bot to ${name}.` };
    } catch (error) {
      this.state = { ...this.state, saving: false, error: formatError(error) };
    }
    this.render();
  }

  async discoverUsers(index: number): Promise<void> {
    const settings = this.captureFormDraft();
    const user = settings.config.users[index];
    if (user === undefined) return;
    this.state = { ...this.state, saving: true, error: undefined, message: undefined };
    this.render();
    try {
      const value = await api<{ users: TelegramDiscoveredUser[] }>("/api/telegram-gateway/discover-users", { method: "POST", body: { token: user.botToken ?? "", botId: user.botId } });
      const nextSettings = this.currentSettings();
      const nextUser = nextSettings.config.users[index];
      const detected = value.users[0];
      if (nextUser !== undefined && value.users.length === 1 && detected !== undefined) {
        nextUser.telegramUserId = detected.id;
        nextUser.label = nextUser.label ?? userLabel(detected);
      }
      this.state = {
        ...this.state,
        saving: false,
        settings: nextSettings,
        discovered: value.users,
        message: value.users.length === 0 ? "No Telegram users found yet. Open Telegram, send /start to this bot, then click Detect again." : value.users.length === 1 && detected !== undefined ? `Found and filled Telegram user ${userLabel(detected)}.` : `Found ${String(value.users.length)} Telegram users. Copy the right numeric ID into this user row.`,
      };
    } catch (error) {
      this.state = { ...this.state, saving: false, error: formatError(error) };
    }
    this.render();
  }

  async callAction(path: string, message: string): Promise<void> {
    this.state = { ...this.state, saving: true, error: undefined, message: undefined };
    this.render();
    try {
      const value = await api<TelegramGatewayResponse>(path, { method: "POST" });
      this.state = { ...this.state, saving: false, settings: value, message };
    } catch (error) {
      this.state = { ...this.state, saving: false, error: formatError(error) };
    }
    this.render();
  }

  addUser(user?: TelegramDiscoveredUser): void {
    const settings = this.captureFormDraft();
    const id = user?.id ?? 0;
    const label = user === undefined ? "" : userLabel(user);
    settings.config.users = [...settings.config.users, { telegramUserId: id, label, botId: randomBotId(), botLabel: label || `Telegram user ${String(settings.config.users.length + 1)} bot`, cwd: this.workspacePath || settings.config.defaultCwd, admin: settings.config.users.length === 0, enabled: true }];
    this.state = { ...this.state, settings, message: undefined, error: undefined };
    this.render();
  }

  removeUser(index: number): void {
    const settings = this.captureFormDraft();
    settings.config.users = settings.config.users.filter((_user, userIndex) => userIndex !== index);
    this.state = { ...this.state, settings };
    this.render();
  }

  addCurrentWorkspaceToUser(index: number): void {
    const input = this.shadowRoot?.getElementById(`user-cwd-${String(index)}`);
    if (input instanceof HTMLInputElement && this.workspacePath !== "") input.value = this.workspacePath;
  }

  addSelectedSessionToUser(index: number): void {
    const input = this.shadowRoot?.getElementById(`user-session-${String(index)}`);
    if (input instanceof HTMLInputElement && this.selectedSessionId !== "") input.value = this.selectedSessionId;
  }

  currentSettings(): TelegramGatewayResponse {
    const existing = this.state.settings;
    if (existing !== undefined) return clone(existing);
    return {
      path: "~/.pi-web/telegram-gateway/config.json",
      exists: false,
      tokenConfigured: false,
      config: {
        piWebBaseUrl: window.location.origin,
        machineId: this.machineId,
        defaultCwd: this.workspacePath,
        workspaceAccessPath: "",
        statePath: "~/.pi-web/telegram-gateway/state.json",
        users: [],
      },
      process: { running: false, logs: [] },
    };
  }

  captureFormDraft(): TelegramGatewayResponse {
    const settings = this.currentSettings();
    if (this.shadowRoot === null) return settings;

    const tokenInput = this.shadowRoot.getElementById("bot-token");
    if (tokenInput instanceof HTMLInputElement) this.pendingBotToken = tokenInput.value.trim();

    const assignInput = (id: string, assign: (value: string) => void): void => {
      const input = this.shadowRoot?.getElementById(id);
      if (input instanceof HTMLInputElement) assign(input.value);
    };
    assignInput("piweb-base-url", (value) => { settings.config.piWebBaseUrl = value; });
    assignInput("machine-id", (value) => { settings.config.machineId = value; });
    assignInput("default-cwd", (value) => { settings.config.defaultCwd = value; });
    assignInput("workspace-access-path", (value) => { settings.config.workspaceAccessPath = value; });
    assignInput("state-path", (value) => { settings.config.statePath = value; });

    if (this.shadowRoot.getElementById("add-user") !== null) {
      const rows = [...this.shadowRoot.querySelectorAll("[data-user-row]")];
      settings.config.users = rows.flatMap((row) => {
        if (!(row instanceof HTMLElement)) return [];
        const idText = inputValue(row, "telegram-user-id").trim();
        const id = Number(idText);
        return [{
          telegramUserId: Number.isInteger(id) && id > 0 ? id : 0,
          label: inputValue(row, "telegram-user-label").trim() || undefined,
          cwd: inputValue(row, "telegram-user-cwd").trim() || undefined,
          sessionId: inputValue(row, "telegram-user-session").trim() || undefined,
          admin: checkboxValue(row, "telegram-user-admin"),
          botId: inputValue(row, "telegram-bot-id").trim() || randomBotId(),
          botLabel: inputValue(row, "telegram-bot-label").trim() || undefined,
          botToken: inputValue(row, "telegram-bot-token").trim() || undefined,
          botTokenConfigured: row.getAttribute("data-bot-token-configured") === "true",
          enabled: checkboxValue(row, "telegram-bot-enabled"),
        }];
      });
    }

    this.state = { ...this.state, settings };
    return settings;
  }

  readForm(): Record<string, unknown> | undefined {
    const defaultCwd = inputValue(this.shadowRoot, "default-cwd").trim();
    if (defaultCwd === "" || !defaultCwd.startsWith("/")) {
      this.state = { ...this.state, error: "Default workspace path must be absolute." };
      this.render();
      return undefined;
    }
    const rows = [...(this.shadowRoot?.querySelectorAll("[data-user-row]") ?? [])];
    const users: TelegramGatewayUser[] = [];
    for (const [index, row] of rows.entries()) {
      if (!(row instanceof HTMLElement)) continue;
      const idText = inputValue(row, "telegram-user-id").trim();
      const id = idText === "" ? 0 : Number(idText);
      if (!Number.isInteger(id) || id < 0) {
        this.state = { ...this.state, error: `Telegram user ${String(index + 1)} needs a numeric Telegram ID, or leave it blank until you detect it.` };
        this.render();
        return undefined;
      }
      const cwd = inputValue(row, "telegram-user-cwd").trim() || defaultCwd;
      if (!cwd.startsWith("/")) {
        this.state = { ...this.state, error: `Workspace path for Telegram ID ${String(id)} must be absolute.` };
        this.render();
        return undefined;
      }
      users.push({
        telegramUserId: id,
        label: inputValue(row, "telegram-user-label").trim() || undefined,
        cwd,
        sessionId: inputValue(row, "telegram-user-session").trim() || undefined,
        admin: checkboxValue(row, "telegram-user-admin"),
        botId: inputValue(row, "telegram-bot-id").trim() || randomBotId(),
        botLabel: inputValue(row, "telegram-bot-label").trim() || undefined,
        botToken: inputValue(row, "telegram-bot-token").trim() || undefined,
        enabled: checkboxValue(row, "telegram-bot-enabled"),
      });
    }
    return {
      telegramBotToken: inputValue(this.shadowRoot, "bot-token").trim(),
      piWebBaseUrl: inputValue(this.shadowRoot, "piweb-base-url").trim() || "http://127.0.0.1:8504",
      machineId: inputValue(this.shadowRoot, "machine-id").trim() || "local",
      defaultCwd,
      workspaceAccessPath: inputValue(this.shadowRoot, "workspace-access-path").trim(),
      statePath: inputValue(this.shadowRoot, "state-path").trim() || "~/.pi-web/telegram-gateway/state.json",
      users,
    };
  }

  render(): void {
    if (this.shadowRoot === null) return;
    const settings = this.currentSettings();
    const process = settings.process;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; color:var(--pi-text, #e5e7eb); }
        .wrap { display:grid; gap:14px; padding:2px; }
        .card { border:1px solid var(--pi-border, #374151); border-radius:12px; background:var(--pi-surface, #111827); padding:14px; }
        .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .user { display:grid; gap:8px; margin-top:10px; padding-top:10px; border-top:1px solid var(--pi-border, #374151); }
        button { border:1px solid var(--pi-border, #374151); border-radius:8px; background:var(--pi-surface-hover, #1f2937); color:inherit; padding:7px 10px; cursor:pointer; }
        button.primary { border-color:var(--pi-accent-border, #60a5fa); color:var(--pi-accent, #93c5fd); }
        button.danger { border-color:var(--pi-danger, #ef4444); color:var(--pi-danger, #f87171); }
        button:disabled { opacity:.55; cursor:not-allowed; }
        input { width:100%; box-sizing:border-box; border:1px solid var(--pi-border, #374151); border-radius:8px; background:var(--pi-bg, #030712); color:inherit; padding:8px; }
        label { display:grid; gap:5px; font-size:12px; color:var(--pi-text-secondary, #9ca3af); }
        code { color:var(--pi-accent, #93c5fd); }
        pre { white-space:pre-wrap; max-height:180px; overflow:auto; }
        .muted { color:var(--pi-text-secondary, #9ca3af); }
        .error { border-color:var(--pi-danger, #ef4444); color:var(--pi-danger, #f87171); }
        .ok { color:var(--pi-success, #34d399); }
        .pill { border:1px solid var(--pi-border, #374151); border-radius:999px; padding:2px 8px; }
        @media (max-width: 820px) { .grid { grid-template-columns:1fr; } }
      </style>
      <div class="wrap">
        <div class="card">
          <div class="row">
            <strong>Telegram Gateway</strong>
            <span class="pill ${process.running ? "ok" : "muted"}">${process.running ? `running${process.pid === undefined ? "" : ` · pid ${String(process.pid)}`}` : "stopped"}</span>
            <span class="pill ${settings.tokenConfigured ? "ok" : "muted"}">${settings.tokenConfigured ? "bot token saved" : "bot token needed"}</span>
            ${this.state.saving ? `<span class="muted">working…</span>` : ""}
          </div>
          <p class="muted">Config file: <code>${escapeHtml(settings.path)}</code> · ${settings.exists ? "exists" : "will be created on save"}</p>
          <p class="muted">Current workspace: <code>${escapeHtml(this.workspacePath)}</code></p>
          ${this.state.error === undefined ? "" : `<p class="card error">${escapeHtml(this.state.error)}</p>`}
          ${this.state.message === undefined ? "" : `<p class="card ok">${escapeHtml(this.state.message)}</p>`}
          <div class="row">
            <button id="refresh">Refresh</button>
            <button id="save" class="primary">Save all settings</button>
            <button id="start" class="primary">Save & start gateway</button>
            <button id="stop" class="danger">Stop gateway</button>
          </div>
        </div>
        ${this.state.loading ? `<p class="muted">Loading…</p>` : `
          <div class="card">
            <h3>1. Gateway settings</h3>
            <div class="grid">
              <label>PI WEB base URL<input id="piweb-base-url" value="${escapeAttr(settings.config.piWebBaseUrl)}" /></label>
              <label>Machine ID<input id="machine-id" value="${escapeAttr(settings.config.machineId || this.machineId)}" /></label>
              <label>Default workspace<input id="default-cwd" value="${escapeAttr(settings.config.defaultCwd || this.workspacePath)}" /></label>
              <label>State file<input id="state-path" value="${escapeAttr(settings.config.statePath)}" /></label>
            </div>
            <label style="margin-top:10px">Advanced / optional workspace access map <span class="muted">dashboard auth is separate; leave this blank unless you intentionally want shared workspace ACLs</span><input id="workspace-access-path" value="${escapeAttr(settings.config.workspaceAccessPath)}" placeholder="~/.pi-web/workspace-access.json" /></label>
          </div>
          <div class="card">
            <div class="row"><h3 style="margin-right:auto">2. Allowed Telegram users</h3><button id="add-user" class="primary">Add Telegram user</button></div>
            <p class="muted">Each row is an actual Telegram user. Add their numeric Telegram ID, attach the BotFather token for that user's bot, and bind them to a workspace. Session ID is optional: leave it blank and the gateway will create/remember a session when the user sends /new or their first message.</p>
            ${settings.config.users.length === 0 ? `<p class="muted">No Telegram users yet. Add a user, paste the bot token for their bot, then have them send /start to that bot and click Detect.</p>` : settings.config.users.map((user, index) => this.renderUser(user, index)).join("")}
            <div class="row" style="margin-top:10px"><button id="save-users" class="primary">Save Telegram users/settings</button><button id="start-users" class="primary">Save & start gateway</button></div>
            ${this.renderDiscoveredUsers()}
          </div>
          <div class="card">
            <h3>Gateway logs</h3>
            ${process.lastExit === undefined ? "" : `<p class="muted">Last exit: code=${String(process.lastExit.code)} signal=${String(process.lastExit.signal)} at ${escapeHtml(process.lastExit.at)}</p>`}
            ${process.lastError === undefined ? "" : `<p class="error">${escapeHtml(process.lastError)}</p>`}
            <pre><code>${escapeHtml(process.logs.join("\n") || "No gateway output yet.")}</code></pre>
          </div>
        `}
      </div>
    `;
    this.bindEvents();
  }

  renderDiscoveredUsers(): string {
    if (this.state.discovered.length === 0) return "";
    return `
      <div style="margin-top:10px" class="row">
        ${this.state.discovered.map((user) => `<button data-add-discovered="${String(user.id)}">Add ${escapeHtml(userLabel(user))} <code>${String(user.id)}</code></button>`).join("")}
      </div>
    `;
  }

  renderUser(user: TelegramGatewayUser, index: number): string {
    const title = user.label ?? user.botLabel ?? `Telegram user ${String(index + 1)}`;
    return `
      <div class="user" data-user-row data-bot-token-configured="${user.botTokenConfigured === true ? "true" : "false"}">
        <div class="row"><strong>${escapeHtml(title)}</strong><span class="pill ${user.botTokenConfigured === true ? "ok" : "muted"}">${user.botTokenConfigured === true ? "token saved" : "token needed"}</span><button data-remove-user="${String(index)}" class="danger">Remove</button></div>
        <input data-field="telegram-bot-id" type="hidden" value="${escapeAttr(user.botId ?? randomBotId())}" />
        <div class="grid">
          <label>Telegram user label<input data-field="telegram-user-label" value="${escapeAttr(user.label ?? "")}" placeholder="Nick / Alice / Bob" /></label>
          <label>Telegram numeric ID<input data-field="telegram-user-id" value="${user.telegramUserId === 0 ? "" : String(user.telegramUserId)}" inputmode="numeric" placeholder="Click Detect after they send /start" /></label>
          <label>BotFather token for this user's bot<input data-field="telegram-bot-token" type="password" autocomplete="off" value="${escapeAttr(user.botToken ?? "")}" placeholder="${user.botTokenConfigured === true ? "Saved — paste a new token only to replace it" : "123456:ABC..."}" /></label>
          <label>Bot label <span class="muted">optional</span><input data-field="telegram-bot-label" value="${escapeAttr(user.botLabel ?? user.label ?? "")}" placeholder="Will onboarding bot / Customer A" /></label>
          <label>Workspace path<input id="user-cwd-${String(index)}" data-field="telegram-user-cwd" value="${escapeAttr(user.cwd ?? this.workspacePath)}" /></label>
          <label>PI WEB session ID <span class="muted">optional; leave blank for /new auto-create</span><input id="user-session-${String(index)}" data-field="telegram-user-session" value="${escapeAttr(user.sessionId ?? "")}" placeholder="Leave blank for /new" /></label>
          <label class="row" style="align-content:end"><input data-field="telegram-user-admin" type="checkbox" ${user.admin === true ? "checked" : ""} style="width:auto" /> Telegram admin commands (/setcwd)</label>
          <label class="row" style="align-content:end"><input data-field="telegram-bot-enabled" type="checkbox" ${user.enabled === false ? "" : "checked"} style="width:auto" /> Enabled</label>
        </div>
        <div class="row"><button data-test-user-bot="${String(index)}">Test attached bot token</button><button data-detect-user-bot="${String(index)}">Detect this user's ID from /start</button><button data-current-workspace="${String(index)}">Use current workspace</button><button data-selected-session="${String(index)}" ${this.selectedSessionId === "" ? "disabled" : ""}>Use selected existing session</button></div>
      </div>
    `;
  }

  bindEvents(): void {
    this.shadowRoot?.getElementById("refresh")?.addEventListener("click", () => { void this.load(); });
    this.shadowRoot?.getElementById("save")?.addEventListener("click", () => { void this.save(); });
    this.shadowRoot?.getElementById("start")?.addEventListener("click", () => { void this.start(); });
    this.shadowRoot?.getElementById("stop")?.addEventListener("click", () => { void this.stop(); });
    this.shadowRoot?.getElementById("save-token")?.addEventListener("click", () => { void this.saveBotToken(); });
    this.shadowRoot?.getElementById("save-users")?.addEventListener("click", () => { void this.save(); });
    this.shadowRoot?.getElementById("start-users")?.addEventListener("click", () => { void this.start(); });
    this.shadowRoot?.getElementById("add-user")?.addEventListener("click", () => { this.addUser(); });
    for (const button of this.shadowRoot?.querySelectorAll("[data-remove-user]") ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      button.addEventListener("click", () => { this.removeUser(Number(button.getAttribute("data-remove-user"))); });
    }
    for (const button of this.shadowRoot?.querySelectorAll("[data-test-user-bot]") ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      button.addEventListener("click", () => { void this.testToken(Number(button.getAttribute("data-test-user-bot"))); });
    }
    for (const button of this.shadowRoot?.querySelectorAll("[data-detect-user-bot]") ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      button.addEventListener("click", () => { void this.discoverUsers(Number(button.getAttribute("data-detect-user-bot"))); });
    }
    for (const button of this.shadowRoot?.querySelectorAll("[data-current-workspace]") ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      button.addEventListener("click", () => { this.addCurrentWorkspaceToUser(Number(button.getAttribute("data-current-workspace"))); });
    }
    for (const button of this.shadowRoot?.querySelectorAll("[data-selected-session]") ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      button.addEventListener("click", () => { this.addSelectedSessionToUser(Number(button.getAttribute("data-selected-session"))); });
    }
    for (const button of this.shadowRoot?.querySelectorAll("[data-add-discovered]") ?? []) {
      button.addEventListener("click", () => {
        if (!(button instanceof HTMLElement)) return;
        const id = Number(button.getAttribute("data-add-discovered"));
        const user = this.state.discovered.find((candidate) => candidate.id === id);
        this.addUser(user);
      });
    }
  }
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", cache: "no-store" };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- API callers supply the expected response shape.
  const value: T = await response.json();
  if (!response.ok) throw new Error(errorMessageFromResponse(value) ?? `HTTP ${String(response.status)}`);
  return value;
}

function errorMessageFromResponse(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = Reflect.get(value, "error");
  return typeof error === "string" ? error : undefined;
}

function inputValue(root: ParentNode | null | undefined, idOrField: string): string {
  const byId = root?.querySelector(`#${CSS.escape(idOrField)}`);
  const byField = root?.querySelector(`[data-field="${cssString(idOrField)}"]`);
  const input = byId ?? byField;
  return input instanceof HTMLInputElement ? input.value : "";
}

function checkboxValue(root: ParentNode | null | undefined, field: string): boolean {
  const input = root?.querySelector(`[data-field="${cssString(field)}"]`);
  return input instanceof HTMLInputElement && input.checked;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function userLabel(user: TelegramDiscoveredUser): string {
  const handle = user.username === undefined ? "" : `@${user.username}`;
  const name = [user.first_name, user.last_name].filter((part): part is string => part !== undefined && part !== "").join(" ");
  return handle !== "" ? handle : name !== "" ? name : String(user.id);
}

function selectedSessionId(session: unknown): string {
  if (typeof session !== "object" || session === null || !("id" in session)) return "";
  const id = Reflect.get(session, "id");
  return typeof id === "string" ? id : "";
}

function randomBotId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `bot-${crypto.randomUUID()}`;
  return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cssString(value: string): string {
  return CSS.escape(value).replaceAll('"', '\\"');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/gu, "&#39;");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (!customElements.get("telegram-gateway-dashboard")) {
  customElements.define("telegram-gateway-dashboard", TelegramGatewayDashboard);
}

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Telegram Gateway",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "gateway.open",
          title: "Open Telegram Gateway Panel",
          description: "Configure and run the Telegram-to-PI-WEB gateway from the browser.",
          group: "Integrations",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => { context.selectWorkspaceTool("telegram-gateway:workspace.telegram"); },
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
          render: ({ workspace, machine, state }) => html`
            <section class="toolbar"><strong>Telegram Gateway</strong></section>
            <section class="viewer">
              <telegram-gateway-dashboard workspace-path=${workspace.path} machine-id=${machine.id} selected-session-id=${selectedSessionId(state?.selectedSession)}></telegram-gateway-dashboard>
            </section>
          `,
        },
      ],
    },
  }),
};

export default plugin;
