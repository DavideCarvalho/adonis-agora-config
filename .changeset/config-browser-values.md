---
"@adonis-agora/config": minor
"@adonis-agora/config-client": minor
---

Values in the browser. A tenant lists the keys its pages may read under `browser.keys` (exact keys or `prefix.*`); `config.browser()` returns them, never a secret, vault reference or sealed entry, even when a pattern matches one. With `browser.realtime`, a hot-reloaded change to a listed key broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.

`@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.
