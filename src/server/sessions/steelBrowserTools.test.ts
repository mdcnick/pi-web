import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSteelBrowserDeps, createSteelBrowserToolDefinitions, normalizeSteelBaseUrl, steelBrowserDepsFromEnv } from "./steelBrowserTools.js";

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub; execute() does not use ctx.
const ctx = {} as ExtensionContext;

describe("normalizeSteelBaseUrl", () => {
  it("normalizes HTTP(S) Steel API base URLs", () => {
    expect(normalizeSteelBaseUrl("http://127.0.0.1:3000/").toString()).toBe("http://127.0.0.1:3000/");
    expect(normalizeSteelBaseUrl("https://api.steel.dev/v1?old=1#x").toString()).toBe("https://api.steel.dev/v1");
  });

  it("rejects non-HTTP URLs", () => {
    expect(() => normalizeSteelBaseUrl("file:///tmp/steel")).toThrow("HTTP(S)");
  });
});

describe("steelBrowserDepsFromEnv", () => {
  it("is opt-in through Steel env vars", () => {
    expect(steelBrowserDepsFromEnv({})).toBeUndefined();
    expect(steelBrowserDepsFromEnv({ PI_WEB_STEEL_BASE_URL: "http://127.0.0.1:3000" })).toBeDefined();
    expect(steelBrowserDepsFromEnv({ STEEL_API_KEY: "test-key" })).toBeDefined();
  });
});

describe("createSteelBrowserDeps", () => {
  it("calls Steel scrape and normalizes extract results", async () => {
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      const url = input instanceof URL ? input.toString() : "";
      expect(url).toBe("http://steel.local/v1/scrape");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "steel-api-key": "key-1" });
      expect(init?.body).toBe(JSON.stringify({ url: "https://example.com/page", format: ["markdown"], delay: 100 }));
      return Promise.resolve(new Response(JSON.stringify({
        metadata: { statusCode: 200, title: "Example", description: "Demo" },
        content: { markdown: "# Example" },
        links: [{ text: "Docs", url: "https://example.com/docs" }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const deps = createSteelBrowserDeps({ baseUrl: "http://steel.local", apiKey: "key-1", fetchImpl, allowPrivateNetworks: true });

    const result = await deps.extract({ url: "https://example.com/page", delayMs: 100 }, undefined);

    expect(result).toEqual({
      url: "https://example.com/page",
      statusCode: 200,
      title: "Example",
      description: "Demo",
      markdown: "# Example",
      links: [{ text: "Docs", url: "https://example.com/docs" }],
    });
  });

  it("calls Steel screenshot and returns the screenshot URL", async () => {
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      const url = input instanceof URL ? input.toString() : "";
      expect(url).toBe("http://steel.local/v1/screenshot");
      expect(init?.body).toBe(JSON.stringify({ url: "https://example.com/", fullPage: true }));
      return Promise.resolve(new Response(JSON.stringify({ url: "http://steel.local/files/shot.png" }), { status: 200 }));
    });
    const deps = createSteelBrowserDeps({ baseUrl: "http://steel.local", fetchImpl, allowPrivateNetworks: true });

    await expect(deps.screenshot({ url: "https://example.com", fullPage: true, delayMs: undefined }, undefined))
      .resolves.toEqual({ url: "https://example.com/", screenshotUrl: "http://steel.local/files/shot.png" });
  });

  it("blocks local browser targets by default", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    const deps = createSteelBrowserDeps({ baseUrl: "http://steel.local", fetchImpl });

    await expect(deps.extract({ url: "http://localhost:8504", delayMs: undefined }, undefined)).rejects.toThrow("private or local");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createSteelBrowserToolDefinitions", () => {
  it("renders browser_extract output for the agent", async () => {
    const extract = vi.fn(() => Promise.resolve({ url: "https://example.com/", title: "Example", markdown: "content", links: [] }));
    const screenshot = vi.fn(() => Promise.resolve({ url: "https://example.com/", screenshotUrl: "https://files.example/shot.png" }));
    const [extractTool] = createSteelBrowserToolDefinitions({ extract, screenshot });
    if (extractTool === undefined) throw new Error("Expected extract tool");

    const result = await extractTool.execute("call-1", { url: "https://example.com", delayMs: undefined }, undefined, undefined, ctx);

    expect(extract).toHaveBeenCalledWith({ url: "https://example.com", delayMs: undefined }, undefined);
    const firstContent = result.content[0];
    if (firstContent?.type !== "text") throw new Error("Expected text content");
    expect(firstContent.text).toContain("browser_extract Example");
    expect(firstContent.text).toContain("content");
  });
});
