import { timingSafeEqual, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { FastifyRequest } from "fastify";
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
  private readonly auth: ClerkJwtVerifier | undefined;
  private readonly trustAuthHeaders: boolean;
  private readonly publishableKey: string | undefined;
  private readonly internalAuth: InternalAdminAuth | undefined;

  constructor(options: WorkspaceAccessOptions = {}) {
    const env = options.env ?? process.env;
    const configuredPath = options.path ?? env["PI_WEB_WORKSPACE_ACCESS"];
    this.path = configuredPath ?? "~/.pi-web/workspace-access.json";
    this.internalAuth = InternalAdminAuth.fromEnv(env);
    this.enabled = options.enabled ?? isEnabled(env["PI_WEB_WORKSPACE_AUTH"] ?? env["PI_WEB_WORKSPACE_ACCESS_ENABLED"] ?? (this.internalAuth === undefined ? (configuredPath === undefined ? undefined : "true") : "true"));
    this.policy = this.enabled ? loadInitialWorkspaceAccessPolicy(this.path, this.internalAuth !== undefined) : undefined;
    this.auth = this.enabled ? ClerkJwtVerifier.fromEnv(env) : undefined;
    this.trustAuthHeaders = isEnabled(env["PI_WEB_TRUST_AUTH_HEADERS"]);
    this.publishableKey = nonEmpty(env["CLERK_PUBLISHABLE_KEY"] ?? env["PI_WEB_CLERK_PUBLISHABLE_KEY"] ?? env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]) ?? publishableKeyFromIssuer(env["CLERK_ISSUER"] ?? env["PI_WEB_CLERK_ISSUER"]);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  policyPath(): string {
    return expandHome(this.path);
  }

  clerkPublishableKey(): string | undefined {
    return this.publishableKey;
  }

  hasInternalAuth(): boolean {
    return this.internalAuth !== undefined;
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
    const token = bearerToken(request) ?? accessTokenQuery(request) ?? clerkSessionCookie(request);
    if (token !== undefined && this.internalAuth?.matches(token) === true) {
      setRequestUserId(request, this.internalAuth.userId);
      request.piWebInternalAdmin = true;
      return;
    }
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${name} must be an array of non-empty strings`);
  return value.filter((item): item is string => typeof item === "string");
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  return stringArray(value, name);
}

function optionalNumberArray(value: unknown, name: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) throw new Error(`${name} must be an array of integer IDs`);
  return value.filter((item): item is number => typeof item === "number");
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

interface ClerkJsonWebKey extends JsonWebKey {
  kid?: string;
}

interface JsonWebKeySet {
  keys?: ClerkJsonWebKey[];
}

class InternalAdminAuth {
  private constructor(readonly userId: string, private readonly token: string) {}

  static fromEnv(env: NodeJS.ProcessEnv): InternalAdminAuth | undefined {
    const token = nonEmpty(env["PI_WEB_INTERNAL_AUTH_TOKEN"] ?? env["PI_WEB_ADMIN_TOKEN"]);
    if (token === undefined) return undefined;
    const userId = nonEmpty(env["PI_WEB_INTERNAL_AUTH_USER_ID"] ?? env["PI_WEB_ADMIN_USER_ID"]) ?? "internal-admin";
    return new InternalAdminAuth(userId, token);
  }

  matches(token: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
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
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined || token.split(".").length !== 3) throw new WorkspaceAccessError(401, "Invalid Clerk token");
    const header = parseJwtHeader(headerPart);
    const payload = parseJwtPayload(payloadPart);
    if (header.alg !== "RS256") throw new WorkspaceAccessError(401, "Unsupported Clerk token algorithm");
    if (header.kid === undefined || header.kid === "") throw new WorkspaceAccessError(401, "Clerk token is missing kid");
    validateJwtPayload(payload, this.issuer, this.audience);
    const key = await this.keyFor(header.kid);
    const ok = await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!ok) throw new WorkspaceAccessError(401, "Invalid Clerk token signature");
    if (payload.sub === undefined || payload.sub === "") throw new WorkspaceAccessError(401, "Clerk token is missing subject");
    return payload.sub;
  }

  private async keyFor(kid: string) {
    const jwks = await this.loadJwks();
    const jwk = jwks.keys?.find((candidate) => candidate.kid === kid);
    if (jwk === undefined) throw new WorkspaceAccessError(401, "Clerk signing key not found");
    return await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }

  private async loadJwks(): Promise<JsonWebKeySet> {
    if (this.jwks !== undefined && Date.now() - this.jwksLoadedAt < 10 * 60 * 1000) return this.jwks;
    const response = await fetch(this.jwksUrl);
    if (!response.ok) throw new WorkspaceAccessError(401, `Failed to load Clerk JWKS: HTTP ${String(response.status)}`);
    const jwks = parseJsonWebKeySet(await response.json());
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

function accessTokenQuery(request: FastifyRequest): string | undefined {
  const query = request.query;
  if (!isRecord(query)) return undefined;
  const token = query["access_token"];
  return typeof token === "string" && token !== "" ? token : undefined;
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

function parseJwtHeader(part: string): ClerkJwtHeader {
  const value = parseJwtJson(part);
  if (!isRecord(value)) throw new WorkspaceAccessError(401, "Invalid Clerk token header");
  const alg = typeof value["alg"] === "string" ? value["alg"] : undefined;
  const kid = typeof value["kid"] === "string" ? value["kid"] : undefined;
  return { ...(alg === undefined ? {} : { alg }), ...(kid === undefined ? {} : { kid }) };
}

function parseJwtPayload(part: string): ClerkJwtPayload {
  const value = parseJwtJson(part);
  if (!isRecord(value)) throw new WorkspaceAccessError(401, "Invalid Clerk token payload");
  const sub = typeof value["sub"] === "string" ? value["sub"] : undefined;
  const iss = typeof value["iss"] === "string" ? value["iss"] : undefined;
  const exp = typeof value["exp"] === "number" ? value["exp"] : undefined;
  const nbf = typeof value["nbf"] === "number" ? value["nbf"] : undefined;
  const aud = jwtAudience(value["aud"]);
  return { ...(sub === undefined ? {} : { sub }), ...(iss === undefined ? {} : { iss }), ...(aud === undefined ? {} : { aud }), ...(exp === undefined ? {} : { exp }), ...(nbf === undefined ? {} : { nbf }) };
}

function parseJwtJson(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
  } catch {
    throw new WorkspaceAccessError(401, "Invalid Clerk token encoding");
  }
}

function publishableKeyFromIssuer(issuer: string | undefined): string | undefined {
  const cleanIssuer = nonEmpty(issuer);
  if (cleanIssuer === undefined) return undefined;
  try {
    const frontendApi = new URL(cleanIssuer).host;
    const prefix = /^(([a-z]+)-){2}([0-9]{1,2})\.clerk\.accounts([a-z.]*)(dev|com)$/iu.test(frontendApi) ? "pk_test_" : "pk_live_";
    return `${prefix}${Buffer.from(`${frontendApi}$`, "utf8").toString("base64").replace(/=+$/u, "")}`;
  } catch {
    return undefined;
  }
}

function jwtAudience(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.filter((item): item is string => typeof item === "string");
  throw new WorkspaceAccessError(401, "Invalid Clerk token audience");
}

function parseJsonWebKeySet(value: unknown): JsonWebKeySet {
  if (!isRecord(value) || !Array.isArray(value["keys"])) throw new WorkspaceAccessError(401, "Invalid Clerk JWKS");
  if (!value["keys"].every(isClerkJsonWebKey)) throw new WorkspaceAccessError(401, "Invalid Clerk JWKS");
  return { keys: value["keys"].filter(isClerkJsonWebKey) };
}

function isClerkJsonWebKey(value: unknown): value is ClerkJsonWebKey {
  return isRecord(value);
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${base64}${"=".repeat((4 - base64.length % 4) % 4)}`;
  return Buffer.from(padded, "base64");
}

function getRequestUserId(request: FastifyRequest): string | undefined {
  return request.piWebUserId;
}

function setRequestUserId(request: FastifyRequest, userId: string): void {
  request.piWebUserId = userId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
