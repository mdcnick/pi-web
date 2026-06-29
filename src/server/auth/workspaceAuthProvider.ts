import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export type WorkspaceAuthProviderKind = "internal" | "better-auth";

export interface WorkspaceAuthPublicSettings {
  enabled: boolean;
  provider: WorkspaceAuthProviderKind;
  internalAuth?: boolean;
}

export interface WorkspaceAuthProvider {
  readonly kind: WorkspaceAuthProviderKind;
  isConfigured(): boolean;
  allowMissingPolicy(): boolean;
  publicSettings(enabled: boolean): WorkspaceAuthPublicSettings;
  authenticateRequest(request: FastifyRequest): Promise<void> | void;
}

export function createWorkspaceAuthProvider(env: NodeJS.ProcessEnv = process.env): WorkspaceAuthProvider {
  const provider = nonEmpty(env["PI_WEB_AUTH_PROVIDER"])?.toLowerCase();
  if (provider === "better-auth" || provider === "betterauth") return BetterAuthWorkspaceProvider.fromEnv(env);
  if (provider !== undefined && provider !== "internal") throw new Error(`Unsupported PI WEB auth provider: ${provider}`);
  return InternalWorkspaceAuthProvider.fromEnv(env);
}

class InternalWorkspaceAuthProvider implements WorkspaceAuthProvider {
  readonly kind = "internal" as const;

  private constructor(private readonly auth: InternalAdminAuth | undefined) {}

  static fromEnv(env: NodeJS.ProcessEnv): InternalWorkspaceAuthProvider {
    const token = nonEmpty(env["PI_WEB_INTERNAL_AUTH_TOKEN"] ?? env["PI_WEB_ADMIN_TOKEN"]);
    if (token === undefined) return new InternalWorkspaceAuthProvider(undefined);
    const userId = nonEmpty(env["PI_WEB_INTERNAL_AUTH_USER_ID"] ?? env["PI_WEB_ADMIN_USER_ID"]) ?? "internal-admin";
    return new InternalWorkspaceAuthProvider(new InternalAdminAuth(userId, token));
  }

  isConfigured(): boolean {
    return this.auth !== undefined;
  }

  allowMissingPolicy(): boolean {
    return this.auth !== undefined;
  }

  publicSettings(enabled: boolean): WorkspaceAuthPublicSettings {
    return { enabled, provider: this.kind, ...(this.auth === undefined ? {} : { internalAuth: true }) };
  }

  authenticateRequest(request: FastifyRequest): void {
    const token = requestAuthToken(request);
    if (token !== undefined && this.auth?.matches(token) === true) {
      request.piWebUserId = this.auth.userId;
      request.piWebInternalAdmin = true;
    }
  }
}

class BetterAuthWorkspaceProvider implements WorkspaceAuthProvider {
  readonly kind = "better-auth" as const;

  private constructor(
    private readonly apiUrl: string | undefined,
    private readonly sessionPath: string,
    private readonly apiKey: string | undefined,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): BetterAuthWorkspaceProvider {
    return new BetterAuthWorkspaceProvider(
      nonEmpty(env["BETTER_AUTH_API_URL"]),
      nonEmpty(env["BETTER_AUTH_SESSION_PATH"]) ?? "/api/auth/get-session",
      nonEmpty(env["BETTER_AUTH_API_KEY"]),
    );
  }

  isConfigured(): boolean {
    return this.apiUrl !== undefined;
  }

  allowMissingPolicy(): boolean {
    return false;
  }

  publicSettings(enabled: boolean): WorkspaceAuthPublicSettings {
    return { enabled, provider: this.kind };
  }

  async authenticateRequest(request: FastifyRequest): Promise<void> {
    if (this.apiUrl === undefined) return;
    const token = requestAuthToken(request);
    const cookie = headerValue(request.headers.cookie);
    if (token === undefined && cookie === undefined) return;

    const session = await this.fetchSession({ ...(token === undefined ? {} : { token }), ...(cookie === undefined ? {} : { cookie }) });
    const userId = sessionUserId(session);
    if (userId !== undefined) request.piWebUserId = userId;
  }

  private async fetchSession(auth: { token?: string; cookie?: string }): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (auth.token !== undefined) headers["authorization"] = `Bearer ${auth.token}`;
    if (auth.cookie !== undefined) headers["cookie"] = auth.cookie;
    if (this.apiKey !== undefined) headers["x-api-key"] = this.apiKey;

    const response = await fetch(new URL(this.sessionPath, withTrailingSlash(this.apiUrl!)), { headers });
    if (!response.ok) return undefined;
    return await response.json().catch((): unknown => undefined);
  }
}

class InternalAdminAuth {
  constructor(readonly userId: string, private readonly token: string) {}

  matches(token: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

function requestAuthToken(request: FastifyRequest): string | undefined {
  return bearerToken(request) ?? accessTokenQuery(request) ?? sessionCookie(request);
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

function sessionCookie(request: FastifyRequest): string | undefined {
  const cookie = headerValue(request.headers.cookie);
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__session" && value.length > 0) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sessionUserId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const user = value["user"];
  if (isRecord(user) && typeof user["id"] === "string" && user["id"] !== "") return user["id"];
  const session = value["session"];
  if (isRecord(session)) {
    const sessionUser = session["user"];
    if (isRecord(sessionUser) && typeof sessionUser["id"] === "string" && sessionUser["id"] !== "") return sessionUser["id"];
    if (typeof session["userId"] === "string" && session["userId"] !== "") return session["userId"];
  }
  return undefined;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
