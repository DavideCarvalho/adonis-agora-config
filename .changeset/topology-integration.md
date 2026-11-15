---
'@adonis-agora/config': patch
---

Integration coverage now boots real AdonisJS apps end to end: a standalone app (provider boot,
APP_NAME default, secret write) and a control-plane app plus a tenant app over real HTTP (boot
values, secret, SSE hot reload, boot-time key kept). This also fixes the default config environment:
Adonis' runtime environment (`web`) is no longer used as the config environment, so a control plane
and its tenants read the same scope.
