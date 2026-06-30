import { readFile } from "node:fs/promises";
import http from "node:http";
import { isAbsolute, join } from "node:path";
import { getuid } from "node:process";
import { WebSocket } from "ws";
import { sessiondHttpUrl, sessiondSocketPath } from "./config.js";

export interface SessionDaemonEndpoint {
  baseUrl?: string;
  socketPath?: string;
}

export interface SessionDaemonTransport {
  request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  connectWebSocket(path: string): WebSocket;
}

export type SessionDaemonClientOptions = SessionDaemonEndpoint;

export class SessionDaemonClient implements SessionDaemonTransport {
  private readonly baseUrl: string | undefined;
  private readonly socketPath: string;

  constructor(options: SessionDaemonClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? sessiondHttpUrl();
    this.socketPath = options.socketPath ?? sessiondSocketPath();
  }

  async request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (this.baseUrl !== undefined && this.baseUrl !== "") return requestUrl(this.baseUrl, method, path, payload);
    return requestSocket(this.socketPath, method, path, payload);
  }

  connectWebSocket(path: string): WebSocket {
    if (this.baseUrl !== undefined && this.baseUrl !== "") return connectUrlWebSocket(this.baseUrl, path);
    return connectSocketWebSocket(this.socketPath, path);
  }
}

export interface WorkspaceOwnerLookup {
  uidForPath(path: string): Promise<number | undefined>;
  homeForUid(uid: number): Promise<string | undefined>;
}

export interface PerUserSessionDaemonClientOptions {
  fallback?: SessionDaemonTransport;
  lookup?: WorkspaceOwnerLookup;
  currentUid?: number;
  socketForHome?: (home: string) => string;
  clientForSocket?: (socketPath: string) => SessionDaemonTransport;
}

/**
 * Routes workspace-scoped session requests to the session daemon owned by the
 * workspace's Unix user. This keeps MCP/provider tokens isolated: a Nick-owned
 * PI WEB process must not service `/home/will/...` sessions with Nick's agent
 * dir, MCP config, or auth tokens. Non-workspace/admin requests continue to use
 * the fallback daemon because they are not tied to a workspace owner.
 */
export class PerUserSessionDaemonClient {
  private readonly fallback: SessionDaemonTransport;
  private readonly lookup: WorkspaceOwnerLookup;
  private readonly currentUid: number | undefined;
  private readonly socketForHome: (home: string) => string;
  private readonly createClientForSocket: (socketPath: string) => SessionDaemonTransport;
  private readonly clients = new Map<string, SessionDaemonTransport>();

  constructor(options: PerUserSessionDaemonClientOptions = {}) {
    this.fallback = options.fallback ?? new SessionDaemonClient();
    this.lookup = options.lookup ?? defaultWorkspaceOwnerLookup;
    this.currentUid = options.currentUid ?? getuid?.();
    this.socketForHome = options.socketForHome ?? ((home) => join(home, ".pi-web", "sessiond.sock"));
    this.createClientForSocket = options.clientForSocket ?? ((socketPath) => new SessionDaemonClient({ socketPath }));
  }

  async request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    return (await this.clientForRequest(path, body)).request(method, path, body);
  }

  connectWebSocket(path: string): WebSocket {
    const cwd = cwdFromRequest(path);
    if (cwd === undefined) return this.fallback.connectWebSocket(path);

    // WebSocket routing is synchronous by API shape. Use the conventional socket
    // path for the owning home when it can be inferred directly from /home/<user>,
    // otherwise fall back; HTTP requests still do full stat/passwd resolution.
    const home = homePrefixFromCwd(cwd);
    if (home === undefined) return this.fallback.connectWebSocket(path);
    const socketPath = this.socketForHome(home);
    return this.clientForSocket(socketPath).connectWebSocket(path);
  }

  private async clientForRequest(path: string, body: unknown): Promise<SessionDaemonTransport> {
    const cwd = cwdFromRequest(path, body);
    if (cwd === undefined) return this.fallback;
    const uid = await this.lookup.uidForPath(cwd);
    if (uid === undefined || uid === this.currentUid) return this.fallback;
    const home = await this.lookup.homeForUid(uid);
    if (home === undefined) throw new Error(`No home directory found for workspace owner uid ${String(uid)}`);
    return this.clientForSocket(this.socketForHome(home));
  }

  private clientForSocket(socketPath: string): SessionDaemonTransport {
    const existing = this.clients.get(socketPath);
    if (existing !== undefined) return existing;
    const client = this.createClientForSocket(socketPath);
    this.clients.set(socketPath, client);
    return client;
  }
}

const defaultWorkspaceOwnerLookup: WorkspaceOwnerLookup = {
  async uidForPath(path: string): Promise<number | undefined> {
    if (!isAbsolute(path)) return undefined;
    const { stat } = await import("node:fs/promises");
    try {
      return (await stat(path)).uid;
    } catch {
      return undefined;
    }
  },
  async homeForUid(uid: number): Promise<string | undefined> {
    const passwd = await readFile("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 6 && Number(fields[2]) === uid) return fields[5];
    }
    return undefined;
  },
};

function cwdFromRequest(path: string, body?: unknown): string | undefined {
  const url = new URL(path, "http://pi-web.local");
  const queryCwd = url.searchParams.get("cwd");
  if (queryCwd !== null && queryCwd !== "") return queryCwd;
  if (isRecord(body) && typeof body["cwd"] === "string" && body["cwd"] !== "") return body["cwd"];
  return undefined;
}

function homePrefixFromCwd(cwd: string): string | undefined {
  const match = /^\/home\/[^/]+(?:\/|$)/u.exec(cwd);
  return match === null ? undefined : match[0].replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestUrl(baseUrl: string, method: string, path: string, payload?: string) {
  const init: RequestInit = { method };
  if (payload !== undefined && payload !== "") {
    init.headers = { "content-type": "application/json" };
    init.body = payload;
  }
  const response = await fetch(new URL(path, baseUrl), init);
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

function requestSocket(socketPath: string, method: string, path: string, payload?: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method,
        headers: payload !== undefined && payload !== ""
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if (payload !== undefined && payload !== "") request.write(payload);
    request.end();
  });
}

function connectUrlWebSocket(baseUrl: string, path: string): WebSocket {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

function connectSocketWebSocket(socketPath: string, path: string): WebSocket {
  return new WebSocket(`ws+unix:${socketPath}:${path}`);
}
