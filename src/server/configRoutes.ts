import type { FastifyInstance } from "fastify";
import { effectivePiWebConfig, loadPiWebConfig, savePiWebConfig, type LoadOptions, type PiWebConfig } from "../config.js";
import type { PiWebConfigEnvOverrides, PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";

export interface PiWebConfigService {
  read: () => PiWebConfigResponse | Promise<PiWebConfigResponse>;
  write: (config: PiWebConfigValues) => PiWebConfigResponse | Promise<PiWebConfigResponse>;
}

export function createFilePiWebConfigService(options: LoadOptions = {}): PiWebConfigService {
  return {
    read: () => currentPiWebConfigResponse(options),
    write: (config) => {
      savePiWebConfig(config, options);
      return currentPiWebConfigResponse(options);
    },
  };
}

export function currentPiWebConfigResponse(options: LoadOptions = {}): PiWebConfigResponse {
  const loaded = loadPiWebConfig(options);
  const effective = effectivePiWebConfig(options);
  const env = options.env ?? process.env;
  return {
    path: loaded.path,
    exists: loaded.exists,
    config: loaded.config,
    effectiveConfig: effective.config,
    envOverrides: piWebConfigEnvOverrides(env),
  };
}

export function registerConfigRoutes(app: FastifyInstance, service: PiWebConfigService = createFilePiWebConfigService()): void {
  app.get("/api/config", async (_request, reply) => {
    try {
      return await service.read();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { config?: unknown } | undefined }>("/api/config", async (request, reply) => {
    try {
      return await service.write(parseConfigRequest(request.body?.config));
    } catch (error) {
      const status = isConfigValidationError(error) ? 400 : 500;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });
}

function parseConfigRequest(value: unknown): PiWebConfig {
  if (!isRecord(value)) throw new Error("PI WEB config update must include a config object");
  const config: PiWebConfig = {};
  const host = value["host"];
  const port = value["port"];
  const allowedHosts = value["allowedHosts"];
  const shortcuts = value["shortcuts"];
  const plugins = value["plugins"];
  const branding = value["branding"];
  const spawnSessions = value["spawnSessions"];
  const subsessions = value["subsessions"];
  if (host !== undefined) {
    if (typeof host !== "string") throw new Error("PI WEB config host must be a string");
    config.host = host;
  }
  if (port !== undefined) {
    if (typeof port !== "number") throw new Error("PI WEB config port must be a number");
    config.port = port;
  }
  if (allowedHosts !== undefined) config.allowedHosts = parseAllowedHostsRequest(allowedHosts);
  if (shortcuts !== undefined) config.shortcuts = parseShortcutsRequest(shortcuts);
  if (plugins !== undefined) config.plugins = parsePluginsRequest(plugins);
  if (branding !== undefined) config.branding = parseBrandingRequest(branding);
  if (spawnSessions !== undefined) {
    if (typeof spawnSessions !== "boolean") throw new Error("PI WEB config spawnSessions must be a boolean");
    config.spawnSessions = spawnSessions;
  }
  if (subsessions !== undefined) {
    if (typeof subsessions !== "boolean") throw new Error("PI WEB config subsessions must be a boolean");
    config.subsessions = subsessions;
  }
  return config;
}

function parseAllowedHostsRequest(value: unknown): string[] | true {
  if (value === true) return true;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("PI WEB config allowedHosts must be true or an array of strings");
  }
  return value;
}

function parseShortcutsRequest(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) throw new Error("PI WEB config shortcuts must be an object");
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) throw new Error("PI WEB config shortcut values must be non-empty strings or null");
    return [actionId, shortcut];
  }));
}

function parsePluginsRequest(value: unknown): NonNullable<PiWebConfig["plugins"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("PI WEB config plugins must be an object");
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebPluginId(pluginId)) throw new Error("PI WEB config plugin ids are invalid");
    if (!isRecord(config) || Array.isArray(config)) throw new Error("PI WEB config plugin entries must be objects");
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("PI WEB config plugin enabled values must be booleans");
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error("PI WEB config plugin settings must be objects");
    return [pluginId, config];
  }));
}

const PI_WEB_BRANDING_KEYS = ["siteName", "siteTitle", "siteShortName", "description", "logoUrl", "faviconUrl", "appleTouchIconUrl"] as const;
type PiWebBrandingField = (typeof PI_WEB_BRANDING_KEYS)[number];
const PI_WEB_BRANDING_KEY_SET = new Set<string>(PI_WEB_BRANDING_KEYS);

function parseBrandingRequest(value: unknown): NonNullable<PiWebConfig["branding"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("PI WEB config branding must be an object");
  const result: Partial<NonNullable<PiWebConfig["branding"]>> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!isAllowedBrandingField(key)) {
      throw new Error(`PI WEB config branding has unknown field: ${key}`);
    }
    result[key] = parseBrandingField(key, rawValue);
  }
  return result;
}

function isAllowedBrandingField(field: string): field is PiWebBrandingField {
  return PI_WEB_BRANDING_KEY_SET.has(field);
}

function parseBrandingField(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`PI WEB config branding ${key} must be a non-empty string`);
  return value.trim();
}

function piWebConfigEnvOverrides(env: NodeJS.ProcessEnv): PiWebConfigEnvOverrides {
  return {
    host: isEnvSet(env["PI_WEB_HOST"]),
    port: isEnvSet(env["PI_WEB_PORT"]) || isEnvSet(env["PORT"]),
    allowedHosts: isEnvSet(env["PI_WEB_ALLOWED_HOSTS"]),
    spawnSessions: isEnvSet(env["PI_WEB_SPAWN_SESSIONS"]),
    subsessions: isEnvSet(env["PI_WEB_SUBSESSIONS"]),
  };
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function isConfigValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PI WEB config");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
