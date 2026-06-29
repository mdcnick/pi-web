import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { WorkspaceAccessController, workspaceAccessErrorStatus } from "./workspaceAccessPolicy.js";
import { normalizeRequestCwd } from "./workingDirectory.js";

const DEFAULT_CONFIG_PATH = "~/.pi-web/telegram-gateway/config.json";
const DEFAULT_STATE_PATH = "~/.pi-web/telegram-gateway/state.json";

interface TelegramGatewayUserRoute {
  label?: string | undefined;
  cwd?: string | undefined;
  sessionId?: string | undefined;
}

interface TelegramGatewaySessionBotConfig {
  id?: string | undefined;
  label?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramUserId?: number | undefined;
  allowedTelegramUserIds?: number[] | undefined;
  adminTelegramUserIds?: number[] | undefined;
  cwd?: string | undefined;
  sessionId?: string | undefined;
  enabled?: boolean | undefined;
}

interface TelegramGatewayConfigFile {
  $schemaComment?: string | undefined;
  telegramBotToken?: string | undefined;
  piWebBaseUrl?: string | undefined;
  machineId?: string | undefined;
  defaultCwd?: string | undefined;
  workspaceAccessPath?: string | undefined;
  allowedTelegramUserIds?: number[] | undefined;
  adminTelegramUserIds?: number[] | undefined;
  userRoutes?: Record<string, TelegramGatewayUserRoute> | undefined;
  sessionBots?: TelegramGatewaySessionBotConfig[] | undefined;
  statePath?: string | undefined;
  pollTimeoutSeconds?: number | undefined;
  requestTimeoutMs?: number | undefined;
  responseTimeoutMs?: number | undefined;
  maxTelegramChunk?: number | undefined;
}

interface TelegramGatewayUserSettings {
  telegramUserId: number;
  label?: string | undefined;
  cwd?: string | undefined;
  sessionId?: string | undefined;
  admin?: boolean | undefined;
  botId?: string | undefined;
  botLabel?: string | undefined;
  botToken?: string | undefined;
  botTokenConfigured?: boolean | undefined;
  enabled?: boolean | undefined;
}

interface TelegramGatewaySettingsRequest {
  telegramBotToken?: unknown;
  piWebBaseUrl?: unknown;
  machineId?: unknown;
  defaultCwd?: unknown;
  workspaceAccessPath?: unknown;
  statePath?: unknown;
  users?: unknown;
}

interface TelegramBotTokenRequest {
  token?: unknown;
  botId?: unknown;
}

interface TelegramUserFromUpdate {
  id: number;
  is_bot?: boolean | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  username?: string | undefined;
}

interface TelegramGatewayProcessState {
  child?: ChildProcess | undefined;
  startedAt?: string | undefined;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; at: string } | undefined;
  lastError?: string | undefined;
  logs: string[];
}

export interface TelegramGatewayRoutesOptions {
  workspaceAccess?: WorkspaceAccessController;
  configPath?: string;
  gatewayScriptPath?: string;
  processState?: TelegramGatewayProcessState;
}

export function registerTelegramGatewayRoutes(app: FastifyInstance, options: TelegramGatewayRoutesOptions = {}): void {
  const workspaceAccess = options.workspaceAccess ?? new WorkspaceAccessController({ enabled: false });
  const configPath = expandHome(options.configPath ?? DEFAULT_CONFIG_PATH);
  const processState = options.processState ?? { logs: [] };

  app.get("/api/telegram-gateway", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const config = await readGatewayConfig(configPath);
      return gatewaySettingsResponse(configPath, config, processState);
    } catch (error) {
      return sendAccessError(reply, error);
    }
  });

  app.put<{ Body: TelegramGatewaySettingsRequest | undefined }>("/api/telegram-gateway", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const existing = await readGatewayConfig(configPath);
      const next = parseSettingsRequest(request.body, existing);
      await saveGatewayConfig(configPath, next);
      return gatewaySettingsResponse(configPath, next, processState);
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: TelegramBotTokenRequest | undefined }>("/api/telegram-gateway/test-token", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const config = await readGatewayConfig(configPath);
      const token = tokenForRequest(request.body?.token, config, request.body?.botId);
      const bot = await telegram(token, "getMe", {});
      return { ok: true, bot };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: TelegramBotTokenRequest | undefined }>("/api/telegram-gateway/discover-users", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const config = await readGatewayConfig(configPath);
      const token = tokenForRequest(request.body?.token, config, request.body?.botId);
      const updates = await telegram(token, "getUpdates", { timeout: 1, allowed_updates: ["message"] }, 10_000);
      const users = uniqueTelegramUsers(updates);
      return { users };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/telegram-gateway/start", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const config = await readGatewayConfig(configPath);
      if (processState.child !== undefined && processState.child.exitCode === null) return gatewaySettingsResponse(configPath, config, processState);
      if (!hasConfiguredBotToken(config)) throw new Error("Save at least one session bot token before starting the gateway");
      const script = options.gatewayScriptPath ?? resolveGatewayScriptPath();
      if (!existsSync(script)) throw new Error(`Gateway script not found: ${script}`);
      startGatewayProcess(processState, script, configPath);
      return gatewaySettingsResponse(configPath, config, processState);
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/telegram-gateway/stop", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const config = await readGatewayConfig(configPath);
      stopGatewayProcess(processState);
      return gatewaySettingsResponse(configPath, config, processState);
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function readGatewayConfig(path: string): Promise<TelegramGatewayConfigFile> {
  try {
    return normalizeGatewayConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return defaultGatewayConfig();
    throw error;
  }
}

async function saveGatewayConfig(path: string, config: TelegramGatewayConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function gatewaySettingsResponse(path: string, config: TelegramGatewayConfigFile, processState: TelegramGatewayProcessState) {
  const users = configToUsers(config);
  return {
    path,
    exists: existsSync(path),
    tokenConfigured: hasConfiguredBotToken(config),
    config: {
      piWebBaseUrl: config.piWebBaseUrl ?? "http://127.0.0.1:8504",
      machineId: config.machineId ?? "local",
      defaultCwd: config.defaultCwd ?? "",
      workspaceAccessPath: config.workspaceAccessPath ?? "",
      statePath: config.statePath ?? DEFAULT_STATE_PATH,
      users,
    },
    process: gatewayProcessResponse(processState),
  };
}

function gatewayProcessResponse(processState: TelegramGatewayProcessState) {
  const running = processState.child !== undefined && processState.child.exitCode === null;
  return {
    running,
    pid: running ? processState.child?.pid : undefined,
    startedAt: processState.startedAt,
    lastExit: processState.lastExit,
    lastError: processState.lastError,
    logs: processState.logs.slice(-80),
  };
}

function startGatewayProcess(processState: TelegramGatewayProcessState, script: string, configPath: string): void {
  processState.lastError = undefined;
  processState.logs = [];
  const child = spawn(process.execPath, [script, "--config", configPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processState.child = child;
  processState.startedAt = new Date().toISOString();
  child.stdout?.on("data", (chunk) => appendLog(processState, String(chunk)));
  child.stderr?.on("data", (chunk) => appendLog(processState, String(chunk)));
  child.on("error", (error) => {
    processState.lastError = error.message;
    appendLog(processState, `[telegram-gateway] process error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    processState.lastExit = { code, signal, at: new Date().toISOString() };
    if (processState.child === child) processState.child = undefined;
    appendLog(processState, `[telegram-gateway] exited code=${String(code)} signal=${String(signal)}`);
  });
}

function stopGatewayProcess(processState: TelegramGatewayProcessState): void {
  if (processState.child === undefined || processState.child.exitCode !== null) return;
  processState.child.kill("SIGTERM");
}

function appendLog(processState: TelegramGatewayProcessState, text: string): void {
  const lines = text.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line !== "");
  processState.logs.push(...lines);
  if (processState.logs.length > 200) processState.logs.splice(0, processState.logs.length - 200);
}

function parseSettingsRequest(body: TelegramGatewaySettingsRequest | undefined, existing: TelegramGatewayConfigFile): TelegramGatewayConfigFile {
  if (!isRecord(body)) throw new Error("Telegram gateway settings are required");
  const defaultCwd = requireAbsoluteString(body["defaultCwd"], "defaultCwd");
  const users = parseUsers(body["users"]);
  const config: TelegramGatewayConfigFile = {
    $schemaComment: "Saved by PI WEB Telegram Gateway UI. This file may contain a Telegram bot token; keep it private.",
    telegramBotToken: mergeSecret(body["telegramBotToken"], existing.telegramBotToken),
    piWebBaseUrl: optionalString(body["piWebBaseUrl"]) ?? existing.piWebBaseUrl ?? "http://127.0.0.1:8504",
    machineId: optionalString(body["machineId"]) ?? existing.machineId ?? "local",
    defaultCwd,
    statePath: optionalString(body["statePath"]) ?? existing.statePath ?? DEFAULT_STATE_PATH,
    allowedTelegramUserIds: [],
    adminTelegramUserIds: [],
    userRoutes: {},
    sessionBots: users.map((user, index) => {
      const existingBot = findExistingSessionBot(existing, user.botId);
      const id = user.botId ?? sessionBotId(user, index);
      const legacyMigrationToken = existing.sessionBots?.length === 0 && index === 0 ? existing.telegramBotToken : undefined;
      const botToken = mergeSecret(user.botToken, existingBot?.telegramBotToken ?? legacyMigrationToken);
      const allowedTelegramUserIds = user.telegramUserId > 0 ? [user.telegramUserId] : [];
      return {
        id,
        label: user.botLabel ?? user.label ?? `Telegram bot ${String(index + 1)}`,
        telegramBotToken: botToken,
        ...(user.telegramUserId > 0 ? { telegramUserId: user.telegramUserId } : {}),
        allowedTelegramUserIds,
        adminTelegramUserIds: user.admin === true ? allowedTelegramUserIds : [],
        cwd: user.cwd ?? defaultCwd,
        ...(user.sessionId === undefined ? {} : { sessionId: user.sessionId }),
        enabled: user.enabled !== false,
      };
    }),
    pollTimeoutSeconds: existing.pollTimeoutSeconds ?? 25,
    requestTimeoutMs: existing.requestTimeoutMs ?? 30000,
    responseTimeoutMs: existing.responseTimeoutMs ?? 900000,
    maxTelegramChunk: existing.maxTelegramChunk ?? 3900,
  };
  const workspaceAccessPath = optionalString(body["workspaceAccessPath"]) ?? existing.workspaceAccessPath;
  if (workspaceAccessPath !== undefined && workspaceAccessPath !== "") config.workspaceAccessPath = workspaceAccessPath;
  return normalizeGatewayConfig(config);
}

function parseUsers(value: unknown): TelegramGatewayUserSettings[] {
  if (!Array.isArray(value)) throw new Error("users must be an array");
  const seenBotIds = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`users.${String(index)} must be an object`);
    const id = Number(item["telegramUserId"]);
    if (!Number.isInteger(id) || id < 0) throw new Error(`users.${String(index)}.telegramUserId must be a numeric Telegram user ID`);
    const cwd = item["cwd"] === undefined || item["cwd"] === "" ? undefined : normalizeRequestCwd(requireAbsoluteString(item["cwd"], `users.${String(index)}.cwd`));
    const label = optionalString(item["label"]);
    const sessionId = optionalString(item["sessionId"]);
    const admin = item["admin"] === true;
    const botId = optionalString(item["botId"]);
    if (botId !== undefined) {
      if (!/^[a-zA-Z0-9._:-]+$/u.test(botId)) throw new Error(`users.${String(index)}.botId may only contain letters, numbers, dots, underscores, colons, or dashes`);
      if (seenBotIds.has(botId)) throw new Error(`Duplicate Telegram bot row ID: ${botId}`);
      seenBotIds.add(botId);
    }
    const botLabel = optionalString(item["botLabel"]);
    const botToken = optionalString(item["botToken"]);
    const enabled = item["enabled"] !== false;
    return { telegramUserId: id, ...(label === undefined ? {} : { label }), ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }), admin, ...(botId === undefined ? {} : { botId }), ...(botLabel === undefined ? {} : { botLabel }), ...(botToken === undefined ? {} : { botToken }), enabled };
  });
}

function configToUsers(config: TelegramGatewayConfigFile): TelegramGatewayUserSettings[] {
  const sessionBots = config.sessionBots ?? [];
  if (sessionBots.length > 0) {
    return sessionBots.map((bot, index) => {
      const allowed = bot.allowedTelegramUserIds ?? (bot.telegramUserId === undefined ? [] : [bot.telegramUserId]);
      const telegramUserId = allowed[0] ?? 0;
      const admins = new Set(bot.adminTelegramUserIds ?? []);
      return {
        telegramUserId,
        ...(bot.label === undefined ? {} : { label: bot.label, botLabel: bot.label }),
        cwd: bot.cwd ?? config.defaultCwd,
        ...(bot.sessionId === undefined ? {} : { sessionId: bot.sessionId }),
        admin: admins.has(telegramUserId),
        botId: bot.id ?? sessionBotId({ telegramUserId, sessionId: bot.sessionId, label: bot.label }, index),
        botTokenConfigured: stringOrUndefined(bot.telegramBotToken) !== undefined,
        enabled: bot.enabled !== false,
      };
    });
  }
  const allowed = config.allowedTelegramUserIds ?? [];
  const admins = new Set(config.adminTelegramUserIds ?? []);
  return allowed.map((telegramUserId) => {
    const route = config.userRoutes?.[String(telegramUserId)] ?? {};
    return {
      telegramUserId,
      ...(route.label === undefined ? {} : { label: route.label }),
      cwd: route.cwd ?? config.defaultCwd,
      ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
      admin: admins.has(telegramUserId),
      botTokenConfigured: stringOrUndefined(config.telegramBotToken) !== undefined || stringOrUndefined(process.env["TELEGRAM_BOT_TOKEN"]) !== undefined,
    };
  });
}

function defaultGatewayConfig(): TelegramGatewayConfigFile {
  return {
    $schemaComment: "Saved by PI WEB Telegram Gateway UI. Prefer a private local file; never commit bot tokens.",
    telegramBotToken: "",
    piWebBaseUrl: "http://127.0.0.1:8504",
    machineId: "local",
    defaultCwd: process.cwd(),
    allowedTelegramUserIds: [],
    adminTelegramUserIds: [],
    userRoutes: {},
    sessionBots: [],
    statePath: DEFAULT_STATE_PATH,
    pollTimeoutSeconds: 25,
    requestTimeoutMs: 30000,
    responseTimeoutMs: 900000,
    maxTelegramChunk: 3900,
  };
}

function normalizeGatewayConfig(value: unknown): TelegramGatewayConfigFile {
  if (!isRecord(value)) throw new Error("Telegram gateway config must be an object");
  const defaultConfig = defaultGatewayConfig();
  const allowedTelegramUserIds = numberArray(value["allowedTelegramUserIds"] ?? [], "allowedTelegramUserIds");
  const schemaComment = optionalString(value["$schemaComment"]);
  const workspaceAccessPath = optionalString(value["workspaceAccessPath"]);
  return {
    ...(schemaComment === undefined ? {} : { $schemaComment: schemaComment }),
    telegramBotToken: typeof value["telegramBotToken"] === "string" ? value["telegramBotToken"] : "",
    piWebBaseUrl: optionalString(value["piWebBaseUrl"]) ?? defaultConfig.piWebBaseUrl,
    machineId: optionalString(value["machineId"]) ?? defaultConfig.machineId,
    defaultCwd: normalizeRequestCwd(optionalString(value["defaultCwd"]) ?? defaultConfig.defaultCwd ?? process.cwd()),
    ...(workspaceAccessPath === undefined ? {} : { workspaceAccessPath }),
    allowedTelegramUserIds,
    adminTelegramUserIds: numberArray(value["adminTelegramUserIds"] ?? [], "adminTelegramUserIds"),
    userRoutes: parseUserRoutes(value["userRoutes"]),
    sessionBots: parseSessionBots(value["sessionBots"]),
    statePath: optionalString(value["statePath"]) ?? DEFAULT_STATE_PATH,
    pollTimeoutSeconds: positiveNumber(value["pollTimeoutSeconds"], 25),
    requestTimeoutMs: positiveNumber(value["requestTimeoutMs"], 30000),
    responseTimeoutMs: positiveNumber(value["responseTimeoutMs"], 900000),
    maxTelegramChunk: positiveNumber(value["maxTelegramChunk"], 3900),
  };
}

function parseUserRoutes(value: unknown): Record<string, TelegramGatewayUserRoute> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("userRoutes must be an object");
  return Object.fromEntries(Object.entries(value).map(([telegramUserId, route]) => {
    if (!/^\d+$/u.test(telegramUserId)) throw new Error(`userRoutes key must be a Telegram numeric user ID: ${telegramUserId}`);
    if (!isRecord(route)) throw new Error(`userRoutes.${telegramUserId} must be an object`);
    const label = optionalString(route["label"]);
    const cwd = route["cwd"] === undefined ? undefined : normalizeRequestCwd(requireAbsoluteString(route["cwd"], `userRoutes.${telegramUserId}.cwd`));
    const sessionId = optionalString(route["sessionId"]);
    return [telegramUserId, { ...(label === undefined ? {} : { label }), ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }) }];
  }));
}

function parseSessionBots(value: unknown): TelegramGatewaySessionBotConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("sessionBots must be an array");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`sessionBots.${String(index)} must be an object`);
    const id = optionalString(item["id"]) ?? `bot-${String(index + 1)}`;
    if (!/^[a-zA-Z0-9._:-]+$/u.test(id)) throw new Error(`sessionBots.${String(index)}.id may only contain letters, numbers, dots, underscores, colons, or dashes`);
    if (seen.has(id)) throw new Error(`Duplicate session bot ID: ${id}`);
    seen.add(id);
    const label = optionalString(item["label"]);
    const telegramBotToken = typeof item["telegramBotToken"] === "string" ? item["telegramBotToken"] : "";
    const telegramUserId = item["telegramUserId"] === undefined ? undefined : Number(item["telegramUserId"]);
    if (telegramUserId !== undefined && !Number.isInteger(telegramUserId)) throw new Error(`sessionBots.${String(index)}.telegramUserId must be a numeric Telegram user ID`);
    const allowedTelegramUserIds = numberArray(item["allowedTelegramUserIds"] ?? (telegramUserId === undefined ? [] : [telegramUserId]), `sessionBots.${String(index)}.allowedTelegramUserIds`);
    const adminTelegramUserIds = numberArray(item["adminTelegramUserIds"] ?? [], `sessionBots.${String(index)}.adminTelegramUserIds`);
    const cwd = item["cwd"] === undefined || item["cwd"] === "" ? undefined : normalizeRequestCwd(requireAbsoluteString(item["cwd"], `sessionBots.${String(index)}.cwd`));
    const sessionId = optionalString(item["sessionId"]);
    return { id, ...(label === undefined ? {} : { label }), telegramBotToken, ...(telegramUserId === undefined ? {} : { telegramUserId }), allowedTelegramUserIds, adminTelegramUserIds, ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }), enabled: item["enabled"] !== false };
  });
}

function findExistingSessionBot(config: TelegramGatewayConfigFile, botId: string | undefined): TelegramGatewaySessionBotConfig | undefined {
  if (botId === undefined) return undefined;
  return config.sessionBots?.find((bot) => bot.id === botId);
}

function sessionBotId(user: Pick<TelegramGatewayUserSettings, "telegramUserId" | "sessionId" | "label">, index: number): string {
  const base = user.sessionId ?? user.label ?? `telegram-${String(user.telegramUserId || index + 1)}`;
  const slug = base.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug === "" ? `bot-${String(index + 1)}` : slug.slice(0, 80);
}

function tokenForRequest(value: unknown, config: TelegramGatewayConfigFile, botIdValue?: unknown): string {
  const botId = optionalString(botIdValue);
  const sessionBotToken = botId === undefined ? undefined : stringOrUndefined(config.sessionBots?.find((bot) => bot.id === botId)?.telegramBotToken);
  const token = optionalString(value) ?? sessionBotToken ?? stringOrUndefined(config.telegramBotToken) ?? stringOrUndefined(process.env["TELEGRAM_BOT_TOKEN"]);
  if (token === undefined) throw new Error("Telegram bot token is required");
  return token;
}

function hasConfiguredBotToken(config: TelegramGatewayConfigFile): boolean {
  return stringOrUndefined(config.telegramBotToken) !== undefined
    || stringOrUndefined(process.env["TELEGRAM_BOT_TOKEN"]) !== undefined
    || (config.sessionBots ?? []).some((bot) => bot.enabled !== false && stringOrUndefined(bot.telegramBotToken) !== undefined);
}

async function telegram(token: string, method: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json() as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || data.ok !== true) throw new Error(`Telegram ${method} failed: ${data.description ?? response.statusText}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function uniqueTelegramUsers(updates: unknown): TelegramUserFromUpdate[] {
  if (!Array.isArray(updates)) return [];
  const users = new Map<number, TelegramUserFromUpdate>();
  for (const update of updates) {
    if (!isRecord(update)) continue;
    const message = update["message"];
    if (!isRecord(message)) continue;
    const from = message["from"];
    if (!isRecord(from)) continue;
    if (typeof from["id"] !== "number" || !Number.isInteger(from["id"])) continue;
    users.set(from["id"], {
      id: from["id"],
      ...(typeof from["is_bot"] === "boolean" ? { is_bot: from["is_bot"] } : {}),
      ...(typeof from["first_name"] === "string" ? { first_name: from["first_name"] } : {}),
      ...(typeof from["last_name"] === "string" ? { last_name: from["last_name"] } : {}),
      ...(typeof from["username"] === "string" ? { username: from["username"] } : {}),
    });
  }
  return [...users.values()];
}

function resolveGatewayScriptPath(): string {
  const sourcePath = join(process.cwd(), "pi-web-plugins", "telegram-gateway", "gateway.mjs");
  if (existsSync(sourcePath)) return sourcePath;
  const distServerDir = dirname(fileURLToPath(import.meta.url));
  return join(distServerDir, "..", "pi-web-plugins", "telegram-gateway", "gateway.mjs");
}

function mergeSecret(value: unknown, existing: string | undefined): string {
  const incoming = typeof value === "string" ? value.trim() : "";
  if (incoming !== "") return incoming;
  return existing ?? "";
}

function requireAbsoluteString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  if (!value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return normalizeRequestCwd(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function numberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) throw new Error(`${name} must be an array of integer IDs`);
  return value.filter((item): item is number => typeof item === "number");
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}

function errorStatus(error: unknown): number {
  return error instanceof Error && (error.message.includes("required") || error.message.includes("must be") || error.message.includes("Duplicate")) ? 400 : workspaceAccessErrorStatus(error);
}

function sendAccessError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
}
