import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface SteelBrowserToolDeps {
  extract(input: BrowserExtractInvocation, signal: AbortSignal | undefined): Promise<BrowserExtractResult>;
  screenshot(input: BrowserScreenshotInvocation, signal: AbortSignal | undefined): Promise<BrowserScreenshotResult>;
}

export interface BrowserExtractInvocation {
  url: string;
  delayMs: number | undefined;
}

export interface BrowserScreenshotInvocation {
  url: string;
  delayMs: number | undefined;
  fullPage: boolean | undefined;
}

export interface BrowserExtractResult {
  url: string;
  statusCode?: number;
  title?: string;
  description?: string;
  markdown?: string;
  links: BrowserExtractLink[];
}

export interface BrowserExtractLink {
  text: string;
  url: string;
}

export interface BrowserScreenshotResult {
  url: string;
  screenshotUrl: string;
}

export interface SteelBrowserClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  allowPrivateNetworks?: boolean;
}

const BrowserExtractParams = Type.Object({
  url: Type.String({ description: "HTTP(S) page URL to extract with Steel Browser Tools." }),
  delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Optional wait before extraction in milliseconds. Defaults to Steel's server-side default." })),
});

const BrowserScreenshotParams = Type.Object({
  url: Type.String({ description: "HTTP(S) page URL to screenshot with Steel Browser Tools." }),
  delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Optional wait before screenshot in milliseconds. Defaults to Steel's server-side default." })),
  fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page instead of just the viewport." })),
});

const STEEL_CLOUD_BASE_URL = "https://api.steel.dev";
const BROWSER_TIMEOUT_MS = 45_000;
const MARKDOWN_LIMIT = 18_000;
const LINKS_LIMIT = 25;

export function createSteelBrowserToolDefinitions(deps: SteelBrowserToolDeps) {
  const extractTool = defineTool<typeof BrowserExtractParams, BrowserExtractResult>({
    name: "browser_extract",
    label: "Browser extract",
    description: "Extract readable page text, metadata, and links through the configured Steel Browser Tools backend. Use after web_search when a result page needs JS-capable browser extraction.",
    promptSnippet: "browser_extract: extract readable text, metadata, and links from a web page",
    promptGuidelines: [
      "Use browser_extract after web_search when a candidate URL needs page content, metadata, or links.",
      "Do not use browser_extract for private/internal URLs unless the user has explicitly configured PI WEB to allow private browser targets.",
    ],
    parameters: BrowserExtractParams,
    async execute(_toolCallId, params, signal) {
      const result = await deps.extract({ url: params.url, delayMs: params.delayMs }, signal);
      return { content: [{ type: "text", text: renderBrowserExtract(result) }], details: result };
    },
  });

  const screenshotTool = defineTool<typeof BrowserScreenshotParams, BrowserScreenshotResult>({
    name: "browser_screenshot",
    label: "Browser screenshot",
    description: "Capture a screenshot through the configured Steel Browser Tools backend. Returns a hosted screenshot URL from Steel or the local Steel API.",
    promptSnippet: "browser_screenshot: capture a screenshot of a web page",
    promptGuidelines: [
      "Use browser_screenshot when the user needs visual verification of a web page.",
      "Do not use browser_screenshot for private/internal URLs unless the user has explicitly configured PI WEB to allow private browser targets.",
    ],
    parameters: BrowserScreenshotParams,
    async execute(_toolCallId, params, signal) {
      const result = await deps.screenshot({ url: params.url, delayMs: params.delayMs, fullPage: params.fullPage }, signal);
      return { content: [{ type: "text", text: `Screenshot captured for ${result.url}: ${result.screenshotUrl}` }], details: result };
    },
  });

  return [extractTool, screenshotTool];
}

export function steelBrowserDepsFromEnv(env: NodeJS.ProcessEnv = process.env): SteelBrowserToolDeps | undefined {
  const apiKey = env["PI_WEB_STEEL_API_KEY"] ?? env["STEEL_API_KEY"];
  const baseUrl = env["PI_WEB_STEEL_BASE_URL"] ?? env["STEEL_BASE_URL"] ?? (apiKey === undefined || apiKey === "" ? undefined : STEEL_CLOUD_BASE_URL);
  if (baseUrl === undefined || baseUrl.trim() === "") return undefined;
  return createSteelBrowserDeps({
    baseUrl,
    ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
    allowPrivateNetworks: env["PI_WEB_BROWSER_ALLOW_PRIVATE_NETWORKS"] === "1" || env["PI_WEB_BROWSER_ALLOW_PRIVATE_NETWORKS"]?.toLowerCase() === "true",
  });
}

export function createSteelBrowserDeps(options: SteelBrowserClientOptions): SteelBrowserToolDeps {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeSteelBaseUrl(options.baseUrl);
  const allowPrivateNetworks = options.allowPrivateNetworks === true;
  return {
    async extract(input, signal) {
      const safeUrl = await safeBrowserTargetUrl(input.url, allowPrivateNetworks);
      const response = await postSteelJson(fetchImpl, baseUrl, "/v1/scrape", steelHeaders(options.apiKey), scrapeBody(safeUrl, input.delayMs), signal);
      return parseBrowserExtractResponse(safeUrl, response);
    },
    async screenshot(input, signal) {
      const safeUrl = await safeBrowserTargetUrl(input.url, allowPrivateNetworks);
      const response = await postSteelJson(fetchImpl, baseUrl, "/v1/screenshot", steelHeaders(options.apiKey), screenshotBody(safeUrl, input.delayMs, input.fullPage), signal);
      const screenshotUrl = stringValue(response["url"]);
      if (screenshotUrl === undefined) throw new Error("Steel screenshot response did not include a URL");
      return { url: safeUrl, screenshotUrl };
    },
  };
}

export function normalizeSteelBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("PI_WEB_STEEL_BASE_URL must be an HTTP(S) URL");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function postSteelJson(fetchImpl: typeof fetch, baseUrl: URL, path: string, headers: HeadersInit, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  const basePath = baseUrl.pathname === "/" ? "" : baseUrl.pathname;
  const url = new URL(`${basePath}${path}`, baseUrl);
  const timeoutSignal = AbortSignal.timeout(BROWSER_TIMEOUT_MS);
  const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`Steel Browser request failed with HTTP ${String(response.status)}`);
  const json: unknown = await response.json();
  if (!isRecord(json)) throw new Error("Steel Browser response must be a JSON object");
  return json;
}

function steelHeaders(apiKey: string | undefined): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(apiKey === undefined ? {} : { "steel-api-key": apiKey }),
  };
}

function scrapeBody(url: string, delayMs: number | undefined): Record<string, unknown> {
  return {
    url,
    format: ["markdown"],
    ...(delayMs === undefined ? {} : { delay: delayMs }),
  };
}

function screenshotBody(url: string, delayMs: number | undefined, fullPage: boolean | undefined): Record<string, unknown> {
  return {
    url,
    ...(delayMs === undefined ? {} : { delay: delayMs }),
    ...(fullPage === undefined ? {} : { fullPage }),
  };
}

function parseBrowserExtractResponse(url: string, value: Record<string, unknown>): BrowserExtractResult {
  const metadata = recordValue(value["metadata"]);
  const content = recordValue(value["content"]);
  const markdown = stringValue(content["markdown"]);
  const statusCode = metadata["statusCode"];
  const title = stringValue(metadata["title"]);
  const description = stringValue(metadata["description"]);
  return {
    url,
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(markdown === undefined ? {} : { markdown: clip(markdown, MARKDOWN_LIMIT) }),
    links: linksValue(value["links"]),
  };
}

function renderBrowserExtract(result: BrowserExtractResult): string {
  const title = result.title ?? result.url;
  const status = result.statusCode === undefined ? "" : ` [HTTP ${String(result.statusCode)}]`;
  const description = result.description === undefined ? "" : `\nDescription: ${result.description}`;
  const links = result.links.length === 0 ? "" : `\n\nLinks:\n${result.links.map((link) => `- ${link.text}: ${link.url}`).join("\n")}`;
  const markdown = result.markdown === undefined ? "" : `\n\nContent:\n${result.markdown}`;
  return `browser_extract ${title}${status}\nURL: ${result.url}${description}${markdown}${links}`;
}

async function safeBrowserTargetUrl(value: string, allowPrivateNetworks: boolean): Promise<string> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser target URL must use HTTP(S)");
  if (url.username !== "" || url.password !== "") throw new Error("Browser target URL must not include credentials");
  if (!allowPrivateNetworks) await rejectPrivateHost(url.hostname);
  return url.toString();
}

async function rejectPrivateHost(hostname: string): Promise<void> {
  if (isBlockedHostname(hostname)) throw new Error("Browser target URL points at a private or local host");
  const ipKind = isIP(hostname);
  if (ipKind !== 0) {
    if (isPrivateIp(hostname)) throw new Error("Browser target URL points at a private or local IP");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.some((address) => isPrivateIp(address.address))) throw new Error("Browser target URL resolves to a private or local IP");
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function isPrivateIp(address: string): boolean {
  if (address === "::1") return true;
  if (address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}

function linksValue(value: unknown): BrowserExtractLink[] {
  if (!Array.isArray(value)) return [];
  return value.map(linkValue).filter((link): link is BrowserExtractLink => link !== undefined).slice(0, LINKS_LIMIT);
}

function linkValue(value: unknown): BrowserExtractLink | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringValue(value["url"]);
  if (url === undefined) return undefined;
  return { text: stringValue(value["text"]) ?? url, url };
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
