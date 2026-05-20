import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon, type ITerminalDimensions } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalSocket, terminalsApi, type TerminalInfo, type Workspace } from "../api";

const TERMINAL_OPTIONS_BASE: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
};

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 100, rows: 30 };

@customElement("terminal-panel")
export class TerminalPanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ type: Boolean }) autoStart = false;
  @query(".terminal-host") private terminalHost?: HTMLDivElement | null;
  @state() private terminals: TerminalInfo[] = [];
  @state() private selectedId: string | undefined;
  @state() private loading = false;
  @state() private error: string | undefined;
  @state() private visible = false;

  private terminal: Terminal | undefined;
  private fitAddon: FitAddon | undefined;
  private socket: WebSocket | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private themeObserver: MutationObserver | undefined;
  private suppressTerminalInput = false;
  private observedCwd: string | undefined;
  private loadedCwd: string | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.themeObserver = new MutationObserver(() => { this.applyTerminalTheme(); });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  }

  override firstUpdated(): void {
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.visible = entries[0]?.isIntersecting === true;
    });
    this.intersectionObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.disposeTerminalView();
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    const cwd = this.workspace?.path;
    if (cwd !== this.observedCwd) {
      this.observedCwd = cwd;
      this.loadedCwd = undefined;
      this.terminals = [];
      this.selectedId = undefined;
      this.disposeTerminalView();
    }
  }

  override updated(): void {
    this.loadVisibleWorkspaceTerminals();
    this.ensureTerminalView();
  }

  private loadVisibleWorkspaceTerminals(): void {
    const cwd = this.workspace?.path;
    if (!this.visible || cwd === undefined || cwd === this.loadedCwd) return;
    this.loadedCwd = cwd;
    void this.loadTerminals();
  }

  private async loadTerminals(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      if (this.workspace === undefined) return;
      const terminals = await terminalsApi.terminals(this.workspace.projectId, this.workspace.id);
      this.terminals = terminals;
      this.selectedId = terminals.find((terminal) => !terminal.exited)?.id ?? terminals[0]?.id;
      if (terminals.length === 0 && this.autoStart) await this.startTerminal();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async startTerminal(): Promise<void> {
    if (this.workspace === undefined) return;
    this.error = undefined;
    try {
      const size = this.measureTerminalSize() ?? DEFAULT_TERMINAL_SIZE;
      const terminal = await terminalsApi.startTerminal(this.workspace.projectId, this.workspace.id, size);
      this.terminals = [...this.terminals, terminal];
      this.selectTerminal(terminal.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async closeTerminal(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      if (this.workspace === undefined) return;
      await terminalsApi.closeTerminal(this.workspace.projectId, this.workspace.id, id);
      const next = this.terminals.filter((terminal) => terminal.id !== id);
      this.terminals = next;
      if (this.selectedId === id) {
        this.selectedId = next[0]?.id;
        this.disposeTerminalView();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private selectTerminal(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.disposeTerminalView();
  }

  private ensureTerminalView(): void {
    const workspace = this.workspace;
    const terminalHost = this.terminalHostElement();
    if (!this.visible || this.terminal !== undefined || this.selectedId === undefined || terminalHost === undefined || workspace === undefined) return;
    const terminal = new Terminal(terminalOptions(this));
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.resizeObserver = new ResizeObserver(() => { this.fitAndNotify(); });
    this.resizeObserver.observe(terminalHost);
    terminal.onData((data) => {
      if (this.suppressTerminalInput) return;
      const filtered = filterTerminalInput(data);
      if (filtered !== "") this.send({ type: "input", data: filtered });
    });
    const initialSize = this.fitTerminal();
    this.connectSocket(workspace.projectId, workspace.id, this.selectedId, terminal, initialSize);
    requestAnimationFrame(() => { this.fitAndNotify(); });
    terminal.focus();
  }

  private connectSocket(projectId: string, workspaceId: string, terminalId: string, terminal: Terminal, initialSize: TerminalSize | undefined): void {
    const socket = terminalSocket(projectId, workspaceId, terminalId, initialSize);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => { this.fitAndNotify(); });
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(event.data, terminalId, terminal);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }

  private async handleSocketMessage(data: unknown, terminalId: string, terminal: Terminal): Promise<void> {
    try {
      const message = parseServerMessage(await socketDataToString(data));
      if (message.type === "output") {
        this.writeTerminalOutput(terminal, message.data, message.replay === true);
      }
      if (message.type === "exit") {
        terminal.writeln(`\r\n[process exited${message.exitCode === undefined ? "" : ` with code ${String(message.exitCode)}`}]`);
        this.terminals = this.terminals.map((item) => item.id === terminalId ? { ...item, exited: true, ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }) } : item);
      }
      if (message.type === "error") terminal.writeln(`\r\n[terminal error: ${message.message}]`);
    } catch (error) {
      terminal.writeln(`\r\n[terminal error: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  private writeTerminalOutput(terminal: Terminal, data: string, replay: boolean): void {
    if (!replay) {
      terminal.write(data);
      return;
    }
    this.suppressTerminalInput = true;
    terminal.write(data, () => {
      this.suppressTerminalInput = false;
    });
  }

  private fitAndNotify(): void {
    const size = this.fitTerminal();
    if (size === undefined) return;
    this.send({ type: "resize", ...size });
  }

  private fitTerminal(): TerminalSize | undefined {
    if (this.fitAddon === undefined || this.terminal === undefined) return undefined;
    const dimensions = this.fitAddon.proposeDimensions();
    const size = terminalSizeFromDimensions(dimensions);
    if (size === undefined) return undefined;
    this.fitAddon.fit();
    return size;
  }

  private measureTerminalSize(): TerminalSize | undefined {
    const currentSize = this.fitTerminal();
    if (currentSize !== undefined) return currentSize;
    const terminalHost = this.terminalHostElement();
    if (this.terminal !== undefined || terminalHost === undefined) return undefined;

    const measuringTerminal = new Terminal(terminalOptions(this));
    const measuringFitAddon = new FitAddon();
    measuringTerminal.loadAddon(measuringFitAddon);
    measuringTerminal.open(terminalHost);
    const size = terminalSizeFromDimensions(measuringFitAddon.proposeDimensions());
    measuringTerminal.dispose();
    return size;
  }

  private terminalHostElement(): HTMLDivElement | undefined {
    const terminalHost = this.terminalHost;
    return terminalHost instanceof HTMLDivElement ? terminalHost : undefined;
  }

  private applyTerminalTheme(): void {
    if (this.terminal !== undefined) this.terminal.options.theme = terminalTheme(this);
  }

  private send(message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private disposeTerminalView(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.fitAddon = undefined;
  }

  override render() {
    return html`
      <section class="terminal-shell">
        <div class="terminal-tabs">
          ${this.terminals.map((terminal) => html`
            <button class=${this.selectedId === terminal.id ? "selected" : ""} @click=${() => { this.selectTerminal(terminal.id); }}>
              <span>${terminal.name}${terminal.exited ? " · exited" : ""}</span>
              <small @click=${(event: Event) => { void this.closeTerminal(terminal.id, event); }}>×</small>
            </button>
          `)}
          <button class="new" ?disabled=${this.workspace === undefined} @click=${() => { void this.startTerminal(); }}>+ Shell</button>
        </div>
        ${this.error === undefined ? null : html`<p class="error">${this.error}</p>`}
        ${this.loading ? html`<p class="muted">Loading terminals…</p>` : null}
        <div class="terminal-host"></div>
      </section>
    `;
  }

  static override styles = css`
    :host { flex: 1 1 auto; min-height: 0; display: flex; }
    .terminal-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--pi-terminal-bg); }
    .terminal-tabs { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; padding: 6px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); overflow: auto; }
    button { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 180px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
    button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    button.new { flex: 0 0 auto; color: var(--pi-muted); }
    button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button small { color: var(--pi-muted); font-size: 14px; line-height: 1; }
    button small:hover { color: var(--pi-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .terminal-host { flex: 1 1 auto; min-height: 0; padding: 6px; box-sizing: border-box; overflow: hidden; }
    .terminal-host .xterm { height: 100%; cursor: text; position: relative; user-select: none; }
    .terminal-host .xterm.focus, .terminal-host .xterm:focus { outline: none; }
    .terminal-host .xterm-helpers { position: absolute; top: 0; z-index: 5; }
    .terminal-host .xterm-helper-textarea { position: absolute !important; left: -9999em !important; top: 0 !important; width: 0 !important; height: 0 !important; min-width: 0 !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; margin: 0 !important; opacity: 0 !important; z-index: -5 !important; white-space: nowrap !important; overflow: hidden !important; resize: none !important; outline: 0 !important; appearance: none !important; }
    .terminal-host .xterm-viewport { position: absolute; inset: 0; overflow-y: scroll; cursor: default; background-color: var(--pi-terminal-bg); }
    .terminal-host .xterm-screen { position: relative; }
    .terminal-host .xterm-screen canvas { position: absolute; left: 0; top: 0; }
    .terminal-host .xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
    .terminal-host .xterm-accessibility:not(.debug), .terminal-host .xterm-message { position: absolute; inset: 0; z-index: 10; color: transparent; pointer-events: none; }
    .terminal-host .xterm-accessibility-tree:not(.debug) *::selection { color: transparent; }
    .terminal-host .xterm-accessibility-tree { font-family: monospace; user-select: text; white-space: pre; }
    .terminal-host .xterm-accessibility-tree > div { transform-origin: left; width: fit-content; }
    .terminal-host .live-region { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .error { flex: 0 0 auto; margin: 0; padding: 8px; color: var(--pi-danger); border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); }
    .muted { margin: 10px; color: var(--pi-muted); }
    .xterm { height: 100%; }
  `;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

type ServerTerminalMessage =
  | { type: "output"; data: string; replay?: boolean }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };

function parseServerMessage(data: string): ServerTerminalMessage {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value)) return { type: "error", message: "Invalid terminal message" };
  const record = value;
  if (record["type"] === "output" && typeof record["data"] === "string") return { type: "output", data: record["data"], ...(typeof record["replay"] === "boolean" ? { replay: record["replay"] } : {}) };
  if (record["type"] === "exit") return { type: "exit", ...(typeof record["exitCode"] === "number" ? { exitCode: record["exitCode"] } : {}) };
  if (record["type"] === "error" && typeof record["message"] === "string") return { type: "error", message: record["message"] };
  return { type: "error", message: "Invalid terminal message" };
}

export function filterTerminalInput(data: string): string {
  // Xterm can emit focus-in/focus-out sequences when replayed output leaves focus
  // tracking enabled. Bash/readline treats those sequences as typed text, which
  // leaves stray characters on the prompt after reconnecting to an active shell.
  return data.replaceAll("\x1b[I", "").replaceAll("\x1b[O", "");
}

async function socketDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}

function terminalOptions(element: HTMLElement): ITerminalOptions {
  return { ...TERMINAL_OPTIONS_BASE, theme: terminalTheme(element) };
}

function terminalTheme(element: HTMLElement): ITheme {
  return {
    background: themeColor(element, "--pi-terminal-bg", "#05070a"),
    foreground: themeColor(element, "--pi-terminal-text", "#e6edf3"),
    cursor: themeColor(element, "--pi-accent", "#58a6ff"),
    selectionBackground: themeColor(element, "--pi-terminal-selection", "#264f78"),
  };
}

function themeColor(element: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function terminalSizeFromDimensions(dimensions: ITerminalDimensions | undefined): TerminalSize | undefined {
  if (dimensions === undefined || !isValidTerminalSize(dimensions.cols, dimensions.rows)) return undefined;
  return { cols: Math.floor(dimensions.cols), rows: Math.floor(dimensions.rows) };
}

function isValidTerminalSize(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
