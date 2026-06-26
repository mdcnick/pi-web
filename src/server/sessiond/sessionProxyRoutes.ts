import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { WorkspaceAccessController, workspaceAccessErrorStatus } from "../workspaceAccessPolicy.js";

export interface SessionProxyDaemon {
  request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  connectWebSocket(path: string): WebSocket;
}

export function registerSessionProxyRoutes(app: FastifyInstance, daemon: SessionProxyDaemon = new SessionDaemonClient(), prefix = "/api", workspaceAccess: WorkspaceAccessController = new WorkspaceAccessController({ enabled: false })): void {
  const proxy = async (request: { method: string; url: string; body?: unknown; headers?: Record<string, unknown> }, reply: FastifyReply) => {
    try {
      const upstream = await daemon.request(request.method, stripPrefix(request.url, prefix), request.body);
      reply.code(upstream.statusCode);
      const contentType = upstream.headers["content-type"];
      if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
      return upstream.body !== "" ? parseJson(upstream.body) : undefined;
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  };

  app.get(`${prefix}/sessiond/health`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/health` }, reply));
  app.get(`${prefix}/sessiond/runtime`, (_request, reply) => proxy({ method: "GET", url: `${prefix}/runtime` }, reply));

  app.get<{ Params: { sessionId: string }; Querystring: { cwd?: string } }>(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    try {
      requireProxyWorkspaceAccess(workspaceAccess, request, request.query.cwd);
      bridgeSockets(socket, daemon.connectWebSocket(stripPrefix(request.url, prefix)));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      socket.close();
    }
  });

  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket, request) => {
    if (!authorizeAdminSocket(workspaceAccess, request, socket)) return;
    bridgeSockets(socket, daemon.connectWebSocket("/sessions/events"));
  });

  app.get(`${prefix}/events`, { websocket: true }, (socket, request) => {
    if (!authorizeAdminSocket(workspaceAccess, request, socket)) return;
    bridgeSockets(socket, daemon.connectWebSocket("/events"));
  });

  app.all(`${prefix}/activity`, (request, reply) => {
    if (!authorizeAdmin(workspaceAccess, request, reply)) return;
    return proxy(request, reply);
  });
  app.all(`${prefix}/auth`, (request, reply) => {
    if (!authorizeAdmin(workspaceAccess, request, reply)) return;
    return proxy(request, reply);
  });
  app.all(`${prefix}/auth/*`, (request, reply) => {
    if (!authorizeAdmin(workspaceAccess, request, reply)) return;
    return proxy(request, reply);
  });
  app.all(`${prefix}/sessions`, (request, reply) => {
    if (!authorizeProxyWorkspace(workspaceAccess, request, reply)) return;
    return proxy(request, reply);
  });
  app.all(`${prefix}/sessions/*`, (request, reply) => {
    if (!authorizeProxyWorkspace(workspaceAccess, request, reply)) return;
    return proxy(request, reply);
  });
}

function authorizeAdmin(workspaceAccess: WorkspaceAccessController, request: FastifyRequest, reply: FastifyReply): boolean {
  try {
    workspaceAccess.requireAdmin(request);
    return true;
  } catch (error) {
    reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function authorizeAdminSocket(workspaceAccess: WorkspaceAccessController, request: FastifyRequest, socket: WebSocket): boolean {
  try {
    workspaceAccess.requireAdmin(request);
    return true;
  } catch (error) {
    socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    socket.close();
    return false;
  }
}

function authorizeProxyWorkspace(workspaceAccess: WorkspaceAccessController, request: FastifyRequest, reply: FastifyReply): boolean {
  try {
    requireProxyWorkspaceAccess(workspaceAccess, request, workspaceCwdFromRequest(request));
    return true;
  } catch (error) {
    reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function requireProxyWorkspaceAccess(workspaceAccess: WorkspaceAccessController, request: FastifyRequest, cwd: unknown): void {
  if (!workspaceAccess.isEnabled()) return;
  if (typeof cwd !== "string" || cwd === "") throw new Error("cwd is required when workspace auth is enabled");
  workspaceAccess.requireWorkspace(request, cwd);
}

function workspaceCwdFromRequest(request: FastifyRequest): unknown {
  const query = request.query;
  if (isRecord(query) && typeof query["cwd"] === "string") return query["cwd"];
  const body = request.body;
  if (isRecord(body) && typeof body["cwd"] === "string") return body["cwd"];
  return undefined;
}

function stripPrefix(url: string, prefix: string): string {
  const path = url.split("?", 1)[0] ?? url;
  const query = url.slice(path.length);
  const stripped = path.startsWith(prefix) ? `${path.slice(prefix.length)}${query}` : url;
  return stripped === "" ? "/" : stripped;
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestFailed(reply: FastifyReply, error: unknown): void {
  reply.code(502).send({ error: `Session daemon unavailable: ${error instanceof Error ? error.message : String(error)}` });
}

function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data) => { sendIfOpen(upstream, data); });
  upstream.on("message", (data) => { sendIfOpen(client, data); });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

function sendIfOpen(socket: WebSocket, data: RawData): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}
