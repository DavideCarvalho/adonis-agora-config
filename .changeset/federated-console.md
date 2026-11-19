---
"@adonis-agora/config": minor
"@adonis-agora/config-dashboard": minor
---

Federated console. An app that runs config standalone (its own store and keys) can appear in another app's console: the console lists it in `console.federatedApps`, reads its versions and audit straight from its tables with every secret value and vault reference dropped, and sends set/unset/rollback and reveal to the app over Redis. The owning app opts in with `consoleCommands` (`actions`, `reveal`); it writes its own versions and audit with the other console's viewer as the actor. Values cross Redis sealed (writes to a key derived from the app's `APP_KEY`, reveals to a per-request key), and a federated reveal needs `config:secrets:read` in the console's `authorize` grant (`capabilities`, new). New routes: `GET /api/apps`, `GET /api/scopes`. The App picker shows a federated badge and notice, and a read-only federated app disables the edit buttons.
