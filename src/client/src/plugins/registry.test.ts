import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { corePlugin } from "./core";
import { PluginRegistry } from "./registry";
import type { PluginRuntimeContext } from "./types";

function createContext(statePatch: Partial<AppState> = {}) {
  const calls: string[] = [];
  const context: PluginRuntimeContext = {
    state: { ...initialAppState(), ...statePatch },
    openActionPalette: vi.fn(() => { calls.push("openActionPalette"); }),
    focusPrompt: vi.fn(() => { calls.push("focusPrompt"); }),
    addProject: vi.fn(() => { calls.push("addProject"); }),
    configureAuth: vi.fn(() => { calls.push("configureAuth"); }),
    logoutAuth: vi.fn(() => { calls.push("logoutAuth"); }),
    selectMainView: vi.fn((view: AppState["mainView"]) => { calls.push(`selectMainView:${view}`); }),
    selectWorkspaceTool: vi.fn((tool: AppState["workspaceTool"]) => { calls.push(`selectWorkspaceTool:${tool}`); }),
    refreshFiles: vi.fn(() => { calls.push("refreshFiles"); }),
    refreshGit: vi.fn(() => { calls.push("refreshGit"); }),
    startSession: vi.fn(() => { calls.push("startSession"); }),
    archiveSession: vi.fn(() => { calls.push("archiveSession"); }),
    stopActiveWork: vi.fn(() => { calls.push("stopActiveWork"); }),
  };
  return { context, calls };
}

describe("PluginRegistry", () => {
  it("namespaces contribution ids with the owning plugin id", () => {
    const registry = new PluginRegistry();
    registry.register(corePlugin);

    expect(registry.getActions(createContext().context).some((action) => action.id === "core:actions.show")).toBe(true);
    expect(registry.getWorkspacePanels().map((panel) => panel.id)).toEqual(["core:workspace.files", "core:workspace.git", "core:workspace.terminal"]);
  });

  it("rejects duplicate ids within the same namespace", () => {
    const registry = new PluginRegistry();

    expect(() => {
      registry.register({
        id: "example",
        name: "Example",
        activate: () => ({
          actions: [
            { id: "duplicate", title: "One", run: () => undefined },
            { id: "duplicate", title: "Two", run: () => undefined },
          ],
        }),
      });
    }).toThrow("Duplicate contribution id: example:duplicate");
  });

  it("evaluates core action enablement against runtime state", () => {
    const registry = new PluginRegistry();
    registry.register(corePlugin);

    const inactive = registry.getActions(createContext().context);
    const active = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context);

    expect(inactive.find((action) => action.id === "core:view.files")?.enabled).toBe(false);
    expect(active.find((action) => action.id === "core:view.files")?.enabled).toBe(true);
  });

  it("routes refresh current to the active core workspace panel", () => {
    const registry = new PluginRegistry();
    registry.register(corePlugin);
    const { context, calls } = createContext({
      selectedWorkspace: testWorkspace(),
      workspaceTool: "core:workspace.git",
    });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.refresh-current");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["refreshGit"]);
  });

  it("collects workspace label items in contribution order", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    registry.register({
      id: "example",
      name: "Example",
      activate: () => ({
        workspaceLabelContributions: [
          { id: "last", order: 20, items: () => ({ type: "text", text: "last" }) },
          { id: "hidden", order: 5, visible: () => false, items: () => ({ type: "text", text: "hidden" }) },
          { id: "first", order: 10, items: () => [{ type: "link", text: "web", href: "http://localhost:5173" }] },
        ],
      }),
    });

    expect(registry.getWorkspaceLabelItems(initialAppState(), workspace)).toEqual([
      { type: "link", text: "web", href: "http://localhost:5173" },
      { type: "text", text: "last" },
    ]);
  });
});

function testWorkspace(): Workspace {
  return { id: "w1", projectId: "p1", path: "/tmp/project", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
}
