---
"@adonis-agora/config": patch
"@adonis-agora/config-core": patch
---

Service-token capabilities now accept wildcards, with the same rule as every other Agora control plane: a `*` segment matches one segment and a trailing `*` matches the rest, so `config:*` and `*` cover `config:read` and `config:secrets:read`. The check lives in the new `capabilityAllows(granted, required)` helper (exported from `@adonis-agora/config-core` and `@adonis-agora/config`), and every control-plane check goes through it.

Heads-up: a token that already held `config:*` or `*` (previously ignored, so it was refused or got masked secrets) now gets every config capability, including unmasked secret values.
