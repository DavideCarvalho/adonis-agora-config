---
"@adonis-agora/config": patch
---

Control plane: tenant requests no longer fail with `TypeError: Cannot read properties of undefined (reading 'request')`. The headers handed to `verifyTenant` are read with `ctx.request.headers()` called as a method, so every tenant call (`/v1/config`, `/v1/whoami`, `/v1/keys`, the stream) works against a real Adonis request.
