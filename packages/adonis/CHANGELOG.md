# @adonis-agora/config

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
