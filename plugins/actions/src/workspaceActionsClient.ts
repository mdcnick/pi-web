import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import { ACTIONS_CONFIG_PATH, parseActionsConfigText, type WorkspaceActionsConfig } from "./config.js";

export const actionsConfigMissingMessage = "No workspace actions configured here.";
export const actionsConfigMissingHint = `${ACTIONS_CONFIG_PATH} is optional. Create it in this workspace if you want custom actions.`;
export const actionsConfigUnavailableMessage = "Could not load workspace actions.";
export const actionsConfigRefreshHint = `Fix ${ACTIONS_CONFIG_PATH}, then click Refresh.`;

const missingWorkspaceFileError = "Path does not exist";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WorkspaceActionsConfigLoadResult =
  | { kind: "loaded"; config: WorkspaceActionsConfig }
  | { kind: "missing"; message: string; hint: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string };

interface WorkspaceFileResponse {
  content: string;
  truncated: boolean;
  binary: boolean;
}

export async function loadWorkspaceActionsConfig(
  workspace: Workspace,
  deps: { fetch: FetchLike } = { fetch: window.fetch.bind(window) },
): Promise<WorkspaceActionsConfigLoadResult> {
  let response: Response;
  try {
    response = await deps.fetch(workspaceFileUrl(workspace, ACTIONS_CONFIG_PATH), { cache: "no-store" });
  } catch (error) {
    return unavailable(`Unable to read ${ACTIONS_CONFIG_PATH}: ${formatUnknownError(error)}`);
  }

  if (!response.ok) {
    const errorMessage = await readResponseErrorMessage(response);
    if (errorMessage === missingWorkspaceFileError) return missing();
    const responseSummary = errorMessage === undefined ? `HTTP ${String(response.status)}` : `HTTP ${String(response.status)}: ${errorMessage}`;
    return unavailable(`Unable to read ${ACTIONS_CONFIG_PATH}: ${responseSummary}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return unavailable(`Invalid response while reading ${ACTIONS_CONFIG_PATH}: ${formatUnknownError(error)}`);
  }

  const file = parseWorkspaceFileResponse(body);
  if (file === undefined) return unavailable(`Invalid response while reading ${ACTIONS_CONFIG_PATH}`);
  if (file.binary) return unavailable(`${ACTIONS_CONFIG_PATH} must be a text file`);
  if (file.truncated) return unavailable(`${ACTIONS_CONFIG_PATH} is too large and was truncated`);

  const result = parseActionsConfigText(file.content);
  if (!result.ok) return unavailable(result.error);
  return { kind: "loaded", config: result.config };
}

export function workspaceFileUrl(workspace: Workspace, path: string): string {
  return `/api/projects/${encodeURIComponent(workspace.projectId)}/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(path)}`;
}

export function parseWorkspaceFileResponse(value: unknown): WorkspaceFileResponse | undefined {
  if (!isRecord(value)) return undefined;
  const content = value["content"];
  const truncated = value["truncated"];
  const binary = value["binary"];
  if (typeof content !== "string" || typeof truncated !== "boolean" || typeof binary !== "boolean") return undefined;
  return { content, truncated, binary };
}

function missing(): WorkspaceActionsConfigLoadResult {
  return {
    kind: "missing",
    message: actionsConfigMissingMessage,
    hint: actionsConfigMissingHint,
  };
}

function unavailable(detail: string): WorkspaceActionsConfigLoadResult {
  return {
    kind: "unavailable",
    message: actionsConfigUnavailableMessage,
    hint: actionsConfigRefreshHint,
    detail,
  };
}

async function readResponseErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return undefined;
    const error = body["error"];
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
