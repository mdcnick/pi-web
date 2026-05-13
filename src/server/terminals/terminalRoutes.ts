import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type { TerminalInfo } from "./terminalService.js";
import { parseTerminalSize } from "./terminalSize.js";

export interface TerminalRouteService {
  list(cwd: string): TerminalInfo[];
  create(options: { cwd: string; name?: string; cols?: number; rows?: number }): TerminalInfo;
  close(id: string): void;
  attach(id: string, handlers: { output: (data: string, replay: boolean) => void; exit: (exitCode: number | undefined) => void }): () => void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
}

export function registerTerminalRoutes(app: FastifyInstance, terminals: TerminalRouteService, prefix = ""): void {
  app.get<{ Querystring: { cwd?: string } }>(`${prefix}/terminals`, (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    return terminals.list(request.query.cwd);
  });

  app.post<{ Body: { cwd: string; name?: string; cols?: number; rows?: number } }>(`${prefix}/terminals`, (request, reply) => {
    try {
      return terminals.create(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { terminalId: string } }>(`${prefix}/terminals/:terminalId`, (request) => {
    terminals.close(request.params.terminalId);
    return { closed: true };
  });

  app.get<{ Params: { terminalId: string }; Querystring: { cols?: string; rows?: string } }>(`${prefix}/terminals/:terminalId/socket`, { websocket: true }, (socket, request) => {
    let detach: (() => void) | undefined;
    try {
      const initialSize = parseTerminalSize(request.query.cols, request.query.rows);
      if (initialSize !== undefined) terminals.resize(request.params.terminalId, initialSize.cols, initialSize.rows);
      detach = terminals.attach(request.params.terminalId, {
        output: (data, replay) => { socket.send(JSON.stringify({ type: "output", data, replay })); },
        exit: (exitCode) => { socket.send(JSON.stringify({ type: "exit", exitCode })); },
      });
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      socket.close();
      return;
    }

    socket.on("message", (data) => {
      try {
        const message = parseClientMessage(data);
        if (message.type === "input") terminals.write(request.params.terminalId, message.data);
        if (message.type === "resize") terminals.resize(request.params.terminalId, message.cols, message.rows);
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      }
    });
    socket.on("close", () => { detach(); });
    socket.on("error", () => { detach(); });
  });
}

type ClientTerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

function parseClientMessage(data: RawData): ClientTerminalMessage {
  const value: unknown = JSON.parse(rawDataToString(data));
  if (!isRecord(value) || typeof value["type"] !== "string") throw new Error("Invalid terminal message");
  if (value["type"] === "input" && typeof value["data"] === "string") return { type: "input", data: value["data"] };
  if (value["type"] === "resize" && typeof value["cols"] === "number" && typeof value["rows"] === "number") return { type: "resize", cols: value["cols"], rows: value["rows"] };
  throw new Error("Invalid terminal message");
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
