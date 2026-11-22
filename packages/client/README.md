# @adonis-agora/config-client

A small, remote-safe client for an `@adonis-agora/config` control plane: fetch one app's
configuration with a shared secret, a ready token, or authkit client credentials (`resource:
urn:agora:config`). Works in an AdonisJS app, a script, a worker, a Docker container or the Sail
CLI — no AdonisJS dependency.

```ts
import { authkitTenantToken } from '@adonis-agora/authkit-client'
import { createConfigClient } from '@adonis-agora/config-client'

const client = createConfigClient({
  url: 'https://config.example.com/_config',
  partition: 'streaming',
  environment: 'production',
  token: authkitTenantToken({
    issuer: process.env.AUTHKIT_ISSUER!,
    clientId: process.env.AUTHKIT_CLIENT_ID!,
    clientSecret: process.env.AUTHKIT_CLIENT_SECRET!,
    resource: 'urn:agora:config',
  }),
})

await client.refresh()
client.get('db.host')
client.all()
client.status()
```

`token` is any `string`, `() => Promise<string>` or `{ get() }`. With authkit, pass
`authkitTenantToken(...)` from `@adonis-agora/authkit-client`; a `401` calls its `reset()` and the
next request fetches a fresh token. This package has no OAuth or authkit logic of its own.

Part of the Agora ecosystem.

## React

`@adonis-agora/config-client/react` reads the keys an app lets the browser see (`browser.keys` in
`config/config.ts`): `useConfig('site.banner')`, `InertiaConfigProvider` (from
`/react/inertia`) and `RemoteConfigProvider`, with live updates over transmit. See
https://davidecarvalho.github.io/agora/docs/config/browser
