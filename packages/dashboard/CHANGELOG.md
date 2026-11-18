# @adonis-agora/config-dashboard

## 0.3.2

### Patch Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-config/pull/20) [`6047728`](https://github.com/DavideCarvalho/adonis-agora-config/commit/6047728df7a6aee72de39c6827887c3958ed5dbf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console scope pickers with autocomplete (the kit's new `ComboSelect`): app, env and label in the topbar filter as you type, and a name `/meta` doesn't list yet (a scope with no entries) can be typed and picked.

## 0.3.1

### Patch Changes

- [#19](https://github.com/DavideCarvalho/adonis-agora-config/pull/19) [`9f1a596`](https://github.com/DavideCarvalho/adonis-agora-config/commit/9f1a59689a40e754d8639faa4d5de9e95c96480d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.3.0

### Minor Changes

- [#16](https://github.com/DavideCarvalho/adonis-agora-config/pull/16) [`464df30`](https://github.com/DavideCarvalho/adonis-agora-config/commit/464df30687f20d67b3599547b60e292bb21d903d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's Audit and History pages page by cursor, so a deep page costs what the first one does and no page counts the scope's whole trail.
  
  - `GET /audit` and `GET /versions` accept `first`/`after` and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The audit seeks past `(at, version, id)` and the versions past `version`, with no `COUNT(*)`. `page`/`size` keep the offset envelope and its total. `ConfigAdmin.auditCursor` / `versionsCursor` are the same reads in code.
  - Stores gain optional `seekAudit` / `seekVersions`; both built-in stores implement them. The audit order now breaks ties on `at` and `version` by `id`, so rows written by one multi-key change keep one order across pages.
  - The console walks both lists with Previous/Next and keeps the walked cursors in the URL (`#/audit?after=…`). It no longer shows a row total.
  - New migration `add_config_audit_indexes` (published by `configure`), plus `createConfigAuditIndexes` / `dropConfigAuditIndexes`. `config_audit` had no index but its primary key. The migration indexes it by scope + `at`, scope + key, and scope + action, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Deployment).
  - Fix: `node ace configure @adonis-agora/config` failed to render its stubs. `config/config.stub` had no `exports({ to })` header, and backticks in the comments of both stubs broke the stub template. A spec now renders every stub through the real engine.

## 0.2.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-agora-config/pull/15) [`b337ea0`](https://github.com/DavideCarvalho/adonis-agora-config/commit/b337ea070c7ac0ffc557af173463d98de5429ec5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's view state now lives in the URL, so a view can be shared, bookmarked and reloaded, and back/forward step through it: the app/environment/label scope picked in the topbar, the Entries search and page, the History page, open version and diff, and the Audit action and page. They sit in the hash's query (`#/history?env=staging&from=10&to=12`); a value at its default is left out, so existing links open as before, and the scope is kept when you move between pages.

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

- [#7](https://github.com/DavideCarvalho/adonis-agora-config/pull/7) [`ca3b7c9`](https://github.com/DavideCarvalho/adonis-agora-config/commit/ca3b7c94231c9f3df8ded7b8e911149e442e83c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - ⌘K now navigates: it lists every page of the console's sidebar and every other Agora console you can open ("Go to Workflows", found by "durable" too), matched case- and accent-insensitively, before the console's own commands and the cross-console search hits. ⌘K opens even without a search endpoint, and shows the pages and consoles before anything is typed.

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
