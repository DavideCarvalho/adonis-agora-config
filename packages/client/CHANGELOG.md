# @adonis-agora/config-client

## 1.0.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-config/pull/34) [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: config joins the rest of the Agora libraries on the 1.x line. No API changes from 0.12.

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-config/pull/36) [`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).
  
  With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.
  
  `@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.

### Patch Changes

- Updated dependencies [[`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85), [`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2), [`bb6c0c0`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bb6c0c008d7e72de9025fb25cfb4b88afdee52d8), [`3ea42fa`](https://github.com/DavideCarvalho/adonis-agora-config/commit/3ea42fa9743ad2efdcd8a0e31e5e39767a8ba1a7), [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39)]:
  - @adonis-agora/config-core@1.0.0

## 1.0.0-rc.1

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-config/pull/36) [`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).
  
  With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.
  
  `@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.

### Patch Changes

- Updated dependencies [[`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85)]:
  - @adonis-agora/config-core@1.0.0-rc.2

## 1.0.0-rc.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-config/pull/34) [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: config joins the rest of the Agora libraries on the 1.x line. No API changes from 0.12.

### Patch Changes

- Updated dependencies [[`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39)]:
  - @adonis-agora/config-core@1.0.0-rc.0

## 0.1.2

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

## 0.1.1

### Patch Changes

- [#10](https://github.com/DavideCarvalho/adonis-agora-config/pull/10) [`1e78379`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1e78379767e36d1028093cc3d62fe2dd910e174a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `"agora": { "versioning": "independent" }` in every published package's `package.json`.
  Config is 0.x on purpose and does not follow the 1.x Agora train, so `agora:doctor`'s "Agora
  versions line up" check no longer warns that `@adonis-agora/config` 0.x is installed next to the
  1.x rc libraries. Metadata only — no runtime or API change.
- Updated dependencies [[`1e78379`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1e78379767e36d1028093cc3d62fe2dd910e174a)]:
  - @adonis-agora/config-core@0.1.1

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
