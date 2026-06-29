#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CONFIG_PATH = "~/.pi-web/telegram-gateway/config.json";
const DEFAULT_STATE_PATH = "~/.pi-web/telegram-gateway/state.json";

async function main() {
  const configPath = expandHome(getArg("--config") ?? process.env.TELEGRAM_GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const manager = new TelegramGatewayManager(configPath);
  await manager.run();
}

class TelegramGatewayManager {
  constructor(configPath) {
    this.configPath = configPath;
    this.runners = new Map();
    this.running = true;
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  async run() {
    console.log(`[telegram-gateway] manager starting; config=${this.configPath}`);
    await this.reload();
    while (this.running) {
      await sleep(5000);
      if (!this.running) break;
      try {
        await this.reload();
      } catch (error) {
        console.error(`[telegram-gateway] config reload error: ${formatError(error)}`);
      }
    }
    for (const runner of this.runners.values()) runner.gateway.stop();
    await Promise.allSettled([...this.runners.values()].map((runner) => runner.done));
    console.log("[telegram-gateway] manager stopped");
  }

  async reload() {
    const config = await loadConfig(this.configPath);
    const access = await loadWorkspaceAccess(config.workspaceAccessPath);
    const botConfigs = expandSessionBotConfigs(config);
    const nextIds = new Set(botConfigs.map((botConfig) => botConfig.botId));

    for (const [botId, runner] of this.runners.entries()) {
      if (!nextIds.has(botId)) {
        console.log(`[telegram-gateway] stopping removed bot=${botId}`);
        runner.gateway.stop();
        this.runners.delete(botId);
      }
    }

    for (const botConfig of botConfigs) {
      const fingerprint = gatewayConfigFingerprint(botConfig);
      const existing = this.runners.get(botConfig.botId);
      if (existing?.fingerprint === fingerprint) {
        existing.gateway.access = access;
        continue;
      }
      if (existing !== undefined) {
        console.log(`[telegram-gateway] restarting changed bot=${botConfig.botId}`);
        existing.gateway.stop();
      } else {
        console.log(`[telegram-gateway] starting bot=${botConfig.botId} label=${botConfig.botLabel ?? botConfig.botId}`);
      }
      const state = await loadState(botConfig.statePath);
      const gateway = new TelegramPiWebGateway(botConfig, state, access);
      const done = gateway.run().catch((error) => {
        if (gateway.running) console.error(`[telegram-gateway] bot=${botConfig.botId} stopped with error: ${formatError(error)}`);
      });
      this.runners.set(botConfig.botId, { gateway, fingerprint, done });
    }
  }

  stop() {
    this.running = false;
    for (const runner of this.runners.values()) runner.gateway.stop();
  }
}

class TelegramPiWebGateway {
  constructor(config, state, access) {
    this.config = config;
    this.state = state;
    this.access = access;
    this.telegramApiBase = `https://api.telegram.org/bot${encodeURIComponent(config.telegramBotToken)}`;
    this.piWebAuthToken = stringOrUndefined(process.env.PI_WEB_INTERNAL_AUTH_TOKEN) ?? stringOrUndefined(process.env.PI_WEB_ADMIN_TOKEN);
    this.offset = state.telegramUpdateOffset ?? 0;
    this.running = true;
  }

  async run() {
    console.log(`[telegram-gateway] bot=${this.config.botId} starting; label=${this.config.botLabel ?? this.config.botId}, PI WEB=${this.config.piWebBaseUrl}, machine=${this.config.machineId}`);
    await this.telegram("getMe", {});
    await this.protectConfiguredTelegramSessions();
    while (this.running) {
      try {
        const updates = await this.telegram("getUpdates", {
          offset: this.offset,
          timeout: this.config.pollTimeoutSeconds,
          allowed_updates: ["message"],
        }, { timeoutMs: (this.config.pollTimeoutSeconds + 10) * 1000 });
        for (const update of updates) {
          await this.handleUpdate(update);
          await this.markUpdateProcessed(update);
        }
      } catch (error) {
        console.error(`[telegram-gateway] polling error: ${formatError(error)}`);
        await sleep(3000);
      }
    }
    await saveState(this.config.statePath, this.state);
    console.log(`[telegram-gateway] bot=${this.config.botId} stopped`);
  }

  stop() {
    this.running = false;
  }

  async handleUpdate(update) {
    const message = update.message;
    if (!message || typeof message.text !== "string") return;

    const from = message.from;
    const chat = message.chat;
    if (!from || typeof from.id !== "number" || !chat || typeof chat.id !== "number") return;

    const route = this.routeFor(from.id, chat.id);
    if (!route.allowed) {
      console.warn(`[telegram-gateway] denied user=${from.id} chat=${chat.id}`);
      await this.sendMessage(chat.id, "This bot is private. Ask the owner to link your Telegram account to an allowed workspace.");
      return;
    }

    const text = message.text.trim();
    console.log(`[telegram-gateway] received message user=${from.id} chat=${chat.id} route=${route.cwd} session=${route.sessionId ?? "auto"}`);

    try {
      if (text === "/start" || text === "/help") {
        await this.sendMessage(chat.id, helpText(route));
      } else if (text === "/status") {
        await this.sendMessage(chat.id, this.statusText(from.id, chat.id, route));
      } else if (text === "/new" || text === "/reset") {
        const session = await this.createSession(route.cwd);
        await this.protectTelegramSession(session.id, route.cwd);
        await this.setSession(from.id, chat.id, route.cwd, session.id);
        await this.sendMessage(chat.id, `Started a fresh PI WEB session.\nSession: ${session.id}\nWorkspace: ${route.cwd}`);
      } else if (text.startsWith("/setcwd")) {
        await this.handleSetCwd(from.id, chat.id, text);
      } else if (text.startsWith("/")) {
        await this.sendMessage(chat.id, "Unknown command. Try /help.");
      } else {
        await this.forwardPrompt(from.id, chat.id, text, route);
      }
    } catch (error) {
      console.error(`[telegram-gateway] message error user=${from.id} chat=${chat.id}: ${formatError(error)}`);
      await this.sendMessage(chat.id, `Gateway error: ${formatError(error)}`);
    }
  }

  async handleSetCwd(userId, chatId, text) {
    if (!this.isAdmin(userId)) {
      await this.sendMessage(chatId, "/setcwd is admin-only.");
      return;
    }
    const cwd = text.replace(/^\/setcwd(?:@\w+)?\s*/u, "").trim();
    if (!cwd.startsWith("/")) {
      await this.sendMessage(chatId, "Usage: /setcwd /absolute/workspace/path");
      return;
    }
    const route = this.routeFor(userId, chatId);
    if (route.allowedWorkspaces.length > 0 && !route.allowedWorkspaces.includes(cwd)) {
      await this.sendMessage(chatId, `That workspace is not assigned to this user. Allowed:\n${route.allowedWorkspaces.join("\n")}`);
      return;
    }
    const key = routeKey(userId, chatId);
    const existing = this.state.routes[key] ?? {};
    this.state.routes[key] = { ...existing, cwd, sessionId: undefined };
    await saveState(this.config.statePath, this.state);
    await this.sendMessage(chatId, `Workspace changed for this chat. Use /new to start there now.\n${cwd}`);
  }

  async forwardPrompt(userId, chatId, text, route) {
    const sessionId = await this.ensureSession(userId, chatId, route.cwd);
    const status = await this.piWebJson(`/sessions/${encodeURIComponent(sessionId)}/status?cwd=${encodeURIComponent(route.cwd)}`);
    if (status.isStreaming || status.isCompacting) {
      await this.piWebJson(`/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: "POST",
        body: { cwd: route.cwd, text, streamingBehavior: "followUp" },
      });
      await this.sendMessage(chatId, "Queued behind the current PI response.");
      return;
    }

    await this.sendMessage(chatId, `Got it — waking PI WEB session ${sessionId.slice(0, 8)}…`);
    const typing = this.keepTyping(chatId);
    try {
      const reply = await this.promptAndCollect(sessionId, route.cwd, text);
      console.log(`[telegram-gateway] sending response user=${userId} chat=${chatId} session=${sessionId} chars=${String((reply || "Done.").length)}`);
      await this.sendLongMessage(chatId, reply || "Done.");
    } finally {
      typing.stop();
    }
  }

  async ensureSession(userId, chatId, cwd) {
    const key = routeKey(userId, chatId);
    const existing = this.state.routes[key];
    const configuredSessionId = this.config.userRoutes[String(userId)]?.sessionId;
    const candidateSessionId = existing?.sessionId && existing.cwd === cwd ? existing.sessionId : configuredSessionId;
    if (candidateSessionId) {
      try {
        await this.piWebJson(`/sessions/${encodeURIComponent(candidateSessionId)}/status?cwd=${encodeURIComponent(cwd)}`);
        await this.protectTelegramSession(candidateSessionId, cwd);
        await this.setSession(userId, chatId, cwd, candidateSessionId);
        console.log(`[telegram-gateway] using existing session user=${userId} chat=${chatId} session=${candidateSessionId}`);
        return candidateSessionId;
      } catch {
        // Session disappeared or machine restarted; create a replacement below.
      }
    }
    const session = await this.createSession(cwd);
    await this.protectTelegramSession(session.id, cwd);
    await this.setSession(userId, chatId, cwd, session.id);
    console.log(`[telegram-gateway] created session user=${userId} chat=${chatId} session=${session.id}`);
    return session.id;
  }

  async createSession(cwd) {
    return await this.piWebJson("/sessions", { method: "POST", body: { cwd } });
  }

  async protectConfiguredTelegramSessions() {
    const seen = new Set();
    const configuredRoutes = Object.values(this.config.userRoutes ?? {});
    const stateRoutes = Object.values(this.state.routes ?? {});
    for (const route of [...configuredRoutes, ...stateRoutes]) {
      if (!route || typeof route.sessionId !== "string" || route.sessionId === "" || typeof route.cwd !== "string" || route.cwd === "") continue;
      const key = `${route.cwd}\u0000${route.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.protectTelegramSession(route.sessionId, route.cwd);
    }
  }

  async protectTelegramSession(sessionId, cwd) {
    try {
      await this.piWebJson(`/sessions/${encodeURIComponent(sessionId)}/protection`, {
        method: "POST",
        body: {
          cwd,
          locked: true,
          permanent: true,
          pinned: true,
          terminalBlocked: true,
          source: "telegram",
          reason: "Telegram-bound external session",
        },
      });
    } catch (error) {
      console.warn(`[telegram-gateway] failed to apply Telegram session protection session=${sessionId}: ${formatError(error)}`);
    }
  }

  async setSession(userId, chatId, cwd, sessionId) {
    this.state.routes[routeKey(userId, chatId)] = { cwd, sessionId, updatedAt: new Date().toISOString() };
    await saveState(this.config.statePath, this.state);
  }

  async markUpdateProcessed(update) {
    if (typeof update.update_id !== "number") return;
    const nextOffset = update.update_id + 1;
    if (nextOffset <= this.offset) return;
    this.offset = nextOffset;
    this.state.telegramUpdateOffset = this.offset;
    await saveState(this.config.statePath, this.state);
  }

  async promptAndCollect(sessionId, cwd, text) {
    console.log(`[telegram-gateway] opening PI WEB event socket session=${sessionId}`);
    const ws = new WebSocket(this.piWebWsUrl(`/sessions/${encodeURIComponent(sessionId)}/events?cwd=${encodeURIComponent(cwd)}`));
    const chunks = [];
    let sawAgentStart = false;
    let finished = false;
    let failure;

    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for PI WEB response")), this.config.responseTimeoutMs);
      ws.addEventListener("open", async () => {
        try {
          console.log(`[telegram-gateway] event socket open; posting prompt session=${sessionId}`);
          await this.piWebJson(`/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { cwd, text } });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.addEventListener("message", (event) => {
        void (async () => {
          try {
            const data = JSON.parse(await webSocketDataText(event.data));
            if (data.type === "agent.start") sawAgentStart = true;
            if (data.type === "assistant.delta" && sawAgentStart && typeof data.text === "string") chunks.push(data.text);
            if (data.type === "session.error") failure = new Error(String(data.message ?? "PI WEB session error"));
            if (data.type === "agent.end" && sawAgentStart) {
              finished = true;
              clearTimeout(timer);
              resolve(chunks.join("").trim());
            }
          } catch (error) {
            failure = error;
            clearTimeout(timer);
            reject(error);
          }
        })();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("PI WEB session WebSocket failed"));
      });
      ws.addEventListener("close", () => {
        if (!finished) {
          clearTimeout(timer);
          reject(failure ?? new Error("PI WEB session WebSocket closed before response completed"));
        }
      });
    });

    try {
      return await completion;
    } finally {
      try { ws.close(); } catch { /* noop */ }
    }
  }

  routeFor(userId, chatId) {
    const key = routeKey(userId, chatId);
    const stateRoute = this.state.routes[key];
    const accessUser = this.access?.telegramUsers.get(userId);
    const configRoute = this.config.userRoutes[String(userId)] ?? {};
    const allowedWorkspaces = accessUser?.workspaces ?? [];
    const requestedCwd = stateRoute?.cwd ?? configRoute.cwd ?? allowedWorkspaces[0] ?? this.config.defaultCwd;
    const cwd = allowedWorkspaces.length > 0 && !allowedWorkspaces.includes(requestedCwd) ? allowedWorkspaces[0] : requestedCwd;
    const allowedByBot = this.config.allowedTelegramUserIds.includes(userId);
    const allowedByAccess = accessUser !== undefined && (this.config.sessionBot !== true || this.config.allowedTelegramUserIds.length === 0 || allowedByBot);
    return {
      allowed: allowedByBot || allowedByAccess,
      clerkUserId: accessUser?.clerkUserId,
      cwd,
      label: accessUser?.label ?? configRoute.label ?? String(userId),
      sessionId: stateRoute?.sessionId ?? configRoute.sessionId,
      allowedWorkspaces,
    };
  }

  statusText(userId, chatId, route) {
    return [
      "PI WEB Telegram Gateway",
      `User: ${userId}`,
      `Linked account: ${route.clerkUserId ?? "legacy allowlist"}`,
      `Chat: ${chatId}`,
      `Workspace: ${route.cwd}`,
      `Session: ${route.sessionId ?? this.state.routes[routeKey(userId, chatId)]?.sessionId ?? "not started"}`,
      `Bot: ${this.config.botLabel ?? this.config.botId}`,
      `Machine: ${this.config.machineId}`,
    ].join("\n");
  }

  isAllowed(userId) {
    return this.routeFor(userId, userId).allowed;
  }

  isAdmin(userId) {
    return this.config.adminTelegramUserIds.includes(userId);
  }

  async sendLongMessage(chatId, text) {
    const limit = this.config.maxTelegramChunk;
    const chunks = chunkText(text, limit);
    for (const chunk of chunks) await this.sendMessage(chatId, chunk);
  }

  async sendMessage(chatId, text) {
    await this.telegram("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }

  keepTyping(chatId) {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try { await this.telegram("sendChatAction", { chat_id: chatId, action: "typing" }, { timeoutMs: 10000 }); } catch { /* ignore typing failures */ }
        await sleep(4500);
      }
    };
    void loop();
    return { stop: () => { stopped = true; } };
  }

  async telegram(method, payload, options = {}) {
    const result = await fetchJson(`${this.telegramApiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, options.timeoutMs ?? this.config.requestTimeoutMs);
    if (result.ok !== true) throw new Error(`Telegram ${method} failed: ${result.description ?? "unknown error"}`);
    return result.result;
  }

  async piWebJson(path, options = {}) {
    const headers = {
      "content-type": "application/json",
      ...(this.piWebAuthToken === undefined ? {} : { authorization: `Bearer ${this.piWebAuthToken}` }),
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return await fetchJson(this.piWebHttpUrl(path), { method: options.method ?? "GET", headers, body }, this.config.requestTimeoutMs);
  }

  piWebHttpUrl(path) {
    return `${this.config.piWebBaseUrl.replace(/\/$/u, "")}/api/machines/${encodeURIComponent(this.config.machineId)}${path}`;
  }

  piWebWsUrl(path) {
    const base = new URL(this.piWebHttpUrl(path));
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    if (this.piWebAuthToken !== undefined) base.searchParams.set("access_token", this.piWebAuthToken);
    return base.toString();
  }
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const data = text === "" ? {} : JSON.parse(text);
    if (!response.ok) throw new Error(data.error ? `${response.status} ${data.error}` : `${response.status} ${response.statusText}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig(path) {
  const filePath = expandHome(path);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const legacyToken = process.env.TELEGRAM_BOT_TOKEN || stringOrUndefined(parsed.telegramBotToken);
  const config = {
    telegramBotToken: legacyToken,
    piWebBaseUrl: stringOrUndefined(parsed.piWebBaseUrl) ?? "http://127.0.0.1:8504",
    machineId: stringOrUndefined(parsed.machineId) ?? "local",
    defaultCwd: requireAbsolutePath(parsed.defaultCwd, "defaultCwd"),
    workspaceAccessPath: stringOrUndefined(parsed.workspaceAccessPath),
    allowedTelegramUserIds: numberArray(parsed.allowedTelegramUserIds ?? [], "allowedTelegramUserIds"),
    adminTelegramUserIds: numberArray(parsed.adminTelegramUserIds ?? [], "adminTelegramUserIds"),
    userRoutes: recordOrEmpty(parsed.userRoutes),
    sessionBots: parseSessionBots(parsed.sessionBots),
    statePath: expandHome(stringOrUndefined(parsed.statePath) ?? DEFAULT_STATE_PATH),
    pollTimeoutSeconds: positiveNumber(parsed.pollTimeoutSeconds, 25),
    requestTimeoutMs: positiveNumber(parsed.requestTimeoutMs, 30000),
    responseTimeoutMs: positiveNumber(parsed.responseTimeoutMs, 900000),
    maxTelegramChunk: positiveNumber(parsed.maxTelegramChunk, 3900),
  };
  if (config.workspaceAccessPath !== undefined) config.workspaceAccessPath = expandHome(config.workspaceAccessPath);
  if (config.sessionBots.length === 0 && !legacyToken) throw new Error("Missing TELEGRAM_BOT_TOKEN env var, telegramBotToken, or sessionBots[].telegramBotToken in config");
  if (config.sessionBots.length === 0 && config.allowedTelegramUserIds.length === 0 && config.workspaceAccessPath === undefined) throw new Error("allowedTelegramUserIds must contain at least one Telegram user ID when workspaceAccessPath is not configured");
  for (const [userId, route] of Object.entries(config.userRoutes)) {
    if (!/^\d+$/u.test(userId)) throw new Error(`userRoutes key must be a Telegram numeric user ID: ${userId}`);
    if (route.cwd !== undefined) requireAbsolutePath(route.cwd, `userRoutes.${userId}.cwd`);
    if (route.sessionId !== undefined && typeof route.sessionId !== "string") throw new Error(`userRoutes.${userId}.sessionId must be a string`);
  }
  return config;
}

function parseSessionBots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("sessionBots must be an array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`sessionBots.${index} must be an object`);
    const id = stringOrUndefined(item.id) ?? `bot-${index + 1}`;
    const token = stringOrUndefined(item.telegramBotToken);
    const allowed = numberArray(item.allowedTelegramUserIds ?? (typeof item.telegramUserId === "number" ? [item.telegramUserId] : []), `sessionBots.${index}.allowedTelegramUserIds`);
    const admin = numberArray(item.adminTelegramUserIds ?? [], `sessionBots.${index}.adminTelegramUserIds`);
    const cwd = item.cwd === undefined ? undefined : requireAbsolutePath(item.cwd, `sessionBots.${index}.cwd`);
    if (item.sessionId !== undefined && typeof item.sessionId !== "string") throw new Error(`sessionBots.${index}.sessionId must be a string`);
    return {
      id,
      label: stringOrUndefined(item.label),
      telegramBotToken: token,
      allowedTelegramUserIds: allowed,
      adminTelegramUserIds: admin,
      cwd,
      sessionId: stringOrUndefined(item.sessionId),
      enabled: item.enabled !== false,
    };
  });
}

function expandSessionBotConfigs(config) {
  const enabledSessionBots = config.sessionBots.filter((bot) => bot.enabled !== false && bot.telegramBotToken);
  if (config.sessionBots.length > 0) {
    return enabledSessionBots.map((bot, index) => {
      const defaultCwd = bot.cwd ?? config.defaultCwd;
      const userRoutes = Object.fromEntries(bot.allowedTelegramUserIds.map((userId) => [String(userId), {
        ...(bot.label === undefined ? {} : { label: bot.label }),
        cwd: defaultCwd,
        ...(bot.sessionId === undefined ? {} : { sessionId: bot.sessionId }),
      }]));
      return {
        ...config,
        botId: bot.id,
        botLabel: bot.label,
        sessionBot: true,
        telegramBotToken: bot.telegramBotToken,
        defaultCwd,
        allowedTelegramUserIds: bot.allowedTelegramUserIds,
        adminTelegramUserIds: bot.adminTelegramUserIds,
        userRoutes,
        statePath: deriveBotStatePath(config.statePath, bot.id || `bot-${index + 1}`),
      };
    });
  }
  return config.telegramBotToken ? [{ ...config, botId: "legacy", botLabel: "Legacy shared bot", statePath: expandHome(config.statePath) }] : [];
}

function gatewayConfigFingerprint(config) {
  return JSON.stringify({
    botId: config.botId,
    botLabel: config.botLabel,
    sessionBot: config.sessionBot,
    telegramBotToken: config.telegramBotToken,
    piWebBaseUrl: config.piWebBaseUrl,
    machineId: config.machineId,
    defaultCwd: config.defaultCwd,
    workspaceAccessPath: config.workspaceAccessPath,
    allowedTelegramUserIds: config.allowedTelegramUserIds,
    adminTelegramUserIds: config.adminTelegramUserIds,
    userRoutes: config.userRoutes,
    statePath: config.statePath,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    responseTimeoutMs: config.responseTimeoutMs,
    maxTelegramChunk: config.maxTelegramChunk,
  });
}

function deriveBotStatePath(baseStatePath, botId) {
  const expanded = expandHome(baseStatePath ?? DEFAULT_STATE_PATH);
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]+/gu, "_") || "bot";
  return expanded.endsWith(".json") ? `${expanded.slice(0, -5)}.${safe}.json` : `${expanded}.${safe}`;
}

async function loadWorkspaceAccess(path) {
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const users = recordOrEmpty(parsed.users);
    const telegramUsers = new Map();
    for (const [clerkUserId, user] of Object.entries(users)) {
      if (typeof clerkUserId !== "string" || clerkUserId === "") throw new Error("Workspace access user IDs must be non-empty strings");
      if (typeof user !== "object" || user === null || Array.isArray(user)) throw new Error(`Workspace access user ${clerkUserId} must be an object`);
      const workspaces = stringArray(user.workspaces, `users.${clerkUserId}.workspaces`).map((workspace) => requireAbsolutePath(workspace, `users.${clerkUserId}.workspaces[]`));
      const telegramUserIds = numberArray(user.telegramUserIds ?? [], `users.${clerkUserId}.telegramUserIds`);
      const label = stringOrUndefined(user.label) ?? clerkUserId;
      for (const telegramUserId of telegramUserIds) {
        telegramUsers.set(telegramUserId, { clerkUserId, label, workspaces });
      }
    }
    console.log(`[telegram-gateway] loaded workspace access map from ${path} (${telegramUsers.size} Telegram link${telegramUsers.size === 1 ? "" : "s"})`);
    return { telegramUsers };
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`workspaceAccessPath does not exist: ${path}`);
    throw error;
  }
}

async function loadState(path) {
  const filePath = expandHome(path ?? DEFAULT_STATE_PATH);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return { telegramUpdateOffset: parsed.telegramUpdateOffset ?? 0, routes: recordOrEmpty(parsed.routes) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { telegramUpdateOffset: 0, routes: {} };
    throw error;
  }
}

async function saveState(path, state) {
  const filePath = expandHome(path ?? DEFAULT_STATE_PATH);
  const directory = dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function helpText(route) {
  return [
    "PI WEB Telegram Gateway",
    "Send a normal message and I will forward it to your private PI WEB session.",
    "",
    "Commands:",
    "/status - show the mapped workspace/session",
    "/new - start a fresh isolated session",
    "/help - show this help",
    "",
    `Workspace: ${route.cwd}`,
  ].join("\n");
}

function routeKey(userId, chatId) {
  return `${userId}:${chatId}`;
}

async function webSocketDataText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === "function") return await data.text();
  return String(data);
}

function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const splitAt = Math.max(1, remaining.lastIndexOf("\n", limit));
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function expandHome(path) {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? ".", path.slice(2));
  return path;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return value;
}

function numberArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
    throw new Error(`${name} must be an array of numeric Telegram user IDs`);
  }
  return value;
}

function recordOrEmpty(value) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value;
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(`[telegram-gateway] fatal: ${formatError(error)}`);
  process.exitCode = 1;
});
