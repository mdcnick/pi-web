import { workspaceAuthQuery } from "../clerkAuth";

import type { SessionRef } from "../../../shared/apiTypes";

type SessionLookup = SessionRef | string;

export function sessionEvents(session: SessionLookup, machineId = "local"): WebSocket {
  const cwd = typeof session === "string" ? undefined : session.cwd;
  const query = socketQuery(cwd === undefined || cwd === "" ? undefined : { cwd });
  const sessionId = typeof session === "string" ? session : session.id;
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/sessions/${encodeURIComponent(sessionId)}/events${query}`);
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/sessions/events${socketQuery()}`);
}

export function terminalSocket(projectId: string, workspaceId: string, terminalId: string, initialSize?: { cols: number; rows: number }, machineId = "local"): WebSocket {
  const size = initialSize === undefined ? undefined : { cols: String(initialSize.cols), rows: String(initialSize.rows) };
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/socket${socketQuery(size)}`);
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/events${socketQuery()}`);
}

function socketQuery(params?: Record<string, string>): string {
  const query = new URLSearchParams(params);
  const authQuery = workspaceAuthQuery();
  if (authQuery !== "") {
    for (const [key, value] of new URLSearchParams(authQuery)) query.set(key, value);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

function machinePrefix(machineId: string): string {
  return `/api/machines/${encodeURIComponent(machineId)}`;
}

function webSocketBaseUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}
