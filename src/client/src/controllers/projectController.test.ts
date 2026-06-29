import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Project, Workspace } from "../api";
import { ProjectController, type ProjectWorkspaceController } from "./projectController";

function project(id: string, path: string): Project {
  return { id, path, name: id, createdAt: "2026-06-29T00:00:00.000Z" };
}

function workspace(id: string, owner: Project): Workspace {
  return {
    id,
    projectId: owner.id,
    path: `${owner.path}/${id}`,
    label: id,
    isMain: id === "main",
    isGitRepo: true,
    isGitWorktree: id !== "main",
  };
}

function stateHarness(initial: Partial<AppState> = {}) {
  let state: AppState = { ...initialAppState(), ...initial };
  return {
    getState: () => state,
    setState: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
  };
}

describe("ProjectController", () => {
  it("loads workspace caches for every visible project", async () => {
    const alpha = project("alpha", "/repos/alpha");
    const beta = project("beta", "/repos/beta");
    const alphaWorkspaces = [workspace("main", alpha), workspace("feature", alpha)];
    const betaWorkspaces = [workspace("main", beta)];
    const api = {
      projects: vi.fn(() => Promise.resolve([alpha, beta])),
      workspaces: vi.fn((projectId: string) => Promise.resolve(projectId === alpha.id ? alphaWorkspaces : betaWorkspaces)),
      addProject: vi.fn(),
      closeProject: vi.fn(),
    };
    const harness = stateHarness();
    const workspaces: ProjectWorkspaceController = { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() };
    const controller = new ProjectController(harness.getState, harness.setState, workspaces, { api });

    await controller.loadProjects();

    expect(harness.getState().projects).toEqual([alpha, beta]);
    expect(harness.getState().workspacesByProjectId).toEqual({
      [alpha.id]: alphaWorkspaces,
      [beta.id]: betaWorkspaces,
    });
    expect(api.workspaces).toHaveBeenCalledWith(alpha.id, "local");
    expect(api.workspaces).toHaveBeenCalledWith(beta.id, "local");
  });

  it("clears a selected project that disappeared from the project list", async () => {
    const stale = project("stale", "/repos/stale");
    const fresh = project("fresh", "/repos/fresh");
    const harness = stateHarness({ selectedProject: stale, workspacesByProjectId: { [stale.id]: [workspace("main", stale)] } });
    const clearSelection = vi.fn((options?: { updateUrl?: boolean }) => {
      harness.setState({ selectedProject: undefined, selectedWorkspace: undefined, workspaces: [] });
      expect(options).toEqual({ updateUrl: false });
    });
    const workspaces: ProjectWorkspaceController = { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection };
    const api = {
      projects: vi.fn(() => Promise.resolve([fresh])),
      workspaces: vi.fn(() => Promise.resolve([workspace("main", fresh)])),
      addProject: vi.fn(),
      closeProject: vi.fn(),
    };
    const controller = new ProjectController(harness.getState, harness.setState, workspaces, { api });

    await controller.loadProjects();

    expect(clearSelection).toHaveBeenCalledOnce();
    expect(harness.getState().selectedProject).toBeUndefined();
    expect(harness.getState().projects).toEqual([fresh]);
    expect(harness.getState().workspacesByProjectId).toEqual({ [fresh.id]: [workspace("main", fresh)] });
  });
});
