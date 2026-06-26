import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { WorkspaceAccessController, workspaceAccessErrorStatus } from "./workspaceAccessPolicy.js";
import { normalizeRequestCwd } from "./workingDirectory.js";

export interface JarvisCommandResponse {
  text: string;
  mode: "brief" | "help" | "sessions" | "blocked" | "echo";
  speak: boolean;
  needsApproval?: boolean;
  details?: Record<string, unknown>;
}

interface JarvisCommandBody {
  text?: unknown;
  cwd?: unknown;
}

interface JarvisRoutesDeps {
  projects: ProjectService;
  workspaces: WorkspaceService;
  sessionDaemon: SessionProxyDaemon;
  workspaceAccess?: WorkspaceAccessController;
}

export function registerJarvisRoutes(app: FastifyInstance, deps: JarvisRoutesDeps): void {
  const workspaceAccess = deps.workspaceAccess ?? new WorkspaceAccessController({ enabled: false });

  app.get("/api/jarvis/status", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      return {
        ok: true,
        commands: ["help", "brief", "sessions"],
        note: "Jarvis v1 is a lightweight PI WEB voice command router. Risky actions are blocked until the approval queue is implemented.",
      };
    } catch (error) {
      return sendAccessError(reply, error);
    }
  });

  app.post<{ Body: JarvisCommandBody | undefined }>("/api/jarvis/command", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      const body = optionalRecord(request.body);
      const text = requireCommandText(body["text"]);
      const cwd = parseOptionalCwd(body["cwd"]);
      if (cwd !== undefined) workspaceAccess.requireWorkspace(request, cwd);
      return await handleJarvisCommand(text, cwd, deps, request);
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function handleJarvisCommand(text: string, cwd: string | undefined, deps: JarvisRoutesDeps, request: FastifyRequest): Promise<JarvisCommandResponse> {
  const normalized = text.toLowerCase();
  if (matches(normalized, ["help", "what can you do", "commands"])) return helpResponse();
  if (matches(normalized, ["spawn", "worker", "agent", "run command", "install", "deploy", "delete", "secret"])) return blockedResponse();
  if (matches(normalized, ["session", "sessions", "active"])) return await sessionsResponse(cwd, deps);
  if (matches(normalized, ["brief", "summary", "summarize", "status", "today", "workspace", "what are we working on"])) return await briefResponse(cwd, deps, request);
  return {
    mode: "echo",
    speak: true,
    text: `I heard: ${text}. Jarvis command routing is online, but v1 only supports briefings, session counts, and help.`,
  };
}

function helpResponse(): JarvisCommandResponse {
  return {
    mode: "help",
    speak: true,
    text: "Jarvis v1 can speak briefings, summarize the selected workspace, and count sessions. Spawning agents, writing memory, installs, deployments, and destructive actions will require the approval queue before I run them by voice.",
  };
}

function blockedResponse(): JarvisCommandResponse {
  return {
    mode: "blocked",
    speak: true,
    needsApproval: true,
    text: "That sounds like an action command. I am not running action commands from voice yet. The next step is the Jarvis approval queue, then I can ask you to approve or deny risky actions in PI WEB.",
  };
}

async function sessionsResponse(cwd: string | undefined, deps: JarvisRoutesDeps): Promise<JarvisCommandResponse> {
  if (cwd === undefined) {
    return {
      mode: "sessions",
      speak: true,
      text: "Select a workspace first, then ask me about sessions again.",
    };
  }
  const sessions = await daemonJson(deps.sessionDaemon, "GET", `/sessions?cwd=${encodeURIComponent(cwd)}`);
  const count = Array.isArray(sessions) ? sessions.length : 0;
  return {
    mode: "sessions",
    speak: true,
    text: count === 1 ? "There is one session in this workspace." : `There are ${String(count)} sessions in this workspace.`,
    details: { sessionCount: count },
  };
}

async function briefResponse(cwd: string | undefined, deps: JarvisRoutesDeps, request: FastifyRequest): Promise<JarvisCommandResponse> {
  const projects = await deps.projects.list();
  let visibleProjects = 0;
  let visibleWorkspaces = 0;
  for (const project of projects) {
    const workspaces = await deps.workspaces.list(project);
    const visible = workspaces.filter((workspace) => deps.workspaceAccess?.canAccessWorkspace(deps.workspaceAccess.requireUser(request), workspace.path) ?? true);
    if (visible.length > 0) visibleProjects += 1;
    visibleWorkspaces += visible.length;
  }

  const health = parseHealth(await daemonJson(deps.sessionDaemon, "GET", "/health").catch(() => undefined));
  const sessionText = typeof health.activeSessions === "number"
    ? `The session daemon reports ${String(health.activeSessions)} active ${health.activeSessions === 1 ? "session" : "sessions"}.`
    : "The session daemon status is not available right now.";
  const workspaceText = cwd === undefined ? "No workspace is selected." : `Selected workspace: ${cwd}.`;
  return {
    mode: "brief",
    speak: true,
    text: `${workspaceText} I can see ${String(visibleProjects)} projects and ${String(visibleWorkspaces)} workspaces. ${sessionText}`,
    details: { projectCount: visibleProjects, workspaceCount: visibleWorkspaces, selectedCwd: cwd, activeSessions: health.activeSessions },
  };
}

async function daemonJson(daemon: SessionProxyDaemon, method: string, path: string): Promise<unknown> {
  const response = await daemon.request(method, path);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Session daemon returned ${String(response.statusCode)}`);
  return response.body === "" ? undefined : JSON.parse(response.body);
}

function parseHealth(value: unknown): { activeSessions?: number } {
  if (!isRecord(value)) return {};
  return typeof value["activeSessions"] === "number" ? { activeSessions: value["activeSessions"] } : {};
}

function matches(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Request body must be an object");
  return value;
}

function requireCommandText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("text is required");
  return value.trim();
}

function parseOptionalCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("cwd must be a string");
  return normalizeRequestCwd(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendAccessError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
}
