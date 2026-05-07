import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import type { ClientCommand, ClientCommandResult, ClientSession, ClientSessionStatus } from "../types.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import type { ActiveSession } from "./sessionRuntimeStore.js";

export class PiSessionService {
  private readonly active = new Map<string, ActiveSession>();
  private readonly commandService: SessionCommandService;
  private readonly agentDir = getAgentDir();
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, authStorage: this.authStorage, modelRegistry: this.modelRegistry });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  constructor(private readonly events: SessionEventHub) {
    this.commandService = new SessionCommandService(
      (sessionId) => this.getActive(sessionId),
      (sessionId, text) => this.prompt(sessionId, text),
      events,
    );
  }

  async list(cwd: string): Promise<ClientSession[]> {
    const sessions = await SessionManager.list(cwd);
    return sessions.map((s) => ({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      name: s.name,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    }));
  }

  async start(cwd: string): Promise<ClientSession> {
    const active = await this.create(SessionManager.create(cwd), cwd);
    const { session } = active.runtime;
    return {
      id: session.sessionId,
      path: session.sessionFile ?? "",
      cwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: session.messages.length,
      firstMessage: "",
    };
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const session = await this.getOrOpen(sessionId);
    return session.messages;
  }

  async status(sessionId: string): Promise<ClientSessionStatus> {
    return this.statusFromSession(await this.getOrOpen(sessionId));
  }

  async commands(sessionId: string): Promise<ClientCommand[]> {
    const session = await this.getOrOpen(sessionId);
    const commands: ClientCommand[] = [...BUILTIN_COMMANDS];
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: command.invocationName, description: command.description, source: "extension" });
    }
    for (const template of session.promptTemplates) {
      commands.push({ name: template.name, description: template.description, source: "prompt" });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill" });
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const session = await this.getOrOpen(sessionId);
    void session.prompt(text).catch((error) => {
      this.events.publish(sessionId, { type: "session.error", message: error instanceof Error ? error.message : String(error) });
    });
  }

  async runCommand(sessionId: string, text: string): Promise<ClientCommandResult> {
    return this.commandService.run(sessionId, text);
  }

  async respondToCommand(sessionId: string, requestId: string, value: string): Promise<ClientCommandResult> {
    return this.commandService.respond(sessionId, requestId, value);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (active) await active.runtime.session.abort();
  }

  close(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.unsubscribe();
    void active.runtime.dispose();
    this.active.delete(sessionId);
  }

  private async getOrOpen(sessionId: string): Promise<AgentSession> {
    return (await this.getActive(sessionId)).runtime.session;
  }

  private async getActive(sessionId: string): Promise<ActiveSession> {
    const active = this.active.get(sessionId);
    if (active) return active;

    const match = (await SessionManager.listAll()).find((s) => s.id === sessionId || s.id.startsWith(sessionId));
    if (!match) throw new Error("Session not found");
    return this.create(SessionManager.open(match.path), match.cwd);
  }

  private async create(sessionManager: SessionManager, cwd: string): Promise<ActiveSession> {
    const runtime = await createAgentSessionRuntime(this.createRuntime, { cwd, agentDir: this.agentDir, sessionManager });
    const active: ActiveSession = { runtime, unsubscribe: () => {} };
    this.bindRuntime(active);
    runtime.setRebindSession(async () => this.bindRuntime(active));
    this.active.set(runtime.session.sessionId, active);
    this.events.publish(runtime.session.sessionId, { type: "status.update", status: this.statusFromSession(runtime.session) });
    return active;
  }

  private bindRuntime(active: ActiveSession): void {
    active.unsubscribe();
    for (const [sessionId, candidate] of this.active.entries()) {
      if (candidate === active) this.active.delete(sessionId);
    }
    const { session } = active.runtime;
    active.unsubscribe = session.subscribe((event) => {
      this.events.publish(session.sessionId, toClientEvent(event));
      this.events.publish(session.sessionId, { type: "status.update", status: this.statusFromSession(session) });
    });
    this.active.set(session.sessionId, active);
  }

  private statusFromSession(session: AgentSession): ClientSessionStatus {
    const stats = session.getSessionStats();
    return {
      sessionId: session.sessionId,
      model: session.model
        ? {
            provider: session.model.provider,
            id: session.model.id,
            name: (session.model as any).name,
            contextWindow: session.model.contextWindow,
            reasoning: (session.model as any).reasoning,
          }
        : undefined,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isBashRunning: session.isBashRunning,
      pendingMessageCount: session.pendingMessageCount,
      tokens: stats.tokens,
      cost: stats.cost,
      contextUsage: session.getContextUsage(),
    };
  }
}

function toClientEvent(event: any): unknown {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return { type: "assistant.delta", text: event.assistantMessageEvent.delta };
  }
  if (event.type === "tool_execution_start") {
    return { type: "tool.start", toolName: event.toolName, toolCallId: event.toolCallId };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool.end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
  }
  if (event.type === "agent_start") return { type: "agent.start" };
  if (event.type === "agent_end") return { type: "agent.end" };
  if (event.type === "message_end") return { type: "message.end" };
  return { type: "pi.event", eventType: event.type };
}
