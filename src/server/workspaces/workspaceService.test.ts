import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "./workspaceService.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-workspaces-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceService", () => {
  it("keeps a project subdirectory rooted at the project path instead of the parent Git root", async () => {
    const root = await tempRoot();
    const repo = join(root, "repo");
    const projectPath = join(repo, "workspaces", "generated-workspaces");
    await mkdir(projectPath, { recursive: true });
    await git(["init", repo]);

    const workspaces = await new WorkspaceService().list({ id: "generated", name: "Generated", path: projectPath, createdAt: "2026-06-29T00:00:00.000Z" });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      projectId: "generated",
      path: projectPath,
      isMain: true,
      isGitRepo: true,
      isGitWorktree: true,
      gitWorktreeRoot: repo,
    });
  });

  it("maps linked Git worktrees to the same project-relative subdirectory", async () => {
    const root = await tempRoot();
    const repo = join(root, "repo");
    const linkedWorktree = join(root, "repo-feature");
    const relativeProjectPath = join("apps", "site");
    const projectPath = join(repo, relativeProjectPath);
    const linkedProjectPath = join(linkedWorktree, relativeProjectPath);
    await mkdir(projectPath, { recursive: true });
    await git(["init", repo]);
    await writeFile(join(projectPath, "package.json"), "{}\n");
    await git(["-C", repo, "add", "."]);
    await git(["-C", repo, "-c", "user.name=PI WEB", "-c", "user.email=pi-web@example.test", "commit", "-m", "init"]);
    await git(["-C", repo, "worktree", "add", linkedWorktree, "-b", "feature"]);

    const workspaces = await new WorkspaceService().list({ id: "site", name: "Site", path: projectPath, createdAt: "2026-06-29T00:00:00.000Z" });

    expect(workspaces.map((workspace) => workspace.path).sort()).toEqual([projectPath, linkedProjectPath].sort());
    expect(workspaces.find((workspace) => workspace.path === projectPath)).toMatchObject({ isMain: true, gitWorktreeRoot: repo });
    expect(workspaces.find((workspace) => workspace.path === linkedProjectPath)).toMatchObject({
      isMain: false,
      branch: "feature",
      gitWorktreeRoot: linkedWorktree,
    });
  });
});

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { env: cleanGitEnv() });
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) Reflect.deleteProperty(env, key);
  return env;
}

