import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSharedProviderModelRegistry, resolveSharedProviderAuthPaths } from "./sharedProviderAuth.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-shared-auth-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolveSharedProviderAuthPaths", () => {
  it("is disabled when shared provider auth env and defaults are disabled", () => {
    expect(resolveSharedProviderAuthPaths({ PI_WEB_DISABLE_SHARED_PROVIDER_AUTH_DEFAULTS: "1" }, tempDir)).toBeUndefined();
  });

  it("resolves provider auth dir into auth and models paths", () => {
    expect(resolveSharedProviderAuthPaths({ PI_WEB_PROVIDER_AUTH_DIR: "provider-auth" }, tempDir)).toEqual({
      authPath: join(tempDir, "provider-auth", "auth.json"),
      modelsPath: join(tempDir, "provider-auth", "models.json"),
    });
  });

  it("lets explicit auth and model paths override the provider auth dir", () => {
    expect(resolveSharedProviderAuthPaths({ PI_WEB_PROVIDER_AUTH_DIR: "ignored", PI_WEB_MODEL_AUTH_PATH: "auth/shared.json", PI_WEB_MODEL_REGISTRY_PATH: "models/shared.json" }, tempDir)).toEqual({
      authPath: join(tempDir, "auth", "shared.json"),
      modelsPath: join(tempDir, "models", "shared.json"),
    });
  });
});

describe("createSharedProviderModelRegistry", () => {
  it("stores shared credentials with group-readable permissions", async () => {
    const authDir = join(tempDir, "provider-auth");
    const registry = createSharedProviderModelRegistry({ PI_WEB_PROVIDER_AUTH_DIR: authDir }, tempDir);

    expect(registry).not.toBeUndefined();
    registry?.authStorage.set("anthropic", { type: "api_key", key: "sk-test" });

    const fileStat = await stat(join(authDir, "auth.json"));
    expect(fileStat.mode & 0o777).toBe(0o660);
    expect(registry?.authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
  });
});
