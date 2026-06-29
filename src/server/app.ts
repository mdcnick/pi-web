import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ProjectStore } from "./storage/projectStore.js";
import { ProjectService } from "./projects/projectService.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { normalizeRequestCwd } from "./workingDirectory.js";
import { listDirectorySuggestions } from "./projects/directorySuggestions.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { registerSessionProxyRoutes, type SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { registerWorkspaceExplorerRoutes } from "./workspaceExplorerRoutes.js";
import { registerGitRoutes } from "./gitRoutes.js";
import { registerTerminalProxyRoutes } from "./terminalProxyRoutes.js";
import { registerWorkspaceDeletionRoutes } from "./workspaces/workspaceDeletionRoutes.js";
import { registerConfigRoutes, type PiWebConfigService } from "./configRoutes.js";
import { PiWebPluginService } from "./piWebPluginService.js";
import { createPiWebStatusCache } from "./piWebStatusCache.js";
import { getPiWebRuntime, getPiWebStatus, getPiWebVersionStatus } from "./piWebStatus.js";
import { MachineService } from "./machines/machineService.js";
import { registerMachineRoutes } from "./machines/machineRoutes.js";
import { registerMachineProxyRoutes } from "./machines/machineProxyRoutes.js";
import { proxyMachinePluginAsset, registerMachinePluginProxyRoutes } from "./machines/machinePluginProxyRoutes.js";
import { WorkspaceAccessController, workspaceAccessErrorStatus } from "./workspaceAccessPolicy.js";
import { registerWorkspaceAccessRoutes } from "./workspaceAccessRoutes.js";
import { registerJarvisRoutes } from "./jarvisRoutes.js";
import { registerTelegramGatewayRoutes } from "./telegramGatewayRoutes.js";
import { registerSystemResourceRoutes } from "./systemResourceRoutes.js";
import type { Project } from "./types.js";

export interface AppDependencies {
  projects?: ProjectService;
  workspaces?: WorkspaceService;
  machines?: MachineService;
  sessionDaemon?: SessionProxyDaemon;
  piWebPlugins?: Pick<PiWebPluginService, "manifest" | "plugins" | "readAsset">;
  config?: PiWebConfigService;
  workspaceAccess?: WorkspaceAccessController;
  clientDist?: string | false;
  logger?: FastifyServerOptions["logger"];
  /** Maximum accepted HTTP request body size in bytes. */
  bodyLimit?: number;
}

function registerLocalProjectRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, workspaceAccess: WorkspaceAccessController, prefix: string): void {
  app.get(`${prefix}/projects`, async (request, reply) => {
    try {
      if (!workspaceAccess.isEnabled()) return await projects.list();
      const user = workspaceAccess.requireUser(request);
      if (user.isAdmin) return await projects.list();
      const allProjects = await projects.list();
      const filtered: Project[] = [];
      for (const project of allProjects) {
        const projectWorkspaces = await workspaces.list(project);
        if (projectWorkspaces.some((workspace) => workspaceAccess.canAccessWorkspace(user, workspace.path))) filtered.push(project);
      }
      return filtered;
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { name?: string; path: string; create?: boolean } }>(`${prefix}/projects`, async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      return await projects.add(request.body);
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId`, async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      await projects.close(request.params.projectId);
      return { closed: true };
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { q?: string } }>(`${prefix}/project-directories`, async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      return await listDirectorySuggestions(request.query.q ?? "");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/workspaces`, async (request, reply) => {
    try {
      const project = await projects.requireProject(request.params.projectId);
      const list = await workspaces.list(project);
      if (!workspaceAccess.isEnabled()) return list;
      const user = workspaceAccess.requireUser(request);
      return list.filter((workspace) => workspaceAccess.canAccessWorkspace(user, workspace.path));
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function registerLocalFileSuggestionRoutes(app: FastifyInstance, workspaceAccess: WorkspaceAccessController, prefix: string): void {
  app.get<{ Querystring: { cwd?: string; q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path"; scope?: "tracked" | "all" } }>(`${prefix}/files`, async (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    try {
      const cwd = normalizeRequestCwd(request.query.cwd);
      workspaceAccess.requireWorkspace(request, cwd);
      if (request.query.mode === "path") return await listPathSuggestions(cwd, request.query.q ?? "");
      return await listFileSuggestions(cwd, request.query.q ?? "", { kind: request.query.kind, scope: request.query.scope });
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function buildApp(deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true, ...(deps.bodyLimit === undefined ? {} : { bodyLimit: deps.bodyLimit }) });
  await app.register(fastifyWebsocket);

  const projects = deps.projects ?? new ProjectService(new ProjectStore());
  const workspaces = deps.workspaces ?? new WorkspaceService();
  const piWebPlugins = deps.piWebPlugins ?? new PiWebPluginService();
  const sessionDaemon = deps.sessionDaemon ?? new SessionDaemonClient();
  const workspaceAccess = deps.workspaceAccess ?? new WorkspaceAccessController();
  const piWebStatusCache = createPiWebStatusCache(() => getPiWebStatus(sessionDaemon), {
    onError: (error) => { app.log.warn({ err: error }, "failed to refresh PI WEB status cache"); },
  });
  const machines = deps.machines ?? new MachineService(undefined, {
    localRuntime: () => getPiWebRuntime(sessionDaemon),
  });

  app.addHook("preHandler", (request, _reply, done) => {
    try {
      workspaceAccess.authenticateRequest(request);
      if (workspaceAccess.isEnabled()) {
        const path = request.url.split("?", 1)[0] ?? request.url;
        if (path === "/api/config"
          || path === "/api/system/resources"
          || path === "/api/machines/local/system/resources"
          || (path.startsWith("/api/machines") && !path.startsWith("/api/machines/local"))) {
          workspaceAccess.requireAdmin(request);
        }
      }
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });

  app.get("/pi-web-plugins/manifest.json", async () => piWebPlugins.manifest());

  app.get<{ Params: { pluginId: string; "*": string } }>("/pi-web-plugins/:pluginId/*", async (request, reply) => {
    if (await proxyMachinePluginAsset(machines, request.params.pluginId, request.params["*"], request.url, reply)) return;

    const asset = await piWebPlugins.readAsset(request.params.pluginId, request.params["*"]);
    if (asset === undefined) return reply.code(404).send({ error: "Plugin asset not found" });
    return reply.type(asset.contentType).send(asset.content);
  });

  app.get("/api/pi-web/status", async () => piWebStatusCache.get());
  app.get("/api/pi-web/version", async () => getPiWebVersionStatus(sessionDaemon));
  app.get("/api/pi-web/runtime", async () => getPiWebRuntime(sessionDaemon));
  app.get("/api/plugins", async () => piWebPlugins.plugins());
  registerWorkspaceAccessRoutes(app, workspaceAccess);
  registerJarvisRoutes(app, { projects, workspaces, sessionDaemon, workspaceAccess });
  registerTelegramGatewayRoutes(app, { workspaceAccess });
  registerConfigRoutes(app, deps.config);

  registerMachineRoutes(app, machines);
  registerMachinePluginProxyRoutes(app, machines);

  registerLocalProjectRoutes(app, projects, workspaces, workspaceAccess, "/api");
  registerLocalProjectRoutes(app, projects, workspaces, workspaceAccess, "/api/machines/local");

  registerSessionProxyRoutes(app, sessionDaemon, "/api", workspaceAccess);
  registerSessionProxyRoutes(app, sessionDaemon, "/api/machines/local", workspaceAccess);
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api", workspaceAccess);
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api/machines/local", workspaceAccess);
  registerGitRoutes(app, projects, workspaces, "/api", workspaceAccess);
  registerGitRoutes(app, projects, workspaces, "/api/machines/local", workspaceAccess);
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon, "/api", workspaceAccess);
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon, "/api/machines/local", workspaceAccess);
  registerWorkspaceDeletionRoutes(app, projects, workspaces, sessionDaemon, "/api", workspaceAccess);
  registerWorkspaceDeletionRoutes(app, projects, workspaces, sessionDaemon, "/api/machines/local", workspaceAccess);
  registerSystemResourceRoutes(app, "/api");
  registerSystemResourceRoutes(app, "/api/machines/local");

  registerLocalFileSuggestionRoutes(app, workspaceAccess, "/api");
  registerLocalFileSuggestionRoutes(app, workspaceAccess, "/api/machines/local");

  registerMachineProxyRoutes(app, machines);

  const packagedClientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
  const clientDist = deps.clientDist ?? (existsSync(packagedClientDist) ? packagedClientDist : join(process.cwd(), "dist", "client"));
  if (clientDist !== false && existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}
