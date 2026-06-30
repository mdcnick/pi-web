import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSearxngWebSearchDeps, createWebSearchToolDefinition, searxngSearchEndpoint, webSearchDepsFromEnv } from "./webSearchTool.js";

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub; execute() does not use ctx.
const ctx = {} as ExtensionContext;

describe("searxngSearchEndpoint", () => {
  it("normalizes SearXNG roots to the JSON search endpoint", () => {
    expect(searxngSearchEndpoint("http://127.0.0.1:8088").toString()).toBe("http://127.0.0.1:8088/search");
    expect(searxngSearchEndpoint("http://127.0.0.1:8088/").toString()).toBe("http://127.0.0.1:8088/search");
    expect(searxngSearchEndpoint("https://search.example/internal").toString()).toBe("https://search.example/internal/search");
    expect(searxngSearchEndpoint("https://search.example/search?q=old#hash").toString()).toBe("https://search.example/search");
  });

  it("rejects non-HTTP URLs", () => {
    expect(() => searxngSearchEndpoint("file:///tmp/search")).toThrow("HTTP(S)");
  });
});

describe("webSearchDepsFromEnv", () => {
  it("is opt-in through PI_WEB_SEARXNG_URL or SEARXNG_URL", () => {
    expect(webSearchDepsFromEnv({})).toBeUndefined();
    expect(webSearchDepsFromEnv({ PI_WEB_SEARXNG_URL: "http://127.0.0.1:8088" })).toBeDefined();
    expect(webSearchDepsFromEnv({ SEARXNG_URL: "http://127.0.0.1:8088" })).toBeDefined();
  });
});

describe("createSearxngWebSearchDeps", () => {
  it("queries SearXNG JSON and normalizes result records", async () => {
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      expect(input).toBeInstanceOf(URL);
      return Promise.resolve(new Response(JSON.stringify({
        results: [
          { title: "One", url: "https://example.com/one", content: "First result", engine: "duckduckgo" },
          { title: "No URL", content: "ignored" },
          { url: "https://example.com/two", engines: ["brave"], published_date: "2026-06-30" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const deps = createSearxngWebSearchDeps({ baseUrl: "http://searxng.local", fetchImpl });

    const results = await deps.search({ query: "pi web", maxResults: 10 }, undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requested = fetchImpl.mock.calls[0]?.[0];
    if (!(requested instanceof URL)) throw new Error("Expected fetch to receive a URL");
    expect(requested.toString()).toBe("http://searxng.local/search?q=pi+web&format=json&safesearch=1");
    expect(results).toEqual([
      { title: "One", url: "https://example.com/one", snippet: "First result", engine: "duckduckgo" },
      { title: "https://example.com/two", url: "https://example.com/two", snippet: "", engine: "brave", publishedDate: "2026-06-30" },
    ]);
  });

  it("caps returned results", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      results: Array.from({ length: 20 }, (_item, index) => ({ title: `Result ${String(index)}`, url: `https://example.com/${String(index)}`, content: "" })),
    }), { status: 200 })));
    const deps = createSearxngWebSearchDeps({ baseUrl: "http://searxng.local", fetchImpl });

    await expect(deps.search({ query: "x", maxResults: 99 }, undefined)).resolves.toHaveLength(10);
  });

  it("throws on non-ok SearXNG responses", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("nope", { status: 503 })));
    const deps = createSearxngWebSearchDeps({ baseUrl: "http://searxng.local", fetchImpl });

    await expect(deps.search({ query: "x", maxResults: undefined }, undefined)).rejects.toThrow("HTTP 503");
  });
});

describe("createWebSearchToolDefinition", () => {
  it("renders search results for the agent", async () => {
    const search = vi.fn(() => Promise.resolve([
      { title: "Docs", url: "https://example.com/docs", snippet: "Official docs", engine: "duckduckgo" },
    ]));
    const tool = createWebSearchToolDefinition({ search });

    const result = await tool.execute("call-1", { query: "browser tools", maxResults: 3 }, undefined, undefined, ctx);

    expect(search).toHaveBeenCalledWith({ query: "browser tools", maxResults: 3 }, undefined);
    expect(result.details).toEqual({ results: [{ title: "Docs", url: "https://example.com/docs", snippet: "Official docs", engine: "duckduckgo" }] });
    const firstContent = result.content[0];
    if (firstContent?.type !== "text") throw new Error("Expected text content");
    expect(firstContent.text).toContain("web_search results for: browser tools");
    expect(firstContent.text).toContain("https://example.com/docs");
  });
});
