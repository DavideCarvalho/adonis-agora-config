---
'@adonis-agora/config': minor
---

Sync to the platform. A control plane's `sync.rules` push each app's configuration to wherever its processes read their environment (PaaS variables, a Kubernetes Secret…), so apps boot on the last values even when the config server is down. A `ConfigSyncTarget` receives `{ set, remove, mode }`, with env names (`RESEND_API_KEY`) and secrets flagged. Every new version is pushed as a debounced delta. `node ace config:sync [--app]` does a full push. `keep` lists names that are never touched.
