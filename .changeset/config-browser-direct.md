---
"@adonis-agora/config": minor
"@adonis-agora/config-client": minor
---

Direct mode for browser values. A control plane with `browser: { corsOrigins }` gives each tenant a signing key (`POST /v1/browser-key`) and serves `GET /v1/browser/values` and `GET /v1/browser/stream` to browser tokens; a tenant with `browser.direct` mints them at `/_config/browser-token` (scope-bound, 10 minutes by default, carrying its `browser.keys`). Reads are shared per scope (a short document cache and one watcher per scope), and a stream only tells a page when its own values changed. `@adonis-agora/config-client/react` adds `DirectConfigProvider`.
