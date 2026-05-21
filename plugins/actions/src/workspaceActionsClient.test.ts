import { describe, expect, it } from "vitest";
import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import { ACTIONS_CONFIG_PATH } from "./config";
import { loadWorkspaceActionsConfig, parseWorkspaceFileResponse, workspaceFileUrl, type FetchLike } from "./workspaceActionsClient";

const workspace: Workspace = {
  id: "workspace 1",
  projectId: "project/1",
  path: "/repo",
  label: "repo",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

describe("workspace actions client", () => {
  it("builds the private workspace file URL", () => {
    expect(workspaceFileUrl(workspace, ACTIONS_CONFIG_PATH)).toBe("/api/projects/project%2F1/workspaces/workspace%201/file?path=.pi-web%2Factions.json");
  });

  it("loads and parses a valid actions config", async () => {
    const fetcher: FetchLike = () => Promise.resolve(jsonResponse({
      content: JSON.stringify({ version: 1, actions: [{ id: "build", title: "Build", command: "npm run build" }] }),
      truncated: false,
      binary: false,
    }));

    await expect(loadWorkspaceActionsConfig(workspace, { fetch: fetcher })).resolves.toEqual({
      kind: "loaded",
      config: {
        version: 1,
        actions: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
    });
  });

  it("treats a missing optional actions config as unconfigured", async () => {
    const fetcher: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ error: "Path does not exist" }), { status: 400 }));

    await expect(loadWorkspaceActionsConfig(workspace, { fetch: fetcher })).resolves.toEqual({
      kind: "missing",
      message: "No workspace actions configured here.",
      hint: `${ACTIONS_CONFIG_PATH} is optional. Create it in this workspace if you want custom actions.`,
    });
  });

  it("returns a visible unavailable state instead of throwing on request failures", async () => {
    const fetcher: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));

    await expect(loadWorkspaceActionsConfig(workspace, { fetch: fetcher })).resolves.toMatchObject({
      kind: "unavailable",
      message: "Could not load workspace actions.",
      hint: `Fix ${ACTIONS_CONFIG_PATH}, then click Refresh.`,
      detail: `Unable to read ${ACTIONS_CONFIG_PATH}: HTTP 400: nope`,
    });
  });

  it("returns parser details for invalid config files", async () => {
    const fetcher: FetchLike = () => Promise.resolve(jsonResponse({
      content: JSON.stringify({ version: 2, actions: [] }),
      truncated: false,
      binary: false,
    }));

    await expect(loadWorkspaceActionsConfig(workspace, { fetch: fetcher })).resolves.toMatchObject({
      kind: "unavailable",
      detail: "Config version must be 1",
    });
  });

  it("validates workspace file responses", () => {
    expect(parseWorkspaceFileResponse({ content: "{}", truncated: false, binary: false })).toEqual({ content: "{}", truncated: false, binary: false });
    expect(parseWorkspaceFileResponse({ content: "{}", truncated: "no", binary: false })).toBeUndefined();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
