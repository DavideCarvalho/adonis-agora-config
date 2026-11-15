---
'@adonis-agora/config': minor
'@adonis-agora/config-core': minor
---

The first release of the Agora config server, Spring Cloud Config style: a control plane that owns
every app's configuration per app, environment and label, with immutable versions, history, audit,
secrets encrypted at rest (or resolved from a vault) and an ETag + SSE tenant API; and a tenant that
fetches before the app's config loads, boots from a disk snapshot during an outage, and hot-reloads
the keys marked reloadable while reporting the ones that need a restart.

Tenant auth follows the Agora topology spec: `verifyTenant` top level with the three forms, the
`urn:agora:config` resource, a `partition` claim and `config:read` / `config:secrets:read`
capabilities. `tenant.localEnv` keeps a Sail worktree's ports ahead of the server in development.
