import { api as defaultApi } from "../api";
import type { Project, Workspace } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";


export interface ProjectWorkspaceController {
  selectProject(project: Project): Promise<void> | void;
  forgetProject(projectId: string): void;
  clearSelection(options?: { updateUrl?: boolean | undefined }): void;
}

export interface ProjectControllerDependencies {
  api?: Pick<typeof defaultApi, "projects" | "workspaces" | "addProject" | "closeProject">;
}
export class ProjectController {
  private readonly api: Pick<typeof defaultApi, "projects" | "workspaces" | "addProject" | "closeProject">;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly workspaces: ProjectWorkspaceController, deps: ProjectControllerDependencies = {}) {
    this.api = deps.api ?? defaultApi;
  }

  async loadProjects() {
    const machineId = selectedMachineId(this.getState());
    this.setState({ error: "", isLoadingProjects: true });
    try {
      const projects = await this.api.projects(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      const projectIds = new Set(projects.map((project) => project.id));
      const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([projectId]) => projectIds.has(projectId)));
      const selectedProject = this.getState().selectedProject;
      if (selectedProject !== undefined && !projectIds.has(selectedProject.id)) this.workspaces.clearSelection({ updateUrl: false });
      this.setState({ projects, workspacesByProjectId });
      await this.refreshWorkspaceCache(projects, machineId);
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    } finally {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ isLoadingProjects: false });
    }
  }

  async addProject(path: string, create?: boolean) {
    if (path.trim() === "") return;
    try {
      const project = await this.api.addProject(path.trim(), undefined, create, selectedMachineId(this.getState()));
      const projects = this.getState().projects;
      this.setState({ projects: [...projects.filter((p) => p.id !== project.id), project], projectDialogOpen: false });
      await this.workspaces.selectProject(project);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async closeProject(projectId: string) {
    try {
      await this.api.closeProject(projectId, selectedMachineId(this.getState()));
      this.workspaces.forgetProject(projectId);
      const state = this.getState();
      this.setState({ projects: state.projects.filter((p) => p.id !== projectId) });
      if (state.selectedProject?.id === projectId) this.workspaces.clearSelection();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async refreshWorkspaceCache(projects: Project[], machineId: string): Promise<void> {
    const cached = this.getState().workspacesByProjectId;
    const uncachedProjects = projects.filter((project) => cached[project.id] === undefined);
    if (uncachedProjects.length === 0) return;
    const entries = await Promise.all(uncachedProjects.map(async (project): Promise<readonly [string, Workspace[]] | undefined> => {
      try {
        return [project.id, await this.api.workspaces(project.id, machineId)];
      } catch {
        return undefined;
      }
    }));
    if (selectedMachineId(this.getState()) !== machineId) return;
    const currentProjectIds = new Set(this.getState().projects.map((project) => project.id));
    const next = { ...this.getState().workspacesByProjectId };
    for (const entry of entries) {
      if (entry === undefined) continue;
      const [projectId, workspaces] = entry;
      if (currentProjectIds.has(projectId)) next[projectId] = workspaces;
    }
    this.setState({ workspacesByProjectId: next });
  }
}
