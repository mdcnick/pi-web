---
"@jmfederico/pi-web": patch
---

Add a workspace auth provider abstraction with the existing internal admin auth as the default provider and an opt-in Better Auth session verifier behind `PI_WEB_AUTH_PROVIDER=better-auth`. Better Auth mode can bootstrap the first PI WEB admin from the currently authenticated Better Auth user when no admins exist yet.
