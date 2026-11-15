# @adonis-agora/config

Centralized configuration for AdonisJS apps, Spring Cloud Config style. The control plane owns every
app's configuration per environment and label, with versions, history and audit; tenants fetch at
boot, keep a snapshot, and hot-reload the keys marked reloadable.

```ts title="config/config.ts (an app)"
import { defineConfig } from '@adonis-agora/config'

export default defineConfig({
  topology: 'tenant',
  tenant: {
    url: env.get('CONFIG_URL'),
    partition: 'streaming',
    token: env.get('CONFIG_TOKEN'),
    snapshotPath: 'storage/config/snapshot.json',
  },
})
```

It also ships the console (`/_config`), the `config:entry:*`, `config:history`, `config:rollback`,
`config:env` and `config:pull` commands, the MCP dev tools and the `agora:doctor` checks, plus a
remote-safe client (`@adonis-agora/config-client`) for scripts and Sail.

Read the docs at [`docs/`](./docs): the control plane, the tenant, authentication, secrets, the
console, the CLI, MCP tools, deployment topologies and Sail.

Part of the Agora ecosystem. Requires `@adonisjs/core` 7; `@adonisjs/lucid` is optional (the
in-memory store needs nothing).
