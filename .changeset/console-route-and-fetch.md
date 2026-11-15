---
'@adonis-agora/config': patch
'@adonis-agora/config-client': patch
'@adonis-agora/config-dashboard': patch
---

Two console fixes:

- The console no longer registers `GET <path>` **and** `GET <path>/`. AdonisJS drops the trailing
  slash when it computes a route pattern, so both were the same route and the HTTP server died at
  boot with `Duplicate route found`. One route is registered and it still answers the
  trailing-slash URL (including a custom `console.path`).
- A stored `fetch` is now bound to the global object before it is called. `fetch` is a method of
  `window` in the browser, so calling it as a property of another object (the console's `ConfigApi`,
  the `ConfigClient` and the tenant client's conditional GET) threw `TypeError: Illegal invocation`
  and the console rendered an error while the API worked.
