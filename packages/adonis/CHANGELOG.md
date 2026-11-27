# @adonis-agora/config

## 1.1.2

### Patch Changes

- [#47](https://github.com/DavideCarvalho/adonis-agora-config/pull/47) [`43557e2`](https://github.com/DavideCarvalho/adonis-agora-config/commit/43557e2b2ed4df677ee26f6b49eaa03d8369baca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `import '@adonis-agora/config'` failing in 1.1.1 with `Cannot find module …/dist/stubs/main.js` under plain Node (a compiled app; apps running through a TypeScript loader resolved it to the `.ts` source and did not notice). The build now compiles `stubs/main.ts` and no longer deletes it when copying the stubs, and `check:package` imports the built main entry with plain Node.

## 1.1.1

### Patch Changes

- [#45](https://github.com/DavideCarvalho/adonis-agora-config/pull/45) [`cc2e249`](https://github.com/DavideCarvalho/adonis-agora-config/commit/cc2e24902c298e0b8765ce4428387d983d45b0b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `node ace add @adonis-agora/config` (and `node ace configure @adonis-agora/config`) now runs the configure hook: the main entry exports `configure`, which Adonis looks for there. Before, it only warned "the module does not export the configure hook" and published nothing.

## 1.1.0

### Minor Changes

- [#43](https://github.com/DavideCarvalho/adonis-agora-config/pull/43) [`6c74ee7`](https://github.com/DavideCarvalho/adonis-agora-config/commit/6c74ee7ce9fb290938a31d873210af300df1de79) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tenant topology: `defineConfig({ topology: 'tenant' })` is enough when `@adonis-agora/authkit-client` is configured with its `service`. The control plane URL, the service token for `urn:agora:config` and the partition come from its `authkit.client` binding (`tenantOf`, read structurally: no dependency on authkit-client). Anything set in `tenant` wins, field by field; `tenant: { auto: false }` turns the lookup off. An authkit-client without `tenantOf`, or without `service`, counts as absent. Without either, the web process refuses to boot naming the missing fields and both fixes (`node ace` only warns). A new `config.tenant-source` doctor check shows where each field came from (`authkit-client (auto)` or `explicit`).

## 1.0.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-config/pull/34) [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: config joins the rest of the Agora libraries on the 1.x line. No API changes from 0.12.

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-config/pull/36) [`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).
  
  With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.
  
  `@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.

- [#35](https://github.com/DavideCarvalho/adonis-agora-config/pull/35) [`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - createdAt / updatedAt on what the config lib keeps. Each entry now records `createdAt` (when its key was first set, kept by later writes; absent on entries written before) next to `updatedAt` / `updatedBy`. `config_tenant_keys` gains `updated_at` (last activated or retired), added at boot to existing tables as a NULL-able column (no rewrite, no backfill). With `autoCreateSchema: false`, add a migration calling `createConfigTables` (`agora:doctor` reports missing columns as `config.schema-columns`, and `missingConfigColumns()` lists them). Versions and the audit trail are append-only and keep their single timestamp.
  
  The console API adds `createdAt` (ISO 8601 or `null`) to entries, and `document: { version, createdAt, updatedAt }` (the scope's first and latest version) to `GET /entries`. `TenantPublicKey` gains an optional `updatedAt`. Bundles the console that shows them.

- [`3ea42fa`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ea42fa9743ad2efdcd8a0e31e5e39767a8ba1a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security hardening (reported privately by siao-ai):
  
  - The control plane answers `400` to a label or environment that is not a plain name (control or non-latin1 characters, quotes, over 128 characters) instead of crashing on the ETag header; ETag parts are percent-encoded.
  - `PUT /v1/keys` and `POST /v1/sealed` require `config:secrets:read`, not only `config:read`.
  - Federated console commands are authenticated. **Breaking:** an app with `consoleCommands`, and a console with a `federatedApps` entry that may act, now refuse to boot (web process; ace commands are never affected) until a mode resolves, with an error naming the line to add.
    - **Together with `@adonis-agora/crypto`: nothing to configure.** When crypto is booted in the app, commands are sealed automatically with the crypto key `console-config` (`aes256-gcm`, in the owning app's crypto partition, which the federated app's `partition` must equal). The key is created automatically: at boot where crypto is embedded, else by the crypto server on the console's first seal; an app on a crypto tenant that finds it missing logs one info line (with the `crypto:keys:create` command for servers with sealProvisioning off). Refused or unreachable crypto logs one warning. Grants: none on the owning app (a crypto server lets an app open its own `console-*` keys); a console that is a crypto tenant needs `crypto:seal:console-*`. The default key was renamed from `config-console` to `console-config`, so one `console-*` grant covers every Agora lib.
    - **Together with authkit-client's calls between apps: nothing to configure.** The console sends an app-call token for the owning app (inside the crypto seal, or sealed to the app's APP_KEY-derived key without crypto); the app verifies it by audience, and its capabilities cap the command.
    - Explicitly: `crypto: { cipher, key?, owns? }` (any cipher: crypto's client, a KMS, Vault transit), `token` / `verifyTenant` (authkit or your own; sealed to a key the app derives from `APP_KEY` and publishes in its own store), or the same `secret` on `consoleCommands` and `federatedApps.<app>.controlPlane` (HMAC on every command and answer). `crypto: false`, `token: false` and `verifyTenant: false` switch the automatic modes off. A control plane uses its own `verifyTenant` when `consoleCommands.verifyTenant` is not set.
    - The console always sends its viewer's capabilities, narrowed to config's console set (from `authorize`, else every config console capability; `access: 'read'` drops writes); the app refuses a command without them (`capabilities-required`), and requires `config:write` for set, unset and rollback and `config:secrets:read` for reveals (capped by the token's, in token mode). `config:console:read` / `:write` / `:*` are accepted as aliases on tokens and viewer capabilities.
    - `authorize` answers share one shape across the Agora consoles: `{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` allow nothing; `anyAuthorize` keeps the deciding authorizer's whole grant. **Breaking for apps that narrow:** an `authorize` that returns `capabilities` or `access: 'read'` now also restricts the console's own app (set, unset, rollback need `config:write`, reveal `config:secrets:read`), and the UI disables what the viewer cannot do; one that returns none keeps full access.
    - Commands over a minute old are refused, replays are claimed once, and answers are authenticated in every mode. A control plane must list `consoleCommands.partitions`. `agora:doctor` gains `config.console-commands` and the deep `config.console-commands-key`.
  - Redis snapshots are signed with `transports.redis({ secret })`; a tenant only boots from a signed snapshot.
  - Vault resolvers receive the entry's `{ scope }`, and `vault.allow(reference, scope)` refuses references an app should not reach.
  - MCP `config_list_entries`, `config_get_version` and `config_diff_versions` always mask secrets (`config_get_entry` reveals, audited).
  - Fingerprints hash secret values through an HMAC keyed by the app key, not a bare SHA-256, and every stored fingerprint (including those of versions written before) leaves the store through that keyed digest.
  - A conditional `GET /v1/config` for the current version is answered `304` from the version number alone (no decryption, no vault calls); stores may implement `latestVersion`.
  - `config:pull` shell-quotes its output; `--write` refuses values with line breaks and invalid names, and escapes `$`.
  - Tenant presence is capped at 1,000 rows; an SSE stream whose client left during setup is closed.
  - A config tenant keeps its values fresh (SSE stream, polling, broker watch) only in a process that serves: `web`, or `tenant.watch: true` for a long-running worker. `node ace`, the REPL and tests load the values once and exit; `bootstrapConfig` loads once and the provider starts watching. Shutdown aborts the stream and clears the timers.
  - Mixed Hubs: with crypto and authkit both available, the console picks the mode per app at its first command (token mode when the app publishes its command key, which it does only when it has no crypto; else crypto), so a Hub reaching crypto apps and authkit-only apps needs no config lines. In crypto mode a token that cannot be minted no longer blocks the command (sent crypto-only, one warning with the authkit grant to add). The app's key is read from `config/app.ts`, else `config/encryption.ts`'s default key, else `APP_KEY`. The tenant key check asks crypto's `hasKey` when available (no audit noise).

### Patch Changes

- [#38](https://github.com/DavideCarvalho/adonis-agora-config/pull/38) [`7b983b4`](https://github.com/DavideCarvalho/adonis-agora-config/commit/7b983b4ad144ab37472412b52006131466f1a4b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `browser.realtime` now broadcasts. The provider read `@adonisjs/transmit/services/main` before the app booted, when that module's export is still `undefined`, so every change was dropped silently. It now reads the `transmit` binding from the container once the app has booted, and logs a warning when a broadcast fails.

- [#39](https://github.com/DavideCarvalho/adonis-agora-config/pull/39) [`bcfe11b`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bcfe11b59f7c3b1a2c7307a6802712142d218211) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: new `console.actor` option, which says who the audit trail records for a change or a reveal made in the console. Use it when people do not sign in through authkit-client, for example `actor: (ctx) => ({ id: realAccountId(ctx) })` on a Hub. Without it, the console records the authkit identity, else `ctx.auth.user`, else `console`.
- Updated dependencies [[`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85), [`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2), [`bb6c0c0`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bb6c0c008d7e72de9025fb25cfb4b88afdee52d8), [`3ea42fa`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ea42fa9743ad2efdcd8a0e31e5e39767a8ba1a7), [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39)]:
  - @adonis-agora/config-core@1.0.0

## 1.0.0-rc.5

### Minor Changes

- [`3ea42fa`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ea42fa9743ad2efdcd8a0e31e5e39767a8ba1a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security hardening (reported privately by siao-ai):
  
  - The control plane answers `400` to a label or environment that is not a plain name (control or non-latin1 characters, quotes, over 128 characters) instead of crashing on the ETag header; ETag parts are percent-encoded.
  - `PUT /v1/keys` and `POST /v1/sealed` require `config:secrets:read`, not only `config:read`.
  - Federated console commands are authenticated. **Breaking:** an app with `consoleCommands`, and a console with a `federatedApps` entry that may act, now refuse to boot (web process; ace commands are never affected) until a mode resolves, with an error naming the line to add.
    - **Together with `@adonis-agora/crypto`: nothing to configure.** When crypto is booted in the app, commands are sealed automatically with the crypto key `console-config` (`aes256-gcm`, in the owning app's crypto partition, which the federated app's `partition` must equal). The key is created automatically: at boot where crypto is embedded, else by the crypto server on the console's first seal; an app on a crypto tenant that finds it missing logs one info line (with the `crypto:keys:create` command for servers with sealProvisioning off). Refused or unreachable crypto logs one warning. Grants: none on the owning app (a crypto server lets an app open its own `console-*` keys); a console that is a crypto tenant needs `crypto:seal:console-*`. The default key was renamed from `config-console` to `console-config`, so one `console-*` grant covers every Agora lib.
    - **Together with authkit-client's calls between apps: nothing to configure.** The console sends an app-call token for the owning app (inside the crypto seal, or sealed to the app's APP_KEY-derived key without crypto); the app verifies it by audience, and its capabilities cap the command.
    - Explicitly: `crypto: { cipher, key?, owns? }` (any cipher: crypto's client, a KMS, Vault transit), `token` / `verifyTenant` (authkit or your own; sealed to a key the app derives from `APP_KEY` and publishes in its own store), or the same `secret` on `consoleCommands` and `federatedApps.<app>.controlPlane` (HMAC on every command and answer). `crypto: false`, `token: false` and `verifyTenant: false` switch the automatic modes off. A control plane uses its own `verifyTenant` when `consoleCommands.verifyTenant` is not set.
    - The console always sends its viewer's capabilities, narrowed to config's console set (from `authorize`, else every config console capability; `access: 'read'` drops writes); the app refuses a command without them (`capabilities-required`), and requires `config:write` for set, unset and rollback and `config:secrets:read` for reveals (capped by the token's, in token mode). `config:console:read` / `:write` / `:*` are accepted as aliases on tokens and viewer capabilities.
    - `authorize` answers share one shape across the Agora consoles: `{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` allow nothing; `anyAuthorize` keeps the deciding authorizer's whole grant. **Breaking for apps that narrow:** an `authorize` that returns `capabilities` or `access: 'read'` now also restricts the console's own app (set, unset, rollback need `config:write`, reveal `config:secrets:read`), and the UI disables what the viewer cannot do; one that returns none keeps full access.
    - Commands over a minute old are refused, replays are claimed once, and answers are authenticated in every mode. A control plane must list `consoleCommands.partitions`. `agora:doctor` gains `config.console-commands` and the deep `config.console-commands-key`.
  - Redis snapshots are signed with `transports.redis({ secret })`; a tenant only boots from a signed snapshot.
  - Vault resolvers receive the entry's `{ scope }`, and `vault.allow(reference, scope)` refuses references an app should not reach.
  - MCP `config_list_entries`, `config_get_version` and `config_diff_versions` always mask secrets (`config_get_entry` reveals, audited).
  - Fingerprints hash secret values through an HMAC keyed by the app key, not a bare SHA-256, and every stored fingerprint (including those of versions written before) leaves the store through that keyed digest.
  - A conditional `GET /v1/config` for the current version is answered `304` from the version number alone (no decryption, no vault calls); stores may implement `latestVersion`.
  - `config:pull` shell-quotes its output; `--write` refuses values with line breaks and invalid names, and escapes `$`.
  - Tenant presence is capped at 1,000 rows; an SSE stream whose client left during setup is closed.
  - A config tenant keeps its values fresh (SSE stream, polling, broker watch) only in a process that serves: `web`, or `tenant.watch: true` for a long-running worker. `node ace`, the REPL and tests load the values once and exit; `bootstrapConfig` loads once and the provider starts watching. Shutdown aborts the stream and clears the timers.
  - Mixed Hubs: with crypto and authkit both available, the console picks the mode per app at its first command (token mode when the app publishes its command key, which it does only when it has no crypto; else crypto), so a Hub reaching crypto apps and authkit-only apps needs no config lines. In crypto mode a token that cannot be minted no longer blocks the command (sent crypto-only, one warning with the authkit grant to add). The app's key is read from `config/app.ts`, else `config/encryption.ts`'s default key, else `APP_KEY`. The tenant key check asks crypto's `hasKey` when available (no audit noise).

### Patch Changes

- Updated dependencies [[`3ea42fa`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ea42fa9743ad2efdcd8a0e31e5e39767a8ba1a7)]:
  - @adonis-agora/config-core@1.0.0-rc.4

## 1.0.0-rc.4

### Patch Changes

- [#39](https://github.com/DavideCarvalho/adonis-agora-config/pull/39) [`bcfe11b`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bcfe11b59f7c3b1a2c7307a6802712142d218211) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: new `console.actor` option, which says who the audit trail records for a change or a reveal made in the console. Use it when people do not sign in through authkit-client, for example `actor: (ctx) => ({ id: realAccountId(ctx) })` on a Hub. Without it, the console records the authkit identity, else `ctx.auth.user`, else `console`.

## 1.0.0-rc.3

### Patch Changes

- [#38](https://github.com/DavideCarvalho/adonis-agora-config/pull/38) [`7b983b4`](https://github.com/DavideCarvalho/adonis-agora-config/commit/7b983b4ad144ab37472412b52006131466f1a4b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `browser.realtime` now broadcasts. The provider read `@adonisjs/transmit/services/main` before the app booted, when that module's export is still `undefined`, so every change was dropped silently. It now reads the `transmit` binding from the container once the app has booted, and logs a warning when a broadcast fails.

## 1.0.0-rc.2

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-config/pull/36) [`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).
  
  With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.
  
  `@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.

### Patch Changes

- Updated dependencies [[`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85)]:
  - @adonis-agora/config-core@1.0.0-rc.2

## 1.0.0-rc.1

### Minor Changes

- [#35](https://github.com/DavideCarvalho/adonis-agora-config/pull/35) [`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - createdAt / updatedAt on what the config lib keeps. Each entry now records `createdAt` (when its key was first set, kept by later writes; absent on entries written before) next to `updatedAt` / `updatedBy`. `config_tenant_keys` gains `updated_at` (last activated or retired), added at boot to existing tables as a NULL-able column (no rewrite, no backfill). With `autoCreateSchema: false`, add a migration calling `createConfigTables` (`agora:doctor` reports missing columns as `config.schema-columns`, and `missingConfigColumns()` lists them). Versions and the audit trail are append-only and keep their single timestamp.
  
  The console API adds `createdAt` (ISO 8601 or `null`) to entries, and `document: { version, createdAt, updatedAt }` (the scope's first and latest version) to `GET /entries`. `TenantPublicKey` gains an optional `updatedAt`. Bundles the console that shows them.

### Patch Changes

- Updated dependencies [[`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2)]:
  - @adonis-agora/config-core@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-config/pull/34) [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: config joins the rest of the Agora libraries on the 1.x line. No API changes from 0.12.

### Patch Changes

- Updated dependencies [[`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39)]:
  - @adonis-agora/config-core@1.0.0-rc.0

## 0.12.1

### Patch Changes

- [#33](https://github.com/DavideCarvalho/adonis-agora-config/pull/33) [`2ad9bcd`](https://github.com/DavideCarvalho/adonis-agora-config/commit/2ad9bcdfc38221c79ed467fc109a1ca27d9fb50b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: opening a version on the History page no longer crashes ("Cannot read properties of undefined (reading 'createdBy')"). `GET <console>/api/versions/:version` answers `{ version, entries }`, the shape the page reads.

## 0.12.0

### Minor Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-config/pull/32) [`7f5c650`](https://github.com/DavideCarvalho/adonis-agora-config/commit/7f5c65088d477bc9840c3e6fee1e2e9f420210d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Federated console. An app that runs config standalone (its own store and keys) can appear in another app's console: the console lists it in `console.federatedApps`, reads its versions and audit straight from its tables with every secret value and vault reference dropped, and sends set/unset/rollback and reveal to the app over Redis. The owning app opts in with `consoleCommands` (`actions`, `reveal`); it writes its own versions and audit with the other console's viewer as the actor. Values cross Redis sealed (writes to a key derived from the app's `APP_KEY`, reveals to a per-request key), and a federated reveal needs `config:secrets:read` in the console's `authorize` grant (`capabilities`, new). New routes: `GET /api/apps`, `GET /api/scopes`. The App picker shows a federated badge and notice, and a read-only federated app disables the edit buttons.

## 0.11.2

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-config/pull/30) [`f784a6b`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f784a6ba085852fd870d6fed8faac23f25705ec5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: going to another console (switcher, ⌘K, search results, sidebar links) keeps this page's `?app=` and `?tenant=`, so the picked app and organization follow you. The console kit copy is updated from the canonical kit (shared `ScopeMenu` / `ScopeChip` header picker, `app-mode` block, `globalThis.fetch` in console data).

## 0.11.1

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agora-config/pull/29) [`ef4ffe2`](https://github.com/DavideCarvalho/adonis-agora-config/commit/ef4ffe2725151421fb30f710ccaf92c3e7bb0cd2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `stores.lucid()` and `transports.redis()` now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the default Lucid store, so telescope's Architecture page shows "config: configuration → PostgreSQL" without any app code.

## 0.11.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/adonis-agora-config/pull/27) [`f69c50d`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f69c50dab31a891b03b611f68f53d74c0ba0ac4b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Remove platform sync. `sync.rules`, `ConfigSync`, its types and `node ace config:sync` are gone: apps read their configuration at boot with `importRemoteConfig` (local env wins), and the config server never writes to a platform's variables. Drop `sync` from `config/config.ts` if you set it.

## 0.10.0

### Minor Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-config/pull/26) [`20ede4a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/20ede4a348074935bb69dddf814b70fd07e0fc41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `importRemoteConfig` gains `retry` (attempts with backoff, like `spring-retry`) and `failFast` (like `spring.cloud.config.fail-fast`). When every attempt failed and there is no snapshot, `failFast` makes the boot throw `RemoteConfigUnavailableError` (`E_REMOTE_CONFIG_UNAVAILABLE`) instead of booting on the local environment.

## 0.9.0

### Minor Changes

- [#25](https://github.com/DavideCarvalho/adonis-agora-config/pull/25) [`2c55d30`](https://github.com/DavideCarvalho/adonis-agora-config/commit/2c55d30a9536f18ccc8c175f7848fdf752688cb0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `node ace config:import [--file] [--secrets] [--skip] [--dry-run]` imports env variables into entries in one version. The input can be a `.env`, a JSON object or stdin. `RESEND_API_KEY` becomes `resend.api.key`, values are kept as text, and names matching the secret pattern are stored as secrets. The command never prints a value. New `ConfigAdmin.setEntries()` writes several entries in one version.

## 0.8.0

### Minor Changes

- [#24](https://github.com/DavideCarvalho/adonis-agora-config/pull/24) [`871434f`](https://github.com/DavideCarvalho/adonis-agora-config/commit/871434f2a6c7e676f72eba7fc327282a3e3edd57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Sync to the platform. A control plane's `sync.rules` push each app's configuration to wherever its processes read their environment (PaaS variables, a Kubernetes Secret…), so apps boot on the last values even when the config server is down. A `ConfigSyncTarget` receives `{ set, remove, mode }`, with env names (`RESEND_API_KEY`) and secrets flagged. Every new version is pushed as a debounced delta. `node ace config:sync [--app]` does a full push. `keep` lists names that are never touched.

## 0.7.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-config/pull/23) [`13c6cd1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/13c6cd194bc48922735fbbba27a16636b2d32dda) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The CLI's app flag is now `--app`, like the rest of the Agora libs (`node ace config:entry:set checkout.timeoutMs 5000 --app=shop`). `--application` and `-a` keep working.

## 0.6.0

### Minor Changes

- [#22](https://github.com/DavideCarvalho/adonis-agora-config/pull/22) [`1330550`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1330550e8c25296f647f5743ce9438b7b4ce25bd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `importRemoteConfig(appRoot, (env) => options)` in `@adonis-agora/config/bootstrap`: called at the top of `start/env.ts`, it brings the app's configuration into `process.env` before `Env.create` validates it, like Spring's `spring.config.import`. Precedence: process env, then `.env` files, then the server. With authkit-client installed, an issuer plus a service client is enough: the token, the server URL (from discovery) and the app name (from the token) are found for you. Without credentials it does nothing. With the server down, it boots on the snapshot or on the local environment.

## 0.5.4

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-config/pull/21) [`bdf345d`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bdf345d04ceca6aed28a56752b662563a4fc4424) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: creatable comboboxes keep the typed text when you leave the field, and server-side suggestions no longer wipe what you are typing.

## 0.5.3

### Patch Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-config/pull/20) [`6047728`](https://github.com/DavideCarvalho/adonis-agora-config/commit/6047728df7a6aee72de39c6827887c3958ed5dbf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console scope pickers with autocomplete (the kit's new `ComboSelect`): app, env and label in the topbar filter as you type, and a name `/meta` doesn't list yet (a scope with no entries) can be typed and picked.

## 0.5.2

### Patch Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-config/pull/18) [`81a3674`](https://github.com/DavideCarvalho/adonis-agora-config/commit/81a36749ad9d339bb48c680a15c4a0e085c94f21) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Service-token capabilities now accept wildcards, with the same rule as every other Agora control plane: a `*` segment matches one segment and a trailing `*` matches zero or more further segments, so `config:*` and `*` cover `config:read` and `config:secrets:read`. The check lives in the new `capabilityAllows(granted, required)` helper (exported from `@adonis-agora/config-core` and `@adonis-agora/config`), and every control-plane check goes through it.
  
  Heads-up: a token that already held `config:*` or `*` (previously ignored, so it was refused or got masked secrets) now gets every config capability, including unmasked secret values.
- Updated dependencies [[`81a3674`](https://github.com/DavideCarvalho/adonis-agora-config/commit/81a36749ad9d339bb48c680a15c4a0e085c94f21)]:
  - @adonis-agora/config-core@0.1.2

## 0.5.1

### Patch Changes

- [#19](https://github.com/DavideCarvalho/adonis-agora-config/pull/19) [`9f1a596`](https://github.com/DavideCarvalho/adonis-agora-config/commit/9f1a59689a40e754d8639faa4d5de9e95c96480d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.5.0

### Minor Changes

- [#16](https://github.com/DavideCarvalho/adonis-agora-config/pull/16) [`464df30`](https://github.com/DavideCarvalho/adonis-agora-config/commit/464df30687f20d67b3599547b60e292bb21d903d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's Audit and History pages page by cursor, so a deep page costs what the first one does and no page counts the scope's whole trail.
  
  - `GET /audit` and `GET /versions` accept `first`/`after` and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The audit seeks past `(at, version, id)` and the versions past `version`, with no `COUNT(*)`. `page`/`size` keep the offset envelope and its total. `ConfigAdmin.auditCursor` / `versionsCursor` are the same reads in code.
  - Stores gain optional `seekAudit` / `seekVersions`; both built-in stores implement them. The audit order now breaks ties on `at` and `version` by `id`, so rows written by one multi-key change keep one order across pages.
  - The console walks both lists with Previous/Next and keeps the walked cursors in the URL (`#/audit?after=…`). It no longer shows a row total.
  - New migration `add_config_audit_indexes` (published by `configure`), plus `createConfigAuditIndexes` / `dropConfigAuditIndexes`. `config_audit` had no index but its primary key. The migration indexes it by scope + `at`, scope + key, and scope + action, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Deployment).
  - Fix: `node ace configure @adonis-agora/config` failed to render its stubs. `config/config.stub` had no `exports({ to })` header, and backticks in the comments of both stubs broke the stub template. A spec now renders every stub through the real engine.

## 0.4.3

### Patch Changes

- [#17](https://github.com/DavideCarvalho/adonis-agora-config/pull/17) [`a611f0a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/a611f0ae6c4cb090044c9ffd2ad8f3a0ea6398be) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ships the console with its filters in the URL (copy the link to share a filtered view). The console is bundled into this package at build time, so it needs its own release to reach apps.

## 0.4.2

### Patch Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-config/pull/14) [`90a5c49`](https://github.com/DavideCarvalho/adonis-agora-config/commit/90a5c49f50dceabcf6e181c783e0f41c12fecf65) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `transports.redis({ connection })` takes the connection from the app container instead of `@adonisjs/redis/services/main`. That service is only set once the app has booted, while a control plane builds its transport during provider boot, so an ace command such as `migration:run` crashed with `Cannot read properties of undefined (reading 'connection')`.

## 0.4.1

### Patch Changes

- [#13](https://github.com/DavideCarvalho/adonis-agora-config/pull/13) [`30094cf`](https://github.com/DavideCarvalho/adonis-agora-config/commit/30094cf008169862468047ac3c35f445132ccc44) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Control plane: tenant requests no longer fail with `TypeError: Cannot read properties of undefined (reading 'request')`. The headers handed to `verifyTenant` are read with `ctx.request.headers()` called as a method, so every tenant call (`/v1/config`, `/v1/whoami`, `/v1/keys`, the stream) works against a real Adonis request.

## 0.4.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-config/pull/12) [`4c2f1e0`](https://github.com/DavideCarvalho/adonis-agora-config/commit/4c2f1e0d8b5ab9685b3c895427f21e49758937b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Control-plane attribution, per-viewer grants and a lazy tenant URL:
  
  - Every `agora:config:*` diagnostic passes its payload's `app` as the envelope `app`
    (`@adonis-agora/diagnostics` 1.0.0-rc.6+), so Telescope tags it `app:<name>`. Older diagnostics
    ignore the extra argument.
  - New `tenant.fetch` event: the control plane emits it (attributed to the tenant) when it serves a
    tenant its document. A `304` poll is not an event; the tenant emits nothing for the read.
  - `console.authorize` may answer `{ allowed: true, apps: '*' | string[] }`: the viewer only sees and
    changes those apps in the console API, the pickers, ⌘K and the MCP dev tools. `console.apps`
    stays the upper bound, and the dev tools and ⌘K now honour it too.
  - `tenant.url` (and `createTenantClient`/`bootstrapConfig`'s `url`) also takes
    `() => Promise<string>`, optionally with `refresh()` (`controlPlaneUrl()` from
    `@adonis-agora/authkit-client`). It resolves before the first request and is refreshed, with one
    retry, on a connection error or a 404. `TenantClient.url` is `undefined` until a lazy URL
    resolves; `resolveUrl()` resolves it.

## 0.3.2

### Patch Changes

- [#11](https://github.com/DavideCarvalho/adonis-agora-config/pull/11) [`4d30b52`](https://github.com/DavideCarvalho/adonis-agora-config/commit/4d30b5260c95f2f94529555d020bcb87b5a9e9c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two console fixes:
  
  - The console no longer registers `GET <path>` **and** `GET <path>/`. AdonisJS drops the trailing
    slash when it computes a route pattern, so both were the same route and the HTTP server died at
    boot with `Duplicate route found`. One route is registered and it still answers the
    trailing-slash URL (including a custom `console.path`).
  - A stored `fetch` is now bound to the global object before it is called. `fetch` is a method of
    `window` in the browser, so calling it as a property of another object (the console's `ConfigApi`,
    the `ConfigClient` and the tenant client's conditional GET) threw `TypeError: Illegal invocation`
    and the console rendered an error while the API worked.

## 0.3.1

### Patch Changes

- [#10](https://github.com/DavideCarvalho/adonis-agora-config/pull/10) [`1e78379`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1e78379767e36d1028093cc3d62fe2dd910e174a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `"agora": { "versioning": "independent" }` in every published package's `package.json`.
  Config is 0.x on purpose and does not follow the 1.x Agora train, so `agora:doctor`'s "Agora
  versions line up" check no longer warns that `@adonis-agora/config` 0.x is installed next to the
  1.x rc libraries. Metadata only — no runtime or API change.
- Updated dependencies [[`1e78379`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1e78379767e36d1028093cc3d62fe2dd910e174a)]:
  - @adonis-agora/config-core@0.1.1

## 0.3.0

### Minor Changes

- [#9](https://github.com/DavideCarvalho/adonis-agora-config/pull/9) [`bd6f9e2`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bd6f9e298c308f722d1a2a3a80c1b82e643cec83) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable tenant↔control-plane transports for the **watch** channel: `transports.http` (default,
  SSE + poll), `transports.redis` (pub/sub `changed v=N` + masked snapshot key) and
  `transports.durable` (via durable's control plane). The control plane always keeps its HTTP API
  mounted, so browsers, the console and http tenants are unaffected and a fleet can mix both. Watch
  messages carry no values; the document is fetched over HTTPS with the tenant token.

## 0.2.0

### Minor Changes

- [#8](https://github.com/DavideCarvalho/adonis-agora-config/pull/8) [`3ce14df`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ce14df81b1101eb3196d31e70e87dbb072fdda3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The tenant HTTP client now ships inside `@adonis-agora/config` (root and the lean
  `@adonis-agora/config/client` subpath), so a script, worker or Sail command installs one package.
  `@adonis-agora/config-client` is deprecated; it keeps its published 0.1.0 for existing installs.

## 0.1.1

### Patch Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-config/pull/6) [`4636409`](https://github.com/DavideCarvalho/adonis-agora-config/commit/46364096e5fc1d5c30a2b0dc6a0c07452d83e04d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Integration coverage now boots real AdonisJS apps end to end: a standalone app (provider boot,
  APP_NAME default, secret write) and a control-plane app plus a tenant app over real HTTP (boot
  values, secret, SSE hot reload, boot-time key kept). This also fixes the default config environment:
  Adonis' runtime environment (`web`) is no longer used as the config environment, so a control plane
  and its tenants read the same scope.

## 0.1.0

### Minor Changes

- [#4](https://github.com/DavideCarvalho/adonis-agora-config/pull/4) [`a38672e`](https://github.com/DavideCarvalho/adonis-agora-config/commit/a38672e243c5ea2a2361641afb55f5cd3d00611f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The first release of the Agora config server, Spring Cloud Config style: a control plane that owns
  every app's configuration per app, environment and label, with immutable versions, history, audit,
  an ETag + SSE tenant API, and secrets sealed by the Agora crypto kit (purpose `config:secrets`, AAD
  app/environment/key), optionally sealed to a tenant's X25519 public key so the control plane cannot
  read them, or resolved from a vault; and a tenant that fetches before the app's config
  loads, boots from a disk snapshot during an outage, and hot-reloads the keys marked reloadable while
  reporting the ones that need a restart.
  
  Tenant auth follows the Agora topology spec: `verifyTenant` top level with the three forms, the
  `urn:agora:config` resource, a `partition` claim and `config:read` / `config:secrets:read`
  capabilities. With authkit it is `authkitTenantVerifier` + `authkitTenantToken` from
  `@adonis-agora/authkit-client` (optional, lazy); without it, `sharedSecretVerifier` + the secret in
  `tenant.token`. Secrets use the Agora crypto kit on top of AdonisJS encryption (the app's
  `config/encryption.ts` by default; optional `crypto.keys`/`active` owned by this package,
  `config:crypto:reseal [--all]`, and the `config.crypto` doctor check); `crypto.kms` enables envelope
  encryption. A tenant app holds an X25519 key pair (private key sealed at rest,
  public key registered on first connect); `--sealed`/the console's seal checkbox write `sealTo`
  ciphertext the control plane can never open, and `config:tenant:key --rotate` re-seals on rotation. `tenant.localEnv` keeps a Sail worktree's ports ahead of the server in development.
  
  The console lists and edits entries per app/environment/label, diffs any two versions, rolls back and
  shows who changed what (secrets masked until an audited reveal). The CLI (`config:entry:*`,
  `config:history`, `config:rollback`, `config:env`) and the MCP dev tools use the same admin service,
  and `agora:doctor` checks the server, the token and the snapshot.
  
  `@adonis-agora/config-client` reads a scope from any runtime with a shared secret or
  `authkitTenantToken` from `@adonis-agora/authkit-client`; the same helper is the tenant's token
  source, and `config:pull` writes the managed `.env.local` block that Sail consumes without shadowing
  its per-worktree ports.
  
  It also ships a `@adonis-agora/telescope` extension (auto-registered): a Configuration dashboard with store health, write activity, recent changes, secret reveals and the tenants seen, plus one `agora:config:*` diagnostics entry per write/reveal/reload (never a value).

### Patch Changes

- Updated dependencies [[`a38672e`](https://github.com/DavideCarvalho/adonis-agora-config/commit/a38672e243c5ea2a2361641afb55f5cd3d00611f)]:
  - @adonis-agora/config-core@0.1.0
  - @adonis-agora/config-client@0.1.0
