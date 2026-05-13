import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { TerminalInfo } from "./terminalService.js";
import { registerTerminalRoutes, type TerminalRouteService } from "./terminalRoutes.js";

let app: FastifyInstance;
let terminals: FakeTerminals;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  terminals = new FakeTerminals();
  registerTerminalRoutes(app, terminals);
  await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await app.close();
});

describe("terminal socket routes", () => {
  it("applies the initial socket size before attaching and replaying output", async () => {
    const socket = new WebSocket(`${serverUrl(app)}/terminals/t1/socket?cols=120.9&rows=40.2`);

    await expect(nextMessage(socket)).resolves.toBe(JSON.stringify({ type: "output", data: "replayed", replay: true }));
    expect(terminals.events).toEqual(["resize:t1:120x40", "attach:t1"]);

    socket.close();
  });
});

class FakeTerminals implements TerminalRouteService {
  readonly events: string[] = [];

  list(cwd: string): TerminalInfo[] {
    void cwd;
    return [];
  }

  create(options: { cwd: string; name?: string; cols?: number; rows?: number }): TerminalInfo {
    return {
      id: "t1",
      cwd: options.cwd,
      name: options.name ?? "Shell 1",
      createdAt: "2026-05-13T00:00:00.000Z",
      exited: false,
    };
  }

  close(id: string): void {
    this.events.push(`close:${id}`);
  }

  attach(id: string, handlers: { output: (data: string, replay: boolean) => void; exit: (exitCode: number | undefined) => void }): () => void {
    this.events.push(`attach:${id}`);
    handlers.output("replayed", true);
    return () => {
      this.events.push(`detach:${id}`);
    };
  }

  write(id: string, data: string): void {
    this.events.push(`write:${id}:${data}`);
  }

  resize(id: string, cols: number, rows: number): void {
    this.events.push(`resize:${id}:${String(cols)}x${String(rows)}`);
  }
}

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
