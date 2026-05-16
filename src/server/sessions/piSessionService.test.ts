/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { AgentSession, AgentSessionRuntime, CreateAgentSessionRuntimeFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { PiSessionService } from "./piSessionService.js";

class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];

  override publish(sessionId: string, event: SessionUiEvent): void {
    this.sessionEvents.push({ sessionId, event });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }
}

function fakeSessionManager(cwd = "/workspace"): SessionManager {
  return {
    getCwd: () => cwd,
    getBranch: () => [],
  } as unknown as SessionManager;
}

type RuntimeFactoryResult = Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>;

function asRuntimeFactoryResult(runtime: AgentSessionRuntime): RuntimeFactoryResult {
  return runtime as unknown as RuntimeFactoryResult;
}

function fakeRuntime(sessionId = "session-1") {
  const promptCalls: { text: string; options: unknown }[] = [];
  const calls = { abort: 0, clearQueue: 0, dispose: 0, prompt: promptCalls };
  const session = {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    messages: [],
    sessionName: undefined,
    model: undefined,
    thinkingLevel: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    sessionManager: fakeSessionManager(),
    subscribe: () => () => undefined,
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    prompt: (text: string, options: unknown) => {
      calls.prompt.push({ text, options });
      return Promise.resolve();
    },
    abort: () => {
      calls.abort += 1;
      return Promise.resolve();
    },
    clearQueue: () => {
      calls.clearQueue += 1;
      return { steering: [], followUp: [] };
    },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
  } as unknown as AgentSession;
  const runtime = {
    session,
    setRebindSession: () => undefined,
    dispose: () => {
      calls.dispose += 1;
      return Promise.resolve();
    },
  } as unknown as AgentSessionRuntime;
  return { runtime, calls };
}

describe("PiSessionService", () => {
  it("starts sessions through an injected runtime factory", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    const createRuntime: CreateAgentSessionRuntimeFactory = () => Promise.resolve(asRuntimeFactoryResult(fake.runtime));
    const service = new PiSessionService(hub, {
      createRuntime,
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const session = await service.start("/workspace");

    expect(session).toMatchObject({ id: "session-1", cwd: "/workspace", messageCount: 0 });
    expect(service.activeCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "session-1")).toBe(true);

    await service.dispose();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("uses injected archive and session-manager gateways for listing", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }]),
        archive: () => Promise.resolve({ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([
          { id: "active", path: "/sessions/active.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" },
          { id: "archived", path: "/sessions/archived.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 2, firstMessage: "bye", allMessagesText: "bye" },
        ]),
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active" });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", archived: true, archivedAt: "2026-01-01T00:00:00.000Z" });

    await service.dispose();
  });

  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "prompt-session", path: "/sessions/prompt-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("prompt-session", "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("includes queued message details in session status", async () => {
    const fake = fakeRuntime("status-session");
    (fake.runtime.session as unknown as { pendingMessageCount: number; getSteeringMessages: () => string[]; getFollowUpMessages: () => string[] }).pendingMessageCount = 2;
    (fake.runtime.session as unknown as { getSteeringMessages: () => string[] }).getSteeringMessages = () => ["adjust this turn"];
    (fake.runtime.session as unknown as { getFollowUpMessages: () => string[] }).getFollowUpMessages = () => ["then do this"];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "status-session", path: "/sessions/status-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status("status-session")).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session");
    (fake.runtime.session as unknown as { isStreaming: boolean; pendingMessageCount: number; getFollowUpMessages: () => string[] }).isStreaming = true;
    (fake.runtime.session as unknown as { pendingMessageCount: number }).pendingMessageCount = 1;
    (fake.runtime.session as unknown as { getFollowUpMessages: () => string[] }).getFollowUpMessages = () => ["already queued"];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "dedupe-session", path: "/sessions/dedupe-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("dedupe-session", "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session");
    (fake.runtime.session as unknown as { isStreaming: boolean }).isStreaming = true;
    const service = new PiSessionService(hub, {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "queued-session", path: "/sessions/queued-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("queued-session", "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "abort-session", path: "/sessions/abort-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status("abort-session");
    await service.abort("abort-session");

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("auth-session");
    (fake.runtime.session as unknown as { model: { provider: string; id: string } }).model = { provider: "anthropic", id: "claude-3-5-sonnet" };

    const credentials = new Map<string, { type: "api_key" | "oauth"; key?: string }>([["anthropic", { type: "api_key", key: "sk-test" }]]);
    const authStorage = {
      get(provider: string) { return credentials.get(provider); },
      list(): string[] { return Array.from(credentials.keys()); },
      getOAuthProviders: () => [],
      hasAuth(provider: string): boolean { return credentials.has(provider); },
      getAuthStatus(provider: string) { return credentials.has(provider) ? { configured: true, source: "stored" as const } : { configured: false }; },
    };
    let refreshCalls = 0;
    const knownModels = [{ provider: "anthropic", id: "claude-3-5-sonnet" }];
    const modelRegistry = {
      authStorage,
      refresh(): void { refreshCalls += 1; },
      getAll: () => knownModels,
      getAvailable: () => credentials.has("anthropic") ? knownModels : [],
      find: (provider: string, id: string) => knownModels.find((model) => model.provider === provider && model.id === id),
      getProviderDisplayName: (provider: string) => provider,
      getProviderAuthStatus: (provider: string) => authStorage.getAuthStatus(provider),
      hasConfiguredAuth: (model: { provider: string }) => credentials.has(model.provider),
    };
    (fake.runtime.session as unknown as { modelRegistry: typeof modelRegistry }).modelRegistry = modelRegistry;

    const service = new PiSessionService(hub, {
      modelRegistry: modelRegistry as unknown as NonNullable<NonNullable<ConstructorParameters<typeof PiSessionService>[1]>["modelRegistry"]>,
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "auth-session", path: "/sessions/auth-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status("auth-session");
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;
    const refreshBefore = refreshCalls;

    credentials.delete("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes("anthropic/claude-3-5-sonnet")).length;
    expect(refreshCalls).toBeGreaterThan(refreshBefore);
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    credentials.set("anthropic", { type: "api_key", key: "sk-new" });
    service.applyAuthChange();
    credentials.delete("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createRuntime: () => Promise.resolve(asRuntimeFactoryResult(fake.runtime)),
      createAgentRuntime: () => Promise.resolve(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "stop-session", path: "/sessions/stop-session.jsonl", cwd: "/workspace", created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await service.status("stop-session");
    service.stop("stop-session");

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});
