import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import { ACTIONS_CONFIG_PATH, type WorkspaceAction } from "./config.js";
import { createWorkspaceTerminal, sendTerminalCommand } from "./terminalDispatcher.js";
import { requestPiWebRender } from "./piWebPrivateUi.js";
import { actionsConfigRefreshHint, actionsConfigUnavailableMessage, loadWorkspaceActionsConfig, type WorkspaceActionsConfigLoadResult } from "./workspaceActionsClient.js";

export const actionsPanelTagName = "pi-web-actions-panel";

export type OpenTerminal = (options?: { terminalId?: string | undefined }) => void;

const configChangedEvent = "pi-web-actions-config-changed";

type ConfigState =
  | { kind: "loading" }
  | WorkspaceActionsConfigLoadResult;

const configCache = new Map<string, ConfigState>();

export function defineActionsPanelElement(): void {
  if (!customElements.get(actionsPanelTagName)) customElements.define(actionsPanelTagName, PiWebActionsPanel);
}

export function actionsPanelBadge(workspace: Workspace): string | number | undefined {
  const state = getCachedWorkspaceConfig(workspace);
  if (state?.kind === "unavailable") return "!";
  if (state?.kind === "loaded" && state.config.actions.length > 0) return state.config.actions.length;
  return undefined;
}

class PiWebActionsPanel extends HTMLElement {
  private workspaceValue: Workspace | undefined;
  private openTerminalValue: OpenTerminal | undefined;
  private runningActionId: string | undefined;
  private status: { kind: "info" | "success" | "error"; message: string; detail?: string } | undefined;
  private readonly root: ShadowRoot;
  private readonly onConfigChanged = () => {
    this.render();
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  set workspace(value: Workspace | undefined) {
    this.workspaceValue = value;
    this.render();
  }

  set openTerminal(value: OpenTerminal | undefined) {
    this.openTerminalValue = value;
  }

  connectedCallback(): void {
    window.addEventListener(configChangedEvent, this.onConfigChanged);
    this.render();
  }

  disconnectedCallback(): void {
    window.removeEventListener(configChangedEvent, this.onConfigChanged);
  }

  private render(): void {
    const workspace = this.workspaceValue;
    if (workspace === undefined) {
      this.root.innerHTML = `${actionStyles()}<section class="empty">Select a workspace.</section>`;
      return;
    }

    const state = getOrLoadWorkspaceConfig(workspace);
    this.root.innerHTML = `
      ${actionStyles()}
      <section class="toolbar">
        <strong>Workspace Actions</strong>
        <span class="toolbar-actions">
          <button class="secondary" data-refresh-config ${state.kind === "loading" ? "disabled" : ""}>Refresh</button>
          <button class="secondary" data-open-terminal>Open Terminal</button>
        </span>
      </section>
      <section class="viewer actions-viewer">
        ${this.renderConfigState(state)}
      </section>
    `;

    this.root.querySelector("button[data-refresh-config]")?.addEventListener("click", () => {
      void this.refreshConfig(workspace);
    });

    for (const button of this.root.querySelectorAll("button[data-action-id]")) {
      button.addEventListener("click", () => {
        const action = actionFromConfigState(state, button.getAttribute("data-action-id"));
        if (action !== undefined) void this.dispatchAction(workspace, action);
      });
    }

    this.root.querySelector("button[data-open-terminal]")?.addEventListener("click", () => {
      this.openWorkspaceTerminal();
    });
  }

  private renderConfigState(state: ConfigState): string {
    if (state.kind === "loading") return `<p class="muted">Loading ${escapeHtml(ACTIONS_CONFIG_PATH)}…</p>${this.renderStatus()}`;
    if (state.kind === "missing") return `${renderMissingState(state)}${this.renderStatus()}`;
    if (state.kind === "unavailable") return `${renderUnavailableState(state)}${this.renderStatus()}`;
    if (state.config.actions.length === 0) return `<p class="muted">No actions are defined in ${escapeHtml(ACTIONS_CONFIG_PATH)}. Add actions to the file, then click Refresh.</p>${this.renderStatus()}`;
    return `
      <p class="muted">Actions create a new workspace terminal, send the command, then switch to that terminal. Edit ${escapeHtml(ACTIONS_CONFIG_PATH)} and click Refresh to reload.</p>
      ${renderActionGroups(state.config.actions, this.runningActionId)}
      ${this.renderStatus()}
    `;
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    const detail = this.status.detail === undefined ? "" : `<pre>${escapeHtml(this.status.detail)}</pre>`;
    return `<div class="status ${escapeAttr(this.status.kind)}">${escapeHtml(this.status.message)}${detail}</div>`;
  }

  private async refreshConfig(workspace: Workspace): Promise<void> {
    this.status = { kind: "info", message: `Refreshing ${ACTIONS_CONFIG_PATH}…` };
    configCache.set(cacheKeyForWorkspace(workspace), { kind: "loading" });
    this.render();

    const state = await refreshWorkspaceConfig(workspace);
    this.status = state.kind === "loaded"
      ? { kind: "success", message: `Loaded ${String(state.config.actions.length)} action${state.config.actions.length === 1 ? "" : "s"}.` }
      : undefined;
    this.render();
  }

  private async dispatchAction(workspace: Workspace, action: WorkspaceAction): Promise<void> {
    if (this.runningActionId !== undefined) return;
    if (action.confirm && !window.confirm(`Run ${action.title}?\n\n${action.command}`)) return;

    this.runningActionId = action.id;
    this.status = { kind: "info", message: `Creating terminal for ${action.title}…` };
    this.render();

    try {
      const terminal = await createWorkspaceTerminal(workspace, action.title);
      this.status = { kind: "info", message: `Dispatching command to ${terminal.name}…` };
      this.render();

      await sendTerminalCommand(workspace, terminal.id, action.command);
      this.status = {
        kind: "success",
        message: `Dispatched to terminal “${terminal.name}”.`,
        detail: action.command,
      };
      this.runningActionId = undefined;
      this.render();
      this.openWorkspaceTerminal(terminal.id);
    } catch (error) {
      this.runningActionId = undefined;
      this.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
      this.render();
    }
  }

  private openWorkspaceTerminal(terminalId?: string): void {
    if (this.openTerminalValue === undefined) {
      this.status = { kind: "error", message: "This Pi Web version does not provide terminal navigation to plugins." };
      this.render();
      return;
    }
    if (terminalId === undefined) this.openTerminalValue();
    else this.openTerminalValue({ terminalId });
  }
}

function getCachedWorkspaceConfig(workspace: Workspace): ConfigState | undefined {
  return configCache.get(cacheKeyForWorkspace(workspace));
}

function getOrLoadWorkspaceConfig(workspace: Workspace): ConfigState {
  const cached = getCachedWorkspaceConfig(workspace);
  if (cached !== undefined) return cached;

  const loading: ConfigState = { kind: "loading" };
  configCache.set(cacheKeyForWorkspace(workspace), loading);
  void refreshWorkspaceConfig(workspace);
  return loading;
}

async function refreshWorkspaceConfig(workspace: Workspace): Promise<ConfigState> {
  const key = cacheKeyForWorkspace(workspace);
  const state = await loadWorkspaceActionsConfig(workspace).catch((error: unknown): ConfigState => ({
    kind: "unavailable",
    message: actionsConfigUnavailableMessage,
    hint: actionsConfigRefreshHint,
    detail: error instanceof Error ? error.message : String(error),
  }));
  configCache.set(key, state);
  requestPiWebRender();
  window.dispatchEvent(new Event(configChangedEvent));
  return state;
}

function cacheKeyForWorkspace(workspace: Workspace): string {
  return `${workspace.projectId}:${workspace.id}`;
}

function renderMissingState(state: Extract<ConfigState, { kind: "missing" }>): string {
  return `<div class="empty-state"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p></div>`;
}

function renderUnavailableState(state: Extract<ConfigState, { kind: "unavailable" }>): string {
  const detail = state.detail === undefined ? "" : `<pre>${escapeHtml(state.detail)}</pre>`;
  return `<div class="status error"><strong>${escapeHtml(state.message)}</strong><p>${escapeHtml(state.hint)}</p>${detail}</div>`;
}

function renderActionGroups(actions: WorkspaceAction[], runningActionId: string | undefined): string {
  return `<div class="actions">${groupActions(actions).map((group) => renderActionGroup(group, runningActionId)).join("")}</div>`;
}

function groupActions(actions: WorkspaceAction[]): { title: string | undefined; actions: WorkspaceAction[] }[] {
  const groups: { title: string | undefined; actions: WorkspaceAction[] }[] = [];
  for (const action of actions) {
    const title = action.group;
    let group = groups.find((candidate) => candidate.title === title);
    if (group === undefined) {
      group = { title, actions: [] };
      groups.push(group);
    }
    group.actions.push(action);
  }
  return groups;
}

function renderActionGroup(group: { title: string | undefined; actions: WorkspaceAction[] }, runningActionId: string | undefined): string {
  const title = group.title === undefined ? "" : `<h3>${escapeHtml(group.title)}</h3>`;
  return `<section class="action-group">${title}${group.actions.map((action) => renderAction(action, runningActionId)).join("")}</section>`;
}

function renderAction(action: WorkspaceAction, runningActionId: string | undefined): string {
  const running = runningActionId === action.id;
  const disabled = runningActionId !== undefined;
  const description = action.description === undefined ? "" : `<span>${escapeHtml(action.description)}</span>`;
  return `
    <article class="action-card">
      <div class="action-copy">
        <strong>${escapeHtml(action.title)}</strong>
        ${description}
        <code>${escapeHtml(action.command)}</code>
      </div>
      <button data-action-id="${escapeAttr(action.id)}" ${disabled ? "disabled" : ""}>${running ? "Dispatching…" : "Run"}</button>
    </article>
  `;
}

function actionFromConfigState(state: ConfigState, actionId: string | null): WorkspaceAction | undefined {
  if (state.kind !== "loaded" || actionId === null) return undefined;
  return state.config.actions.find((action) => action.id === actionId);
}

function actionStyles(): string {
  return `
    <style>
      :host { display: contents; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .toolbar-actions { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .viewer { box-sizing: border-box; min-height: 0; overflow: auto; padding: 12px; }
      .actions-viewer { display: grid; align-content: start; gap: 12px; }
      .actions { display: grid; gap: 14px; }
      .action-group { display: grid; gap: 10px; }
      .action-group h3 { margin: 4px 0 0; color: var(--pi-text-secondary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
      .action-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
      .action-copy { display: grid; min-width: 0; gap: 5px; }
      .action-copy span, .muted { color: var(--pi-muted); }
      code, pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      code { overflow: auto; padding: 5px 7px; white-space: nowrap; }
      pre { margin: 8px 0 0; overflow: auto; padding: 8px; white-space: pre-wrap; }
      button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 10px; font: inherit; }
      button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
      button:disabled { cursor: wait; opacity: 0.65; }
      .empty-state { border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
      .empty-state p { margin: 6px 0 0; }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
      .status.success { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .empty { padding: 16px; color: var(--pi-muted); }
      @media (max-width: 760px) {
        .action-card { grid-template-columns: 1fr; }
        .action-card button { justify-self: start; }
      }
    </style>
  `;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
