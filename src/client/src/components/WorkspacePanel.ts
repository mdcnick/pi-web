import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Workspace } from "../api";
import type { AppState } from "../appState";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, WorkspaceLabelItem, WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";
import { renderWorkspaceLabel } from "./workspaceLabel";

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) appState!: AppState;
  @property() tool: QualifiedContributionId = "core:workspace.files";
  @property({ attribute: false }) panels: QualifiedWorkspacePanelContribution[] = [];
  @property({ attribute: false }) workspaceLabelItems: WorkspaceLabelItem[] = [];
  @property({ type: Boolean }) hideToolTabs = false;
  @property({ attribute: false }) fileTree: FileTreeEntry[] = [];
  @property({ attribute: false }) expandedDirs: Record<string, FileTreeEntry[]> = {};
  @property({ attribute: false }) selectedFilePath: string | undefined;
  @property({ attribute: false }) selectedFileContent: FileContentResponse | undefined;
  @property({ type: Boolean }) fileTreeStale = false;
  @property({ attribute: false }) gitStatus: GitStatusResponse | undefined;
  @property({ attribute: false }) selectedDiffPath: string | undefined;
  @property({ attribute: false }) selectedDiff: GitDiffResponse | undefined;
  @property({ attribute: false }) selectedStagedDiff: GitDiffResponse | undefined;
  @property({ type: Boolean }) gitStale = false;
  @property({ attribute: false }) onSelectTool: (tool: QualifiedContributionId) => void = () => undefined;
  @property({ attribute: false }) onRefreshFiles: () => void = () => undefined;
  @property({ attribute: false }) onExpandDir: (path: string) => void = () => undefined;
  @property({ attribute: false }) onSelectFile: (path: string) => void = () => undefined;
  @property({ attribute: false }) onRefreshGit: () => void = () => undefined;
  @property({ attribute: false }) onSelectDiff: (path: string) => void = () => undefined;
  @property({ type: Number }) activeTerminalCount = 0;
  @property({ type: Boolean }) terminalAutoStart = false;
  @query(".workspace-header-strip") private workspaceHeaderStrip?: HTMLElement | null;
  @state() private workspaceHeaderCanScrollLeft = false;
  @state() private workspaceHeaderCanScrollRight = false;

  private observedWorkspaceHeaderStrip: HTMLElement | undefined;
  private workspaceHeaderResizeObserver: ResizeObserver | undefined;
  private readonly onWorkspaceHeaderScroll = () => {
    this.updateWorkspaceHeaderScrollState();
  };

  override firstUpdated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override updated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override disconnectedCallback(): void {
    this.workspaceHeaderResizeObserver?.disconnect();
    this.workspaceHeaderResizeObserver = undefined;
    this.observedWorkspaceHeaderStrip = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const workspace = this.workspace;
    if (workspace === undefined) return html`<section class="empty">Select a workspace.</section>`;
    const visiblePanels = this.panels;
    const selectedPanel = visiblePanels.find((panel) => panel.id === this.tool) ?? visiblePanels[0];
    const context = this.createPanelContext(workspace);
    return html`
      <header>
        <div class=${this.workspaceHeaderFrameClass()}>
          <div class="workspace-header-strip" @scroll=${this.onWorkspaceHeaderScroll}>
            ${this.hideToolTabs ? null : html`
              <div class="tabs">
                ${visiblePanels.map((panel) => html`
                  <button class=${selectedPanel?.id === panel.id ? "selected" : ""} @click=${() => { this.onSelectTool(panel.id); }}>${this.renderPanelTitle(panel, context)}</button>
                `)}
              </div>
            `}
            <small>${renderWorkspaceLabel(workspace.label, this.workspaceLabelItems, workspace.path)}</small>
          </div>
        </div>
      </header>
      ${selectedPanel === undefined ? html`<section class="empty">No workspace panels registered.</section>` : html`
        <div class="panel-content">
          ${selectedPanel.render(context)}
        </div>
      `}
    `;
  }

  private renderPanelTitle(panel: QualifiedWorkspacePanelContribution, context: WorkspacePanelContext): TemplateResult {
    const badge = panel.badge?.(context);
    if (badge === undefined || badge === "") return html`${panel.title}`;
    return html`${panel.title} <span class="tab-badge">${badge}</span>`;
  }

  private workspaceHeaderFrameClass(): string {
    return `workspace-header-scroll-frame${this.workspaceHeaderCanScrollLeft ? " can-scroll-left" : ""}${this.workspaceHeaderCanScrollRight ? " can-scroll-right" : ""}`;
  }

  private observeWorkspaceHeaderStrip(): void {
    const strip = this.workspaceHeaderStripElement();
    if (this.observedWorkspaceHeaderStrip === strip) return;
    this.workspaceHeaderResizeObserver?.disconnect();
    this.observedWorkspaceHeaderStrip = strip;
    this.workspaceHeaderResizeObserver = undefined;
    if (strip === undefined || typeof ResizeObserver === "undefined") return;
    this.workspaceHeaderResizeObserver = new ResizeObserver(() => {
      this.updateWorkspaceHeaderScrollState();
    });
    this.workspaceHeaderResizeObserver.observe(strip);
  }

  private updateWorkspaceHeaderScrollState(): void {
    const strip = this.workspaceHeaderStripElement();
    const maxScrollLeft = strip === undefined ? 0 : Math.max(0, strip.scrollWidth - strip.clientWidth);
    const canScrollLeft = strip !== undefined && strip.scrollLeft > 1;
    const canScrollRight = strip !== undefined && maxScrollLeft - strip.scrollLeft > 1;
    if (this.workspaceHeaderCanScrollLeft !== canScrollLeft) this.workspaceHeaderCanScrollLeft = canScrollLeft;
    if (this.workspaceHeaderCanScrollRight !== canScrollRight) this.workspaceHeaderCanScrollRight = canScrollRight;
  }

  private workspaceHeaderStripElement(): HTMLElement | undefined {
    const strip = this.workspaceHeaderStrip;
    return strip instanceof HTMLElement ? strip : undefined;
  }

  private createPanelContext(workspace: Workspace): WorkspacePanelContext {
    return {
      workspace,
      state: this.appState,
      fileTree: this.fileTree,
      expandedDirs: this.expandedDirs,
      selectedFilePath: this.selectedFilePath,
      selectedFileContent: this.selectedFileContent,
      fileTreeStale: this.fileTreeStale,
      gitStatus: this.gitStatus,
      selectedDiffPath: this.selectedDiffPath,
      selectedDiff: this.selectedDiff,
      selectedStagedDiff: this.selectedStagedDiff,
      gitStale: this.gitStale,
      activeTerminalCount: this.activeTerminalCount,
      terminalAutoStart: this.terminalAutoStart,
      onRefreshFiles: this.onRefreshFiles,
      onExpandDir: this.onExpandDir,
      onSelectFile: this.onSelectFile,
      onRefreshGit: this.onRefreshGit,
      onSelectDiff: this.onSelectDiff,
    };
  }

  static override styles = workspacePanelStyles;
}
