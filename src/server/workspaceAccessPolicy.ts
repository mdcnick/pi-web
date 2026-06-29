import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { createWorkspaceAuthProvider, type WorkspaceAuthProvider, type WorkspaceAuthProviderKind, type WorkspaceAuthPublicSettings } from "./auth/workspaceAuthProvider.js";
import { cwdPathsEqual, normalizeRequestCwd } from "./workingDirectory.js";

declare module "fastify" {
  interface FastifyRequest {
    piWebUserId?: string;
    piWebInternalAdmin?: boolean;
  }
}

export interface WorkspaceAccessUser {
  id: string;
  label?: string;
  email?: string;
  workspaces: string[];
  telegramUserIds: number[];
}

export interface WorkspaceAccessPolicy {
  admins: string[];
  users: Record<string, WorkspaceAccessUser>;
}

export interface WorkspaceAccessContext {
  userId: string;
  isAdmin: boolean;
  user?: WorkspaceAccessUser;
}

export interface WorkspaceAccessOptions {
  enabled?: boolean;
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export class WorkspaceAccessController {
  private policy: WorkspaceAccessPolicy | undefined;
  private readonly enabled: boolean;
  private readonly path: string;
  private readonly trustAuthHeaders: boolean;
  private readonly authProvider: WorkspaceAuthProvider;

  constructor(options: WorkspaceAccessOptions = {}) {
    const env = options.env ?? process.env;
    const configuredPath = options.path ?? env["PI_WEB_WORKSPACE_ACCESS"];
    this.path = configuredPath ?? "~/.pi-web/workspace-access.json";
    this.authProvider = createWorkspaceAuthProvider(env);
    const defaultEnabled = env["PI_WEB_WORKSPACE_AUTH"]
      ?? env["PI_WEB_WORKSPACE_ACCESS_ENABLED"]
      ?? (this.authProvider.isConfigured() ? "true" : (configuredPath === undefined ? undefined : "true"));
    this.enabled = options.enabled ?? isEnabled(defaultEnabled);
    this.policy = this.enabled ? loadInitialWorkspaceAccessPolicy(this.path, this.authProvider.allowMissingPolicy()) : undefined;
    this.trustAuthHeaders = isEnabled(env["PI_WEB_TRUST_AUTH_HEADERS"]);
  }

  provider(): WorkspaceAuthProviderKind {
    return this.authProvider.kind;
  }

  publicAuthSettings(): WorkspaceAuthPublicSettings {
    return this.authProvider.publicSettings(this.enabled);
  }

  adminBootstrapAvailable(): boolean {
    if (!this.enabled || this.authProvider.kind !== "better-auth") return false;
    return this.currentPolicy().admins.length === 0;
  }

  bootstrapAdmin(request: FastifyRequest): WorkspaceAccessPolicy {
    if (!this.adminBootstrapAvailable()) throw new WorkspaceAccessError(403, "Admin bootstrap is not available");
    const userId = getRequestUserId(request);
    if (userId === undefined || userId === "") throw new WorkspaceAccessError(401, "Authentication required");
    const policy = this.currentPolicy();
    policy.admins = [userId];
    policy.users[userId] ??= { id: userId, workspaces: [], telegramUserIds: [] };
    return this.savePolicy(policy);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  policyPath(): string {
    return expandHome(this.path);
  }

  hasInternalAuth(): boolean {
    return this.publicAuthSettings().internalAuth === true;
  }

  policyExists(): boolean {
    return existsSync(this.policyPath());
  }

  currentPolicy(): WorkspaceAccessPolicy {
    if (this.policy !== undefined) return clonePolicy(this.policy);
    if (this.policyExists()) return loadWorkspaceAccessPolicy(this.path);
    return emptyWorkspaceAccessPolicy();
  }

  savePolicy(policy: WorkspaceAccessPolicy): WorkspaceAccessPolicy {
    const normalized = normalizeWorkspaceAccessPolicy(policy);
    const filePath = this.policyPath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    this.policy = normalized;
    return clonePolicy(normalized);
  }

  async authenticateRequest(request: FastifyRequest): Promise<void> {
    if (!this.enabled) return;
    await this.authProvider.authenticateRequest(request);
  }

  requireUser(request: FastifyRequest): WorkspaceAccessContext {
    if (!this.enabled) return { userId: "local", isAdmin: true };
    const userId = getRequestUserId(request) ?? (this.trustAuthHeaders ? headerValue(request.headers["x-pi-web-user-id"]) : undefined);
    if (userId === undefined || userId === "") throw new WorkspaceAccessError(401, "Authentication required");
    const policy = this.requirePolicy();
    const user = policy.users[userId];
    const isAdmin = (request.piWebInternalAdmin === true && getRequestUserId(request) === userId) || policy.admins.includes(userId);
    if (user === undefined && !isAdmin) throw new WorkspaceAccessError(403, "User is not allowed in PI WEB");
    return { userId, isAdmin, ...(user === undefined ? {} : { user }) };
  }

  requireAdmin(request: FastifyRequest): WorkspaceAccessContext {
    const context = this.requireUser(request);
    if (this.enabled && !context.isAdmin) throw new WorkspaceAccessError(403, "Admin access required");
    return context;
  }

  requireWorkspace(request: FastifyRequest, cwd: string): WorkspaceAccessContext {
    const context = this.requireUser(request);
    if (!this.enabled || context.isAdmin) return context;
    const normalized = normalizeRequestCwd(cwd);
    const allowed = context.user?.workspaces.some((workspace) => cwdPathsEqual(workspace, normalized)) ?? false;
    if (!allowed) throw new WorkspaceAccessError(403, "Workspace access denied");
    return context;
  }

  canAccessWorkspace(context: WorkspaceAccessContext, cwd: string): boolean {
    if (!this.enabled || context.isAdmin) return true;
    const normalized = normalizeRequestCwd(cwd);
    return context.user?.workspaces.some((workspace) => cwdPathsEqual(workspace, normalized)) ?? false;
  }

  private requirePolicy(): WorkspaceAccessPolicy {
    if (this.policy === undefined) throw new WorkspaceAccessError(500, "Workspace access policy is not loaded");
    return this.policy;
  }
}

export class WorkspaceAccessError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function workspaceAccessErrorStatus(error: unknown): number {
  if (error instanceof WorkspaceAccessError) return error.statusCode;
  if (error instanceof Error && error.message.endsWith("not found")) return 404;
  return 400;
}

function loadInitialWorkspaceAccessPolicy(path: string, allowMissing: boolean): WorkspaceAccessPolicy {
  const filePath = expandHome(path);
  if (!existsSync(filePath)) {
    if (allowMissing) return emptyWorkspaceAccessPolicy();
    throw new Error(`Workspace access policy does not exist: ${filePath}`);
  }
  return loadWorkspaceAccessPolicy(path);
}

export function loadWorkspaceAccessPolicy(path: string): WorkspaceAccessPolicy {
  const filePath = expandHome(path);
  if (!existsSync(filePath)) throw new Error(`Workspace access policy does not exist: ${filePath}`);
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return normalizeWorkspaceAccessPolicy(parsed, filePath);
}

export function emptyWorkspaceAccessPolicy(): WorkspaceAccessPolicy {
  return { admins: [], users: {} };
}

export function normalizeWorkspaceAccessPolicy(value: unknown, filePath = "workspace access policy"): WorkspaceAccessPolicy {
  if (!isRecord(value)) throw new Error(`Workspace access policy must be a JSON object: ${filePath}`);
  const admins = optionalStringArray(value["admins"], "admins");
  const usersRecord = value["users"];
  if (!isRecord(usersRecord)) throw new Error(`Workspace access policy users must be an object: ${filePath}`);
  const users: Record<string, WorkspaceAccessUser> = {};
  for (const [userId, userValue] of Object.entries(usersRecord)) {
    if (!isRecord(userValue)) throw new Error(`Workspace access user must be an object: ${userId}`);
    users[userId] = {
      id: userId,
      ...(typeof userValue["label"] === "string" ? { label: userValue["label"] } : {}),
      ...(typeof userValue["email"] === "string" ? { email: userValue["email"] } : {}),
      workspaces: stringArray(userValue["workspaces"], `users.${userId}.workspaces`).map((workspace) => normalizeRequestCwd(workspace)),
      telegramUserIds: optionalNumberArray(userValue["telegramUserIds"], `users.${userId}.telegramUserIds`),
    };
  }
  return { admins, users };
}

function clonePolicy(policy: WorkspaceAccessPolicy): WorkspaceAccessPolicy {
  return {
    admins: [...policy.admins],
    users: Object.fromEntries(Object.entries(policy.users).map(([userId, user]) => [userId, {
      ...user,
      workspaces: [...user.workspaces],
      telegramUserIds: [...user.telegramUserIds],
    }])),
  };
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  return value === "1" || value.toLowerCase() === "true";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  return stringArray(value, name);
}

function optionalNumberArray(value: unknown, name: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
    throw new Error(`${name} must be an array of integer IDs`);
  }
  return value.filter((item): item is number => typeof item === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestUserId(request: FastifyRequest): string | undefined {
  return request.piWebUserId;
}
