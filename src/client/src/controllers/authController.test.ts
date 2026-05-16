import { describe, expect, it } from "vitest";
import { api as defaultApi, type AuthProviderOption, type OAuthFlowState } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthController, parseAuthSlashCommand } from "./authController";

describe("parseAuthSlashCommand", () => {
  it("parses login and logout commands", () => {
    expect(parseAuthSlashCommand("/login")).toEqual({ command: "login" });
    expect(parseAuthSlashCommand("/logout")).toEqual({ command: "logout" });
  });

  it("parses provider arguments", () => {
    expect(parseAuthSlashCommand("/login openai")).toEqual({ command: "login", providerId: "openai" });
    expect(parseAuthSlashCommand("/logout openai-codex ")).toEqual({ command: "logout", providerId: "openai-codex" });
  });

  it("ignores non-auth commands and extra arguments", () => {
    expect(parseAuthSlashCommand("/model")).toBeUndefined();
    expect(parseAuthSlashCommand("hello /login")).toBeUndefined();
    expect(parseAuthSlashCommand("/login openai extra")).toBeUndefined();
  });
});

describe("AuthController", () => {
  it("uses auth type to disambiguate provider options with the same id", async () => {
    const providers = [authProvider("anthropic", "oauth"), authProvider("anthropic", "api_key")];
    const { controller, getState } = createController({ authDialog: { step: "providers", mode: "login", providers } });

    await controller.selectLoginProvider("anthropic", "api_key");

    expect(getState().authDialog).toMatchObject({ step: "apiKey", provider: { id: "anthropic", authType: "api_key" } });
  });

  it("keeps OAuth prompt input and submit state across poll refreshes for the same request", async () => {
    const flow = oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" } });
    const { controller, getState } = createController(
      { authDialog: { step: "oauth", flow, inputValue: "https://callback", responding: true } },
      { respondOAuthFlow: () => Promise.resolve(oauthFlow({ prompt: { requestId: "request-1", message: "Paste callback", kind: "manual" }, progress: ["Still waiting"] })) },
    );

    await controller.respondOAuth();

    expect(getState().authDialog).toMatchObject({ step: "oauth", inputValue: "https://callback", responding: true });
  });
});

function createController(statePatch: Partial<AppState>, apiPatch: Partial<typeof defaultApi> = {}) {
  let state: AppState = { ...initialAppState(), ...statePatch };
  const api = { ...defaultApi, ...apiPatch };
  const controller = new AuthController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    { api },
  );
  return { controller, getState: () => state };
}

function authProvider(id: string, authType: "oauth" | "api_key"): AuthProviderOption {
  return { id, authType, name: `${id} ${authType}`, status: { configured: false } };
}

function oauthFlow(patch: Partial<OAuthFlowState> = {}): OAuthFlowState {
  return {
    flowId: "flow-1",
    providerId: "anthropic",
    providerName: "Anthropic",
    status: "running",
    progress: [],
    ...patch,
  };
}
