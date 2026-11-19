---
'@adonis-agora/config': minor
---

Remove platform sync. `sync.rules`, `ConfigSync`, its types and `node ace config:sync` are gone: apps read their configuration at boot with `importRemoteConfig` (local env wins), and the config server never writes to a platform's variables. Drop `sync` from `config/config.ts` if you set it.
