# Browser and search tools

PI WEB can expose browser/search tools to Pi sessions when the session daemon is configured with private SearXNG and/or Steel Browser endpoints.

The intended agent flow is:

1. `web_search` finds candidate URLs through SearXNG.
2. `browser_extract` pulls readable content from a chosen page through Steel Browser Tools.
3. `browser_screenshot` captures visual evidence when needed.

## Local Docker stack

A ready-to-copy local compose example lives at [`browser-tools.compose.yml`](./browser-tools.compose.yml):

```bash
docker compose -f docs/browser-tools.compose.yml up -d
```

It starts:

- SearXNG on `127.0.0.1:8088`
- Steel Browser on `127.0.0.1:3000` with Chrome debugging on `127.0.0.1:9223`

Keep these ports bound to localhost, a VPN, or another private network. Do not expose unauthenticated browser/search backends publicly.

## Enable tools in PI WEB

Set session-daemon environment variables:

```bash
PI_WEB_SEARXNG_URL=http://127.0.0.1:8088
PI_WEB_STEEL_BASE_URL=http://127.0.0.1:3000
```

Restart the PI WEB session daemon after changing these values. Tools are registered when a session runtime starts, so existing active sessions may need to be restarted or recreated before the model sees them.

Fallback aliases:

- `SEARXNG_URL` for `PI_WEB_SEARXNG_URL`
- `STEEL_BASE_URL` for `PI_WEB_STEEL_BASE_URL`
- `STEEL_API_KEY` for `PI_WEB_STEEL_API_KEY`

For Steel Cloud instead of local Steel Browser, set only an API key:

```bash
PI_WEB_STEEL_API_KEY=...
```

When an API key is present and no base URL is configured, PI WEB uses `https://api.steel.dev`.

## Tools

### `web_search`

Calls SearXNG's JSON API:

```text
GET /search?q=<query>&format=json&safesearch=1
```

Parameters:

- `query` — required search query.
- `maxResults` — optional, defaults to 5 and is capped at 10.

Returns normalized titles, URLs, snippets, engines, and publish dates when SearXNG provides them.

### `browser_extract`

Calls Steel Browser Tools `/v1/scrape` and requests markdown content.

Parameters:

- `url` — HTTP(S) page URL.
- `delayMs` — optional wait before extraction, max 30 seconds.

Returns:

- page URL
- status code when available
- title/description when available
- markdown content, clipped for agent context safety
- up to 25 links

### `browser_screenshot`

Calls Steel Browser Tools `/v1/screenshot`.

Parameters:

- `url` — HTTP(S) page URL.
- `delayMs` — optional wait before capture, max 30 seconds.
- `fullPage` — optional full-page screenshot flag.

Returns the screenshot URL provided by Steel.

## Safety

Browser tools reject local/private targets by default, including `localhost`, RFC1918 private IPs, link-local metadata IPs, and hostnames that resolve to private IPs. This prevents a model from using a browser backend as an SSRF probe against the PI WEB host or LAN.

For trusted local-development workflows only, override this with:

```bash
PI_WEB_BROWSER_ALLOW_PRIVATE_NETWORKS=true
```

Use that setting only on private machines where you understand the risk.

## Future persistent browser sessions

The next heavier slice should add persistent, session-scoped browser controls:

- `browser_open`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_close`

Those should manage Steel session lifecycle explicitly and remain server-side. Agents should call PI WEB tools, not Docker or Steel Browser directly.
