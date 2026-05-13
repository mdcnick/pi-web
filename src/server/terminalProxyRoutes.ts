import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import { SessionDaemonClient } from "./sessiond/sessionDaemonClient.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import { terminalSizeQuery } from "./terminals/terminalSize.js";
import { bridgeSockets } from "./webSocketBridge.js";

export function registerTerminalProxyRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, daemon = new SessionDaemonClient()): void {
  app.get<{ Params: { projectId: string; workspaceId: string } }>("/api/projects/:projectId/workspaces/:workspaceId/terminals", async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await proxyJson(daemon, "GET", `/terminals?cwd=${encodeURIComponent(context.root)}`, undefined, reply);
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Body: { name?: string; cols?: number; rows?: number } }>("/api/projects/:projectId/workspaces/:workspaceId/terminals", async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await proxyJson(daemon, "POST", "/terminals", { ...request.body, cwd: context.root }, reply);
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string; terminalId: string } }>("/api/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId", async (request, reply) => {
    try {
      await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await proxyJson(daemon, "DELETE", `/terminals/${encodeURIComponent(request.params.terminalId)}`, undefined, reply);
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string; terminalId: string }; Querystring: { cols?: string; rows?: string } }>("/api/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket", { websocket: true }, async (socket, request) => {
    try {
      await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const sizeQuery = terminalSizeQuery(request.query.cols, request.query.rows);
      bridgeSockets(socket, daemon.connectWebSocket(`/terminals/${request.params.terminalId}/socket${sizeQuery}`));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      socket.close();
    }
  });
}

async function proxyJson(daemon: SessionDaemonClient, method: string, path: string, body: unknown, reply: FastifyReply): Promise<unknown> {
  const upstream = await daemon.request(method, path, body);
  reply.code(upstream.statusCode);
  const contentType = upstream.headers["content-type"];
  if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
  const value: unknown = upstream.body !== "" ? JSON.parse(upstream.body) : undefined;
  return value;
}

function requestFailed(reply: FastifyReply, error: unknown): void {
  reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}

