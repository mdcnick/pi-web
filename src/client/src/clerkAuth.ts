import type { Clerk } from "@clerk/clerk-js";

interface WorkspaceAuthPublicResponse {
  enabled: boolean;
  publishableKey?: string;
}

let clerk: Clerk | undefined;
let cachedToken: string | undefined;
let tokenPromise: Promise<string | undefined> | undefined;

export async function initializeWorkspaceAuth(): Promise<boolean> {
  const settings = await loadWorkspaceAuthSettings();
  if (!settings.enabled) return true;
  if (settings.publishableKey === undefined || settings.publishableKey === "") {
    renderBlockingAuthMessage("Workspace auth is enabled, but CLERK_PUBLISHABLE_KEY is not configured for PI WEB.");
    return false;
  }

  const [{ Clerk: ClerkBrowser }, { ui }] = await Promise.all([import("@clerk/clerk-js"), import("@clerk/ui")]);
  clerk = new ClerkBrowser(settings.publishableKey);
  renderBlockingAuthMessage("Loading sign in…");
  try {
    await clerk.load({ ui });
  } catch (error) {
    renderBlockingAuthMessage(`Clerk failed to load: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  if (clerk.isSignedIn) {
    await refreshAuthToken();
    clerk.addListener(() => { void refreshAuthToken(); });
    renderAuthenticatedAppShell();
    return true;
  }

  clerk.addListener(() => {
    if (clerk?.isSignedIn !== true) return;
    void refreshAuthToken().finally(() => {
      window.location.reload();
    });
  });
  renderSignIn(clerk);
  return false;
}

export async function workspaceAuthHeaders(): Promise<HeadersInit> {
  if (!hasBrowserDocument()) return {};
  const token = await currentAuthToken();
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

export function workspaceAuthQuery(): string {
  if (!hasBrowserDocument()) return "";
  return cachedToken === undefined ? "" : new URLSearchParams({ access_token: cachedToken }).toString();
}

async function loadWorkspaceAuthSettings(): Promise<WorkspaceAuthPublicResponse> {
  const response = await fetch("/api/workspace-access/public", { cache: "no-store" });
  if (!response.ok) return { enabled: false };
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value["enabled"] !== "boolean") return { enabled: false };
  const publishableKey = typeof value["publishableKey"] === "string" ? value["publishableKey"] : undefined;
  return { enabled: value["enabled"], ...(publishableKey === undefined ? {} : { publishableKey }) };
}

async function currentAuthToken(): Promise<string | undefined> {
  if (cachedToken !== undefined) return cachedToken;
  if (tokenPromise !== undefined) return await tokenPromise;
  tokenPromise = refreshAuthToken();
  try {
    return await tokenPromise;
  } finally {
    tokenPromise = undefined;
  }
}

async function refreshAuthToken(): Promise<string | undefined> {
  const token = await clerk?.session?.getToken();
  cachedToken = token ?? undefined;
  syncSessionCookie(cachedToken);
  return cachedToken;
}

function syncSessionCookie(token: string | undefined): void {
  if (!hasBrowserDocument()) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  if (token === undefined) {
    document.cookie = `__session=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }
  document.cookie = `__session=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
}

function renderSignIn(activeClerk: Clerk): void {
  const root = authRoot();
  root.innerHTML = `<div class="pi-auth-card" id="pi-clerk-sign-in"></div>`;
  const mount = root.querySelector("#pi-clerk-sign-in");
  if (!(mount instanceof HTMLDivElement)) return;
  activeClerk.mountSignIn(mount, {
    fallbackRedirectUrl: window.location.href,
    routing: "hash",
  });
}

function renderAuthenticatedAppShell(): void {
  document.getElementById("pi-workspace-auth-root")?.remove();
  if (document.querySelector("pi-web-app") !== null) return;
  document.body.append(document.createElement("pi-web-app"));
}

function renderBlockingAuthMessage(message: string): void {
  authRoot().innerHTML = `<div class="pi-auth-card"><strong>PI WEB sign in</strong><p>${escapeHtml(message)}</p></div>`;
}

function authRoot(): HTMLElement {
  document.querySelector("pi-web-app")?.remove();
  let root = document.getElementById("pi-workspace-auth-root");
  if (root instanceof HTMLElement) return root;
  root = document.createElement("main");
  root.id = "pi-workspace-auth-root";
  root.innerHTML = "";
  document.body.append(root);
  ensureAuthStyles();
  return root;
}

function ensureAuthStyles(): void {
  if (document.getElementById("pi-workspace-auth-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "pi-workspace-auth-styles";
  style.textContent = `
    #pi-workspace-auth-root { min-height:100dvh; display:grid; place-items:center; padding:24px; box-sizing:border-box; background:var(--pi-bg); color:var(--pi-text); }
    .pi-auth-card { width:min(100%, 440px); border:1px solid var(--pi-border); border-radius:16px; background:var(--pi-surface); box-shadow:0 16px 60px var(--pi-shadow); padding:20px; }
    .pi-auth-card p { color:var(--pi-text-secondary); line-height:1.45; }
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function hasBrowserDocument(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
