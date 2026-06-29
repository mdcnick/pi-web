import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Project, Workspace } from "../types.js";
import { discoverGitWorktrees, gitTopLevel, isGitRepository } from "./gitWorktreeDiscovery.js";

const idFor = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 12);

export class WorkspaceService {
  async list(project: Project): Promise<Workspace[]> {
    const isGitRepo = await isGitRepository(project.path);
    if (!isGitRepo) {
      return [this.single(project, false)];
    }

    const gitRoot = await gitTopLevel(project.path);
    const worktrees = await discoverGitWorktrees(project.path);
    if (gitRoot === undefined || worktrees.length === 0) return [this.single(project, true)];

    const projectRelativePath = relative(gitRoot, project.path);
    const entries = await Promise.all(worktrees.map(async (worktree): Promise<Workspace | undefined> => {
      const workspacePath = projectRelativePath === "" ? worktree.path : join(worktree.path, projectRelativePath);
      if (!await isDirectory(workspacePath)) return undefined;
      const leafName = basename(workspacePath);
      const isMain = resolve(workspacePath) === resolve(project.path);
      const isSubdirectoryProject = resolve(workspacePath) !== resolve(worktree.path);
      return {
        id: idFor(`${project.id}:${workspacePath}`),
        projectId: project.id,
        path: workspacePath,
        label: worktree.branch ?? (worktree.detached === true ? "detached" : leafName === "" ? workspacePath : leafName),
        ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
        isMain,
        isGitRepo: true,
        isGitWorktree: true,
        ...(isSubdirectoryProject ? { gitWorktreeRoot: worktree.path } : {}),
      };
    }));
    const workspaces = entries.filter(isDefined);
    return workspaces.length === 0 ? [this.single(project, true)] : workspaces;
  }

  private single(project: Project, isGitRepo: boolean): Workspace {
    return {
      id: idFor(`${project.id}:${project.path}`),
      projectId: project.id,
      path: project.path,
      label: project.name,
      isMain: true,
      isGitRepo,
      isGitWorktree: false,
    };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}


function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
