---
"@adonis-agora/config": patch
---

`stores.lucid()` and `transports.redis()` now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the default Lucid store, so telescope's Architecture page shows "config: configuration → PostgreSQL" without any app code.
