export function sessionEvents(sessionId: string): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}/api/sessions/${sessionId}/events`);
}

export function globalSessionEvents(): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}/api/sessions/events`);
}

export function terminalSocket(projectId: string, workspaceId: string, terminalId: string, initialSize?: { cols: number; rows: number }): WebSocket {
  const sizeQuery = initialSize === undefined ? "" : `?cols=${encodeURIComponent(String(initialSize.cols))}&rows=${encodeURIComponent(String(initialSize.rows))}`;
  return new WebSocket(`${webSocketBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/socket${sizeQuery}`);
}

export function realtimeEvents(): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}/api/events`);
}

function webSocketBaseUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}
