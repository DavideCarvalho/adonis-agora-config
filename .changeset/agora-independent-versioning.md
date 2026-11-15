---
'@adonis-agora/config': patch
'@adonis-agora/config-core': patch
'@adonis-agora/config-client': patch
---

Declare `"agora": { "versioning": "independent" }` in every published package's `package.json`.
Config is 0.x on purpose and does not follow the 1.x Agora train, so `agora:doctor`'s "Agora
versions line up" check no longer warns that `@adonis-agora/config` 0.x is installed next to the
1.x rc libraries. Metadata only — no runtime or API change.
