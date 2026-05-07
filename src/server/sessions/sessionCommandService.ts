import crypto from "node:crypto";
import type { AgentSession, AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { ClientCommandResult, ClientSession } from "../types.js";
import { isBuiltinCommand } from "./builtinCommands.js";
import type { ActiveSession, GetActiveSession } from "./sessionRuntimeStore.js";

interface PendingCommandSelect {
  sessionId: string;
  command: "fork";
}

export class SessionCommandService {
  private readonly pendingSelects = new Map<string, PendingCommandSelect>();

  constructor(
    private readonly getActive: GetActiveSession,
    private readonly prompt: (sessionId: string, text: string) => Promise<void>,
    private readonly events: SessionEventHub,
  ) {}

  async run(sessionId: string, text: string): Promise<ClientCommandResult> {
    const active = await this.getActive(sessionId);
    const session = active.runtime.session;
    const [name = "", ...args] = text.trim().replace(/^\//, "").split(/\s+/);
    const rest = args.join(" ").trim();

    if (!isBuiltinCommand(name)) {
      if (this.isRuntimeCommand(session, name)) {
        await this.prompt(sessionId, text);
        return { type: "done", message: `Accepted ${text}` };
      }
      return { type: "unsupported", message: `Unknown command: /${name}` };
    }

    if (name === "session") return { type: "done", message: formatSessionStats(session) };
    if (name === "name") return this.nameSession(session, rest);
    if (name === "compact") return this.compact(session, rest);
    if (name === "clone") return this.clone(active);
    if (name === "fork") return this.fork(active);

    return { type: "unsupported", message: `/${name} is not implemented in the web UI yet` };
  }

  async respond(sessionId: string, requestId: string, value: string): Promise<ClientCommandResult> {
    const pending = this.pendingSelects.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return { type: "unsupported", message: "Command request expired" };
    this.pendingSelects.delete(requestId);

    const active = await this.getActive(sessionId);
    if (pending.command === "fork") {
      const result = await active.runtime.fork(value);
      if (result.cancelled) return { type: "done", message: "Fork cancelled" };
      return { type: "done", message: "Session forked", session: clientSessionFromRuntime(active.runtime) };
    }
    return { type: "unsupported", message: "Unsupported command response" };
  }

  private nameSession(session: AgentSession, name: string): ClientCommandResult {
    if (!name) return { type: "unsupported", message: "Usage: /name <session name>" };
    session.setSessionName(name);
    return { type: "done", message: `Session named ${name}` };
  }

  private compact(session: AgentSession, instructions: string): ClientCommandResult {
    void session.compact(instructions || undefined).catch((error) => {
      this.events.publish(session.sessionId, { type: "session.error", message: error instanceof Error ? error.message : String(error) });
    });
    return { type: "done", message: "Compaction started" };
  }

  private async clone(active: ActiveSession): Promise<ClientCommandResult> {
    const leafId = active.runtime.session.sessionManager.getLeafId();
    if (!leafId) return { type: "unsupported", message: "Cannot clone: no current session entry" };
    const result = await active.runtime.fork(leafId, { position: "at" });
    if (result.cancelled) return { type: "done", message: "Clone cancelled" };
    return { type: "done", message: "Session cloned", session: clientSessionFromRuntime(active.runtime) };
  }

  private fork(active: ActiveSession): ClientCommandResult {
    const messages = active.runtime.session.getUserMessagesForForking();
    if (!messages.length) return { type: "unsupported", message: "No user messages to fork from" };
    const requestId = crypto.randomUUID();
    this.pendingSelects.set(requestId, { sessionId: active.runtime.session.sessionId, command: "fork" });
    return {
      type: "select",
      requestId,
      title: "Fork from message",
      options: messages.map((message) => ({ value: message.entryId, label: truncate(message.text, 140) })),
    };
  }

  private isRuntimeCommand(session: AgentSession, name: string): boolean {
    return session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name)
      || session.promptTemplates.some((template) => template.name === name)
      || session.resourceLoader.getSkills().skills.some((skill) => `skill:${skill.name}` === name);
  }
}

function clientSessionFromRuntime(runtime: AgentSessionRuntime): ClientSession {
  const session = runtime.session;
  return {
    id: session.sessionId,
    path: session.sessionFile ?? "",
    cwd: runtime.cwd,
    name: session.sessionName,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: session.messages.length,
    firstMessage: "",
  };
}

function formatSessionStats(session: AgentSession): string {
  const stats = session.getSessionStats();
  return [
    `Session: ${stats.sessionId}`,
    `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
    `Tool calls: ${stats.toolCalls}`,
    `Tokens: ↑${stats.tokens.input} ↓${stats.tokens.output} total ${stats.tokens.total}`,
    `Cost: $${stats.cost.toFixed(4)}`,
  ].join("\n");
}

function truncate(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}
