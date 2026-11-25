---
"@adonis-agora/config-core": patch
---

Security: `unflattenObject` and `assertConfigKey` reject `__proto__`, `constructor` and `prototype` key segments. Before, a key like `__proto__.x` written to the store polluted `Object.prototype` in every app that read the config.
