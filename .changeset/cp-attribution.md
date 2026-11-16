---
'@adonis-agora/config': minor
---

Control-plane attribution, per-viewer grants and a lazy tenant URL:

- Every `agora:config:*` diagnostic passes its payload's `app` as the envelope `app`
  (`@adonis-agora/diagnostics` 1.0.0-rc.6+), so Telescope tags it `app:<name>`. Older diagnostics
  ignore the extra argument.
- New `tenant.fetch` event: the control plane emits it (attributed to the tenant) when it serves a
  tenant its document. A `304` poll is not an event; the tenant emits nothing for the read.
- `console.authorize` may answer `{ allowed: true, apps: '*' | string[] }`: the viewer only sees and
  changes those apps in the console API, the pickers, ⌘K and the MCP dev tools. `console.apps`
  stays the upper bound, and the dev tools and ⌘K now honour it too.
- `tenant.url` (and `createTenantClient`/`bootstrapConfig`'s `url`) also takes
  `() => Promise<string>`, optionally with `refresh()` (`controlPlaneUrl()` from
  `@adonis-agora/authkit-client`). It resolves before the first request and is refreshed, with one
  retry, on a connection error or a 404. `TenantClient.url` is `undefined` until a lazy URL
  resolves; `resolveUrl()` resolves it.
