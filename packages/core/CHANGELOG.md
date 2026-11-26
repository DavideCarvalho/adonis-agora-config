# @adonis-agora/config-core

## 0.1.4

### Patch Changes

- [`0cedccf`](https://github.com/DavideCarvalho/adonis-agora-config/commit/0cedccf0913bc0cea7bfc3f94267afec207e5465) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security fixes backported to the 0.x line.
  
  **Breaking:** federated console commands are now authenticated with a shared secret.
  
  - The owning app must set `consoleCommands.secret` (at least 16 characters), and the console must set the same value as `federatedApps.<app>.controlPlane.secret` on every entry that may act (`actions` not `false`). Without it the web process refuses to boot and the error names the option to add. Every command and answer is signed (HMAC-SHA256), commands older than one minute are refused, and each command runs at most once.
  - The console always sends its viewer's capabilities (every config capability when `authorize` does not narrow them). The app refuses a command without them; set, unset and rollback need `config:write`, a reveal needs `config:secrets:read`.
  - `transports.redis({ secret })`: the control plane signs the Redis snapshot, and a tenant only boots from a snapshot whose signature checks out. Without a secret a tenant no longer boots from the Redis snapshot.
  
  Other fixes:
  
  - The control plane answers `400` to a label or environment that is not a plain name (letters, digits and `_ . : / @ + -`, at most 128 characters), and `etagOf` percent-encodes every part. `isValidScopeName` / `assertScopeName` are exported from `@adonis-agora/config-core`.
  - `PUT /v1/keys` and `POST /v1/sealed` require `config:secrets:read` in addition to `config:read`.
  - Vault resolvers receive `{ scope }` (the entry's app, environment and label), and the new `vault.allow(reference, scope)` refuses references an app should not reach; a refused reference is served masked. Add an `allow` rule when apps must not read each other's secrets.
  - The MCP tools `config_list_entries`, `config_get_version` and `config_diff_versions` always mask secrets; reveal one through `config_get_entry`, which is audited.
  - Version fingerprints hash secret values through an HMAC keyed by the app key (`fingerprintOf` accepts a `secretDigest`), and stored fingerprints are passed through it before they leave the store.
  - `config:pull` shell-quotes printed values and skips invalid names; `--write` refuses values with line breaks or invalid names and escapes `$`.
  - Tenant presence in the control plane is capped at 1,000 rows, and an SSE stream whose client left during setup is closed at once.

## 0.1.3

### Patch Changes

- [#41](https://github.com/DavideCarvalho/adonis-agora-config/pull/41) [`72e9e23`](https://github.com/DavideCarvalho/adonis-agora-config/commit/72e9e239bd02a1d844ba0a41ee984b12be29cc68) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: `unflattenObject` and `assertConfigKey` reject `__proto__`, `constructor` and `prototype` key segments. Before, a key like `__proto__.x` written to the store polluted `Object.prototype` in every app that read the config.

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
