import type { TemplateResult } from "lit";
import type { AppAction } from "../actions";
import type { FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Workspace } from "../api";
import type { AppState } from "../appState";

export type PluginId = string;
export type LocalContributionId = string;
export type QualifiedContributionId = `${PluginId}:${LocalContributionId}`;

export interface PiWebPlugin {
  id: PluginId;
  name: string;
  activate: (context: PluginActivationContext) => PluginContributions;
}

export interface PluginActivationContext {
  apiVersion: 1;
}

export interface PluginContributions {
  actions?: PluginAction[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabelContributions?: WorkspaceLabelContribution[];
}

export interface PluginRuntimeContext {
  state: AppState;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  selectMainView: (view: AppState["mainView"]) => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}

export interface PluginAction {
  id: LocalContributionId;
  title: string;
  description?: string;
  shortcut?: string;
  group?: string;
  enabled?: boolean | ((context: PluginRuntimeContext) => boolean);
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}

export interface QualifiedPluginAction extends AppAction {
  pluginId: PluginId;
  localId: LocalContributionId;
}

export interface WorkspacePanelContext {
  workspace: Workspace;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  fileTreeStale: boolean;
  gitStatus: GitStatusResponse | undefined;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  gitStale: boolean;
  activeTerminalCount: number;
  terminalAutoStart: boolean;
  onRefreshFiles: () => void;
  onExpandDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefreshGit: () => void;
  onSelectDiff: (path: string) => void;
}

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  order?: number;
  visible?: (workspace: Workspace) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface QualifiedWorkspacePanelContribution extends WorkspacePanelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
}

export interface WorkspaceLabelContext {
  workspace: Workspace;
  state: AppState;
}

export type WorkspaceLabelItem = WorkspaceLabelTextItem | WorkspaceLabelLinkItem | WorkspaceLabelRenderItem;

export interface WorkspaceLabelTextItem {
  type: "text";
  text: string;
  title?: string;
}

export interface WorkspaceLabelLinkItem {
  type: "link";
  text: string;
  href: string;
  title?: string;
  target?: "_blank" | "_self";
}

export interface WorkspaceLabelRenderItem {
  type: "render";
  render: () => TemplateResult;
}

export interface WorkspaceLabelContribution {
  id: LocalContributionId;
  order?: number;
  visible?: (context: WorkspaceLabelContext) => boolean;
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem | WorkspaceLabelItem[] | undefined;
}

export interface QualifiedWorkspaceLabelContribution extends WorkspaceLabelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
}
