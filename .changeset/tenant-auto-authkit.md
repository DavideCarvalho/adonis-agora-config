---
"@adonis-agora/config": minor
---

Tenant topology: `defineConfig({ topology: 'tenant' })` is enough when `@adonis-agora/authkit-client` is configured with its `service`. The control plane URL, the service token for `urn:agora:config` and the partition come from its `authkit.client` binding (`tenantOf`, read structurally: no dependency on authkit-client). Anything set in `tenant` wins, field by field; `tenant: { auto: false }` turns the lookup off. An authkit-client without `tenantOf`, or without `service`, counts as absent. Without either, the web process refuses to boot naming the missing fields and both fixes (`node ace` only warns). A new `config.tenant-source` doctor check shows where each field came from (`authkit-client (auto)` or `explicit`).
