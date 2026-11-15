---
'@adonis-agora/config': minor
'@adonis-agora/config-core': minor
'@adonis-agora/config-client': minor
'@adonis-agora/config-dashboard': minor
---

The first release of the Agora config server, Spring Cloud Config style: a control plane that owns
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
`tenant.token`. Secrets use the Agora crypto kit (default key `app` from APP_KEY, optional
`crypto.keys`/`active` rotation, `config:crypto:reseal`, and the `config.crypto` doctor check); a KMS
key is a `{ id, kms }` entry. A tenant app holds an X25519 key pair (private key sealed at rest,
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
