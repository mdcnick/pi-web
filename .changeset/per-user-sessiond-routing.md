---
"@jmfederico/pi-web": patch
---

Add optional per-user session daemon routing so workspace-scoped session requests can be sent to the Unix user's own PI WEB session daemon, keeping MCP and provider credentials isolated between users.
