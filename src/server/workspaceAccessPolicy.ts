import { webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { cwdPathsEqual, normalizeRequestCwd } from "./workingDirectory.js";

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
  private readonly policy: WorkspaceAccessPolicy | undefined;
  private readonly enabled: boolean;
  private readonly auth: ClerkJwtVerifier | undefined;
  private readonly trustAuthHeaders: boolean;

  constructor(options: WorkspaceAccessOptions = {}) {
    const env = options.env ?? process.env;
    const configuredPath = options.path ?? env["PI_WEB_WORKSPACE_ACCESS"];
    this.enabled = options.enabled ?? isEnabled(env["PI_WEB_WORKSPACE_AUTH"] ?? env["PI_WEB_WORKSPACE_ACCESS_ENABLED"] ?? (configuredPath === undefined ? undefined : "true"));
    this.policy = this.enabled ? loadWorkspaceAccessPolicy(configuredPath ?? "~/.pi-web/workspace-access.json") : undefined;
    this.auth = this.enabled ? ClerkJwtVerifier.fromEnv(env) : undefined;
    this.trustAuthHeaders = isEnabled(env["PI_WEB_TRUST_AUTH_HEADERS"]);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async authenticateRequest(request: FastifyRequest): Promise<void> {
    if (!this.enabled) return;
    const token = bearerToken(request) ?? clerkSessionCookie(request);
    if (token !== undefined && this.auth !== undefined) {
      setRequestUserId(request, await this.auth.verify(token));
    }
  }

  requireUser(request: FastifyRequest): WorkspaceAccessContext {
    if (!this.enabled) return { userId: "local", isAdmin: true };
    const userId = getRequestUserId(request) ?? (this.trustAuthHeaders ? headerValue(request.headers["x-pi-web-user-id"]) ?? headerValue(request.headers["x-clerk-user-id"]) : undefined);
    if (userId === undefined || userId === "") throw new WorkspaceAccessError(401, "Authentication required");
    const policy = this.requirePolicy();
    const user = policy.users[userId];
    const isAdmin = policy.admins.includes(userId);
    if (user === undefined && !isAdmin) throw new WorkspaceAccessError(403, "User is not allowed in PI WEB");
    return { userId, isAdmin, user };
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
}

export class WorkspaceAccessError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function workspaceAccessErrorStatus(error: unknown): number {
  return error instanceof WorkspaceAccessError ? error.statusCode : 400;
}

export function loadWorkspaceAccessPolicy(path: string): WorkspaceAccessPolicy {
  const filePath = expandHome(path);
  if (!existsSync(filePath)) throw new Error(`Workspace access policy does not exist: ${filePath}`);
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Workspace access policy must be a JSON object: ${filePath}`);
  const admins = optionalStringArray(parsed["admins"], "admins");
  const usersRecord = parsed["users"];
  if (!isRecord(usersRecord)) throw new Error(`Workspace access policy users must be an object: ${filePath}`);
  const users: Record<string, WorkspaceAccessUser> = {};
  for (const [userId, value] of Object.entries(usersRecord)) {
    if (!isRecord(value)) throw new Error(`Workspace access user must be an object: ${userId}`);
    users[userId] = {
      id: userId,
      ...(typeof value["label"] === "string" ? { label: value["label"] } : {}),
      ...(typeof value["email"] === "string" ? { email: value["email"] } : {}),
      workspaces: stringArray(value["workspaces"], `users.${userId}.workspaces`).map((workspace) => normalizeRequestCwd(workspace)),
      telegramUserIds: optionalNumberArray(value["telegramUserIds"], `users.${userId}.telegramUserIds`),
    };
  }
  return { admins, users };
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${name} must be an array of non-empty strings`);
  return value;
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  return stringArray(value, name);
}

function optionalNumberArray(value: unknown, name: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) throw new Error(`${name} must be an array of integer IDs`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ClerkJwtHeader {
  alg?: string;
  kid?: string;
}

interface ClerkJwtPayload {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
}

interface JsonWebKeySet {
  keys?: JsonWebKey[];
}

class ClerkJwtVerifier {
  private jwks: JsonWebKeySet | undefined;
  private jwksLoadedAt = 0;

  private constructor(
    private readonly jwksUrl: string,
    private readonly issuer?: string,
    private readonly audience?: string,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): ClerkJwtVerifier | undefined {
    const issuer = nonEmpty(env["CLERK_ISSUER"] ?? env["PI_WEB_CLERK_ISSUER"]);
    const jwksUrl = nonEmpty(env["CLERK_JWKS_URL"] ?? env["PI_WEB_CLERK_JWKS_URL"]) ?? (issuer === undefined ? undefined : `${issuer.replace(/\/$/u, "")}/.well-known/jwks.json`);
    if (jwksUrl === undefined) return undefined;
    return new ClerkJwtVerifier(jwksUrl, issuer, nonEmpty(env["CLERK_AUDIENCE"] ?? env["PI_WEB_CLERK_AUDIENCE"]));
  }

  async verify(token: string): Promise<string> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new WorkspaceAccessError(401, "Invalid Clerk token");
    const header = parseJwtPart<ClerkJwtHeader>(parts[0] ?? "");
    const payload = parseJwtPart<ClerkJwtPayload>(parts[1] ?? "");
    if (header.alg !== "RS256") throw new WorkspaceAccessError(401, "Unsupported Clerk token algorithm");
    if (header.kid === undefined || header.kid === "") throw new WorkspaceAccessError(401, "Clerk token is missing kid");
    validateJwtPayload(payload, this.issuer, this.audience);
    const key = await this.keyFor(header.kid);
    const ok = await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(parts[2] ?? ""),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) throw new WorkspaceAccessError(401, "Invalid Clerk token signature");
    if (payload.sub === undefined || payload.sub === "") throw new WorkspaceAccessError(401, "Clerk token is missing subject");
    return payload.sub;
  }

  private async keyFor(kid: string): Promise<CryptoKey> {
    const jwks = await this.loadJwks();
    const jwk = jwks.keys?.find((candidate) => candidate.kid === kid);
    if (jwk === undefined) throw new WorkspaceAccessError(401, "Clerk signing key not found");
    return await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }

  private async loadJwks(): Promise<JsonWebKeySet> {
    if (this.jwks !== undefined && Date.now() - this.jwksLoadedAt < 10 * 60 * 1000) return this.jwks;
    const response = await fetch(this.jwksUrl);
    if (!response.ok) throw new WorkspaceAccessError(401, `Failed to load Clerk JWKS: HTTP ${String(response.status)}`);
    const jwks = await response.json() as JsonWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new WorkspaceAccessError(401, "Invalid Clerk JWKS");
    this.jwks = jwks;
    this.jwksLoadedAt = Date.now();
    return jwks;
  }
}

function validateJwtPayload(payload: ClerkJwtPayload, issuer: string | undefined, audience: string | undefined): void {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp === undefined || payload.exp <= now) throw new WorkspaceAccessError(401, "Clerk token expired");
  if (payload.nbf !== undefined && payload.nbf > now + 30) throw new WorkspaceAccessError(401, "Clerk token is not active yet");
  if (issuer !== undefined && payload.iss !== issuer) throw new WorkspaceAccessError(401, "Invalid Clerk token issuer");
  if (audience !== undefined) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
    if (!audiences.includes(audience)) throw new WorkspaceAccessError(401, "Invalid Clerk token audience");
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = headerValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1];
}

function clerkSessionCookie(request: FastifyRequest): string | undefined {
  const cookie = headerValue(request.headers.cookie);
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__session" && value.length > 0) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function parseJwtPart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(part))) as T;
  } catch {
    throw new WorkspaceAccessError(401, "Invalid Clerk token encoding");
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${base64}${"=".repeat((4 - base64.length % 4) % 4)}`;
  return Buffer.from(padded, "base64");
}

function getRequestUserId(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { piWebUserId?: string }).piWebUserId;
}

function setRequestUserId(request: FastifyRequest, userId: string): void {
  (request as FastifyRequest & { piWebUserId?: string }).piWebUserId = userId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
