# @adonis-agora/config-core

## 1.0.0-rc.3

### Patch Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-config/pull/40) [`bb6c0c0`](https://github.com/DavideCarvalho/adonis-agora-config/commit/bb6c0c008d7e72de9025fb25cfb4b88afdee52d8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: `unflattenObject` and `assertConfigKey` reject `__proto__`, `constructor` and `prototype` key segments. Before, a key like `__proto__.x` written to the store polluted `Object.prototype` in every app that read the config.

## 1.0.0-rc.2

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-config/pull/36) [`f19d3d1`](https://github.com/DavideCarvalho/adonis-agora-config/commit/f19d3d1c41b2c533627495a7c235d38988b0bf85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Values in the browser. An entry can be marked `browser` (console checkbox, off by default; `config:entry:set --browser`; the MCP tools), and a tenant can also list keys under `browser.keys` (exact or `prefix.*`). `config.browser()` returns the marked and listed values, never a secret, vault reference or sealed entry: the store refuses to mark one, and refuses to make a marked entry secret. The mark is part of the entry (`ConfigEntryState.browser`, present only when true, so existing fingerprints do not change).
  
  With `browser.realtime`, a hot-reloaded change to what the browser reads (including marking or unmarking) broadcasts `{ version }` over `@adonisjs/transmit` (channel `config/browser`); `browser.route` adds a GET route answering `{ version, values }`.
  
  `@adonis-agora/config-client/react` adds `ConfigProvider`, `useConfig`, `useConfigValues`, `useConfigRealtime` and `RemoteConfigProvider` (reads the route); `@adonis-agora/config-client/react/inertia` adds `InertiaConfigProvider`, which follows the shared `config` prop and reloads it on a change. React and Inertia are optional peers.

## 1.0.0-rc.1

### Minor Changes

- [#35](https://github.com/DavideCarvalho/adonis-agora-config/pull/35) [`33afcd8`](https://github.com/DavideCarvalho/adonis-agora-config/commit/33afcd872175de0d03aa379943f191d66aad5fa2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - createdAt / updatedAt on what the config lib keeps. Each entry now records `createdAt` (when its key was first set, kept by later writes; absent on entries written before) next to `updatedAt` / `updatedBy`. `config_tenant_keys` gains `updated_at` (last activated or retired), added at boot to existing tables as a NULL-able column (no rewrite, no backfill). With `autoCreateSchema: false`, add a migration calling `createConfigTables` (`agora:doctor` reports missing columns as `config.schema-columns`, and `missingConfigColumns()` lists them). Versions and the audit trail are append-only and keep their single timestamp.
  
  The console API adds `createdAt` (ISO 8601 or `null`) to entries, and `document: { version, createdAt, updatedAt }` (the scope's first and latest version) to `GET /entries`. `TenantPublicKey` gains an optional `updatedAt`. Bundles the console that shows them.

## 1.0.0-rc.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-config/pull/34) [`905ef8a`](https://github.com/DavideCarvalho/adonis-agora-config/commit/905ef8ae92f90831992caa928fe11320831bfa39) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: config joins the rest of the Agora libraries on the 1.x line. No API changes from 0.12.

## 0.1.2

### Patch Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-config/pull/18) [`81a3674`](https://github.com/DavideCarvalho/adonis-agora-config/commit/81a36749ad9d339bb48c680a15c4a0e085c94f21) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Service-token capabilities now accept wildcards, with the same rule as every other Agora control plane: a `*` segment matches one segment and a trailing `*` matches zero or more further segments, so `config:*` and `*` cover `config:read` and `config:secrets:read`. The check lives in the new `capabilityAllows(granted, required)` helper (exported from `@adonis-agora/config-core` and `@adonis-agora/config`), and every control-plane check goes through it.
  
  Heads-up: a token that already held `config:*` or `*` (previously ignored, so it was refused or got masked secrets) now gets every config capability, including unmasked secret values.

## 0.1.1

### Patch Changes

- [#10](https://github.com/DavideCarvalho/adonis-agora-config/pull/10) [`1e78379`](https://github.com/DavideCarvalho/adonis-agora-config/commit/1e78379767e36d1028093cc3d62fe2dd910e174a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `"agora": { "versioning": "independent" }` in every published package's `package.json`.
  Config is 0.x on purpose and does not follow the 1.x Agora train, so `agora:doctor`'s "Agora
  versions line up" check no longer warns that `@adonis-agora/config` 0.x is installed next to the
  1.x rc libraries. Metadata only — no runtime or API change.

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
