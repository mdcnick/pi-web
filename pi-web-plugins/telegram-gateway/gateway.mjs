#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CONFIG_PATH = "~/.pi-web/telegram-gateway/config.json";
const DEFAULT_STATE_PATH = "~/.pi-web/telegram-gateway/state.json";

main().catch((error) => {
  console.error(`[telegram-gateway] fatal: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  const config = await loadConfig(getArg("--config") ?? process.env.TELEGRAM_GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const access = await loadWorkspaceAccess(config.workspaceAccessPath);
  const state = await loadState(config.statePath);
  const gateway = new TelegramPiWebGateway(config, state, access);
  await gateway.run();
}

class TelegramPiWebGateway {
  constructor(config, state, access) {
    this.config = config;
    this.state = state;
    this.access = access;
    this.telegramApiBase = `https://api.telegram.org/bot${encodeURIComponent(config.telegramBotToken)}`;
    this.offset = state.telegramUpdateOffset ?? 0;
    this.running = true;
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  async run() {
    console.log(`[telegram-gateway] starting; PI WEB=${this.config.piWebBaseUrl}, machine=${this.config.machineId}`);
    await this.telegram("getMe", {});
    while (this.running) {
      try {
        const updates = await this.telegram("getUpdates", {
          offset: this.offset,
          timeout: this.config.pollTimeoutSeconds,
          allowed_updates: ["message"],
        }, { timeoutMs: (this.config.pollTimeoutSeconds + 10) * 1000 });
        for (const update of updates) await this.handleUpdate(update);
      } catch (error) {
        console.error(`[telegram-gateway] polling error: ${formatError(error)}`);
        await sleep(3000);
      }
    }
    await saveState(this.config.statePath, this.state);
    console.log("[telegram-gateway] stopped");
  }

  stop() {
    this.running = false;
  }

  async handleUpdate(update) {
    if (typeof update.update_id === "number") {
      this.offset = update.update_id + 1;
      this.state.telegramUpdateOffset = this.offset;
      await saveState(this.config.statePath, this.state);
    }

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

    try {
      if (text === "/start" || text === "/help") {
        await this.sendMessage(chat.id, helpText(route));
      } else if (text === "/status") {
        await this.sendMessage(chat.id, this.statusText(from.id, chat.id, route));
      } else if (text === "/new" || text === "/reset") {
        const session = await this.createSession(route.cwd);
        this.setSession(from.id, chat.id, route.cwd, session.id);
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

    const typing = this.keepTyping(chatId);
    try {
      const reply = await this.promptAndCollect(sessionId, route.cwd, text);
      await this.sendLongMessage(chatId, reply || "Done.");
    } finally {
      typing.stop();
    }
  }

  async ensureSession(userId, chatId, cwd) {
    const key = routeKey(userId, chatId);
    const existing = this.state.routes[key];
    if (existing?.sessionId && existing.cwd === cwd) {
      try {
        await this.piWebJson(`/sessions/${encodeURIComponent(existing.sessionId)}/status?cwd=${encodeURIComponent(cwd)}`);
        return existing.sessionId;
      } catch {
        // Session disappeared or machine restarted; create a replacement below.
      }
    }
    const session = await this.createSession(cwd);
    this.setSession(userId, chatId, cwd, session.id);
    return session.id;
  }

  async createSession(cwd) {
    return await this.piWebJson("/sessions", { method: "POST", body: { cwd } });
  }

  setSession(userId, chatId, cwd, sessionId) {
    this.state.routes[routeKey(userId, chatId)] = { cwd, sessionId, updatedAt: new Date().toISOString() };
    void saveState(this.config.statePath, this.state);
  }

  async promptAndCollect(sessionId, cwd, text) {
    const ws = new WebSocket(this.piWebWsUrl(`/sessions/${encodeURIComponent(sessionId)}/events?cwd=${encodeURIComponent(cwd)}`));
    const chunks = [];
    let sawAgentStart = false;
    let finished = false;
    let failure;

    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for PI WEB response")), this.config.responseTimeoutMs);
      ws.addEventListener("open", async () => {
        try {
          await this.piWebJson(`/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { cwd, text } });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data));
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
        }
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
    return {
      allowed: accessUser !== undefined || this.config.allowedTelegramUserIds.includes(userId),
      clerkUserId: accessUser?.clerkUserId,
      cwd,
      label: accessUser?.label ?? configRoute.label ?? String(userId),
      sessionId: stateRoute?.sessionId,
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
    const headers = { "content-type": "application/json" };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return await fetchJson(this.piWebHttpUrl(path), { method: options.method ?? "GET", headers, body }, this.config.requestTimeoutMs);
  }

  piWebHttpUrl(path) {
    return `${this.config.piWebBaseUrl.replace(/\/$/u, "")}/api/machines/${encodeURIComponent(this.config.machineId)}${path}`;
  }

  piWebWsUrl(path) {
    const base = new URL(this.piWebHttpUrl(path));
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
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
  const token = process.env.TELEGRAM_BOT_TOKEN || stringOrUndefined(parsed.telegramBotToken);
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN env var or telegramBotToken in config");
  const config = {
    telegramBotToken: token,
    piWebBaseUrl: stringOrUndefined(parsed.piWebBaseUrl) ?? "http://127.0.0.1:8504",
    machineId: stringOrUndefined(parsed.machineId) ?? "local",
    defaultCwd: requireAbsolutePath(parsed.defaultCwd, "defaultCwd"),
    workspaceAccessPath: stringOrUndefined(parsed.workspaceAccessPath),
    allowedTelegramUserIds: numberArray(parsed.allowedTelegramUserIds ?? [], "allowedTelegramUserIds"),
    adminTelegramUserIds: numberArray(parsed.adminTelegramUserIds ?? [], "adminTelegramUserIds"),
    userRoutes: recordOrEmpty(parsed.userRoutes),
    statePath: stringOrUndefined(parsed.statePath) ?? DEFAULT_STATE_PATH,
    pollTimeoutSeconds: positiveNumber(parsed.pollTimeoutSeconds, 25),
    requestTimeoutMs: positiveNumber(parsed.requestTimeoutMs, 30000),
    responseTimeoutMs: positiveNumber(parsed.responseTimeoutMs, 900000),
    maxTelegramChunk: positiveNumber(parsed.maxTelegramChunk, 3900),
  };
  if (config.workspaceAccessPath !== undefined) config.workspaceAccessPath = expandHome(config.workspaceAccessPath);
  if (config.allowedTelegramUserIds.length === 0 && config.workspaceAccessPath === undefined) throw new Error("allowedTelegramUserIds must contain at least one Telegram user ID when workspaceAccessPath is not configured");
  for (const [userId, route] of Object.entries(config.userRoutes)) {
    if (!/^\d+$/u.test(userId)) throw new Error(`userRoutes key must be a Telegram numeric user ID: ${userId}`);
    if (route.cwd !== undefined) requireAbsolutePath(route.cwd, `userRoutes.${userId}.cwd`);
  }
  config.statePath = expandHome(config.statePath);
  return config;
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
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
