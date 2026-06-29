import type { Clerk } from "@clerk/clerk-js";

interface WorkspaceAuthPublicResponse {
  enabled: boolean;
  publishableKey?: string;
  internalAuth?: boolean;
}

const internalAuthStorageKey = "pi-web.internalAuthToken";

let clerk: Clerk | undefined;
let cachedToken: string | undefined;
let tokenPromise: Promise<string | undefined> | undefined;

export async function initializeWorkspaceAuth(): Promise<boolean> {
  const settings = await loadWorkspaceAuthSettings();
  if (!settings.enabled) return true;
  if (settings.publishableKey !== undefined && settings.publishableKey !== "") return await initializeClerkAuth(settings.publishableKey);
  if (settings.internalAuth === true) return await initializeInternalAuth();
  renderBlockingAuthMessage("Workspace auth is enabled, but neither CLERK_PUBLISHABLE_KEY nor PI_WEB_INTERNAL_AUTH_TOKEN is configured for PI WEB.");
  return false;
}

async function initializeClerkAuth(publishableKey: string): Promise<boolean> {
  const [{ Clerk: ClerkBrowser }, { ui }] = await Promise.all([import("@clerk/clerk-js"), import("@clerk/ui")]);
  clerk = new ClerkBrowser(publishableKey);
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

async function initializeInternalAuth(): Promise<boolean> {
  const storedToken = readInternalAuthToken();
  if (storedToken !== undefined) {
    setInternalAuthToken(storedToken);
    const error = await verifyInternalAuthToken(storedToken);
    if (error === undefined) {
      renderAuthenticatedAppShell();
      return true;
    }
    clearInternalAuthToken();
    renderInternalSignIn("Saved admin access key was rejected. Sign in again.");
    return false;
  }
  renderInternalSignIn();
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
  const internalAuth = value["internalAuth"] === true;
  return { enabled: value["enabled"], ...(publishableKey === undefined ? {} : { publishableKey }), ...(internalAuth ? { internalAuth } : {}) };
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
  if (clerk === undefined) {
    syncSessionCookie(cachedToken);
    return cachedToken;
  }
  const token = await clerk.session?.getToken();
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

function renderInternalSignIn(error?: string): void {
  const root = authRoot();
  root.innerHTML = `
    <form class="pi-auth-card" id="pi-internal-auth-form">
      <strong>PI WEB admin sign in</strong>
      <p>Enter the internal admin access key configured on this PI WEB server.</p>
      ${error === undefined ? "" : `<p class="pi-auth-error">${escapeHtml(error)}</p>`}
      <label class="pi-auth-field">
        <span>Admin access key</span>
        <input name="token" type="password" autocomplete="current-password" autofocus />
      </label>
      <button type="submit">Sign in</button>
    </form>
  `;
  const form = root.querySelector("#pi-internal-auth-form");
  const input = root.querySelector("input[name='token']");
  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (token === "") {
      renderInternalSignIn("Admin access key is required.");
      return;
    }
    void submitInternalAuthToken(token);
  });
}

async function submitInternalAuthToken(token: string): Promise<void> {
  setInternalAuthToken(token);
  renderBlockingAuthMessage("Checking admin access…");
  const error = await verifyInternalAuthToken(token);
  if (error === undefined) {
    writeInternalAuthToken(token);
    renderAuthenticatedAppShell();
    return;
  }
  clearInternalAuthToken();
  renderInternalSignIn(error);
}

async function verifyInternalAuthToken(token: string): Promise<string | undefined> {
  try {
    const response = await fetch("/api/workspace-access", {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return undefined;
    const body: unknown = await response.json().catch((): unknown => ({}));
    return errorMessage(body) ?? response.statusText;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function setInternalAuthToken(token: string): void {
  cachedToken = token;
  syncSessionCookie(cachedToken);
}

function readInternalAuthToken(): string | undefined {
  try {
    const token = window.sessionStorage.getItem(internalAuthStorageKey);
    return token === null || token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

function writeInternalAuthToken(token: string): void {
  try {
    window.sessionStorage.setItem(internalAuthStorageKey, token);
  } catch {
    // Browser storage may be blocked. The in-memory token and cookie still cover this tab.
  }
}

function clearInternalAuthToken(): void {
  cachedToken = undefined;
  syncSessionCookie(undefined);
  try {
    window.sessionStorage.removeItem(internalAuthStorageKey);
  } catch {
    // Ignore blocked storage.
  }
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
    .pi-auth-field { display:grid; gap:6px; margin:16px 0; color:var(--pi-text-secondary); }
    .pi-auth-field input { width:100%; box-sizing:border-box; border:1px solid var(--pi-border); border-radius:10px; background:var(--pi-input-bg, var(--pi-bg)); color:var(--pi-text); padding:10px 12px; font:inherit; }
    .pi-auth-card button { border:0; border-radius:10px; background:var(--pi-accent); color:var(--pi-accent-contrast, white); padding:10px 14px; font:inherit; font-weight:600; cursor:pointer; }
    .pi-auth-error { color:var(--pi-danger, #ff6b6b) !important; }
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function hasBrowserDocument(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
