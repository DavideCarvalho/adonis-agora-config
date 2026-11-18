---
'@adonis-agora/config': minor
---

`importRemoteConfig(appRoot, (env) => options)` in `@adonis-agora/config/bootstrap`: called at the top of `start/env.ts`, it brings the app's configuration into `process.env` before `Env.create` validates it, like Spring's `spring.config.import`. Precedence: process env, then `.env` files, then the server. With authkit-client installed, an issuer plus a service client is enough: the token, the server URL (from discovery) and the app name (from the token) are found for you. Without credentials it does nothing. With the server down, it boots on the snapshot or on the local environment.
