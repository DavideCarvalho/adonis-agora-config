---
'@adonis-agora/config': minor
---

Pluggable tenant↔control-plane transports for the **watch** channel: `transports.http` (default,
SSE + poll), `transports.redis` (pub/sub `changed v=N` + masked snapshot key) and
`transports.durable` (via durable's control plane). The control plane always keeps its HTTP API
mounted, so browsers, the console and http tenants are unaffected and a fleet can mix both. Watch
messages carry no values; the document is fetched over HTTPS with the tenant token.
