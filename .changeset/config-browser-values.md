---
"@adonis-agora/config": minor
"@adonis-agora/config-core": minor
"@adonis-agora/config-client": minor
"@adonis-agora/config-dashboard": minor
---

Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).

With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.

`@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.
