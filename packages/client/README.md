# @adonis-agora/config-client

A small, remote-safe client for an `@adonis-agora/config` control plane: fetch one app's
configuration with a shared secret, a ready token, or authkit client credentials (`resource:
urn:agora:config`). Works in an AdonisJS app, a script, a worker, a Docker container or the Sail
CLI — no AdonisJS dependency.

```ts
import { createConfigClient, tokens } from '@adonis-agora/config-client'

const client = createConfigClient({
  url: 'https://config.example.com/_config',
  partition: 'streaming',
  environment: 'production',
  token: tokens.authkit({
    issuer: process.env.AUTHKIT_ISSUER!,
    clientId: process.env.AUTHKIT_CLIENT_ID!,
    clientSecret: process.env.AUTHKIT_CLIENT_SECRET!,
  }),
})

await client.refresh()
client.get('db.host')
client.all()
client.status()
```

`tokens.authkit()` uses `authkitTenantToken` from `@adonis-agora/authkit-client` when it is
installed, and otherwise the same client-credentials flow against the issuer's discovery document
(`/.well-known/openid-configuration`), so it works before the helper ships.

Part of the Agora ecosystem.
