import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface WebSearchInvocation {
  query: string;
  maxResults: number | undefined;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  publishedDate?: string;
}

export interface WebSearchToolDeps {
  search(input: WebSearchInvocation, signal: AbortSignal | undefined): Promise<WebSearchResult[]>;
}

export interface SearxngWebSearchOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const WebSearchParams = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query to send to the configured SearXNG instance.",
  }),
  maxResults: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: "Maximum number of results to return. Defaults to 5 and is capped at 10.",
  })),
});

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const SNIPPET_LIMIT = 700;
const TITLE_LIMIT = 180;
const SEARCH_TIMEOUT_MS = 20_000;

export function createWebSearchToolDefinition(deps: WebSearchToolDeps) {
  return defineTool<typeof WebSearchParams, { results: WebSearchResult[] }>({
    name: "web_search",
    label: "Web search",
    description: "Search the web through PiControl's self-hosted SearXNG instance. Use this before opening pages in a browser when the user asks for current web information, source discovery, or documentation lookup.",
    promptSnippet: "web_search: search the web through PiControl's self-hosted SearXNG instance",
    promptGuidelines: [
      "Prefer web_search over Composio/MCP web-search tools for general web search because PiControl has a self-hosted SearXNG backend on the server.",
      "Use web_search for current web results, source discovery, and finding candidate URLs before using browser tools.",
      "Do not use web_search for local repository search; use grep/find/read for local files instead.",
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal) {
      const results = await deps.search({ query: params.query, maxResults: params.maxResults }, signal);
      const text = renderWebSearchResults(params.query, results);
      return { content: [{ type: "text", text }], details: { results } };
    },
  });
}

export function createSearxngWebSearchDeps(options: SearxngWebSearchOptions): WebSearchToolDeps {
  const searchEndpoint = searxngSearchEndpoint(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async search(input, signal) {
      const maxResults = normalizeMaxResults(input.maxResults);
      const url = new URL(searchEndpoint.toString());
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", "1");

      const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "PiControl web_search" },
        signal: combinedSignal,
      });
      if (!response.ok) throw new Error(`SearXNG search failed with HTTP ${String(response.status)}`);

      const json: unknown = await response.json();
      if (!isRecord(json)) return [];
      const results = json["results"];
      if (!Array.isArray(results)) return [];
      return results
        .map(parseSearxngResult)
        .filter((result): result is WebSearchResult => result !== undefined)
        .slice(0, maxResults);
    },
  };
}

export function webSearchDepsFromEnv(env: NodeJS.ProcessEnv = process.env): WebSearchToolDeps | undefined {
  const baseUrl = env["PI_WEB_SEARXNG_URL"] ?? env["SEARXNG_URL"];
  if (baseUrl === undefined || baseUrl.trim() === "") return undefined;
  return createSearxngWebSearchDeps({ baseUrl });
}

export function searxngSearchEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("PI_WEB_SEARXNG_URL must be an HTTP(S) URL");
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    url.pathname = "/search";
  } else if (!path.endsWith("/search")) {
    url.pathname = `${path}/search`;
  } else {
    url.pathname = path;
  }
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeMaxResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS);
}

function parseSearxngResult(value: unknown): WebSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringValue(value["url"]);
  if (url === undefined) return undefined;
  const title = stringValue(value["title"]) ?? url;
  const snippet = stringValue(value["content"]) ?? "";
  const engine = stringValue(value["engine"]) ?? firstString(value["engines"]);
  const publishedDate = stringValue(value["publishedDate"]) ?? stringValue(value["published_date"]);
  return {
    title: clip(title, TITLE_LIMIT),
    url,
    snippet: clip(snippet, SNIPPET_LIMIT),
    ...(engine === undefined ? {} : { engine }),
    ...(publishedDate === undefined ? {} : { publishedDate }),
  };
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value.find((item) => typeof item === "string");
  return typeof first === "string" ? first : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function renderWebSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web_search results for: ${query}`;
  const rendered = results.map((result, index) => {
    const source = result.engine === undefined ? "" : ` (${result.engine})`;
    const snippet = result.snippet === "" ? "" : `\n   ${result.snippet}`;
    return `${String(index + 1)}. ${result.title}${source}\n   ${result.url}${snippet}`;
  }).join("\n\n");
  return `web_search results for: ${query}\n\n${rendered}`;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
