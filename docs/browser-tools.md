# Browser and search tools

PI WEB can expose a `web_search` tool to Pi sessions when the session daemon is configured with a SearXNG endpoint.

This is the first, search-only slice of the PiControl browser-tool stack. Use it to find candidate URLs before spending heavier browser automation work on a Steel Browser session.

## Enable `web_search`

Run a private SearXNG instance and set the session daemon environment variable:

```bash
PI_WEB_SEARXNG_URL=http://127.0.0.1:8088
```

Restart the PI WEB session daemon after changing this value. The tool is registered when a session runtime starts, so existing active sessions may need to be restarted or recreated before the model sees `web_search`.

`SEARXNG_URL` is accepted as a fallback alias, but `PI_WEB_SEARXNG_URL` is preferred for PI WEB deployments.

## Minimal Docker example

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "127.0.0.1:8088:8080"
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8088/
```

Keep SearXNG bound to localhost, a VPN, or another private network. Do not expose an unauthenticated search backend publicly.

## Tool behavior

`web_search` sends queries to SearXNG's JSON API:

```text
GET /search?q=<query>&format=json&safesearch=1
```

Parameters:

- `query` — required search query.
- `maxResults` — optional, defaults to 5 and is capped at 10.

The tool returns normalized titles, URLs, snippets, engines, and publish dates when SearXNG provides them.

## Steel Browser direction

The heavier browser tools should be added as a separate gateway slice after `web_search` is working:

- `browser_open`
- `browser_snapshot`
- `browser_extract`
- `browser_click`
- `browser_type`
- `browser_close`

Keep browser automation server-side and session-scoped. Agents should call PI WEB tools, not Docker or Steel Browser directly.
