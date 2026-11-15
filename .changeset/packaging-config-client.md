---
'@adonis-agora/config': minor
---

The tenant HTTP client now ships inside `@adonis-agora/config` (root and the lean
`@adonis-agora/config/client` subpath), so a script, worker or Sail command installs one package.
`@adonis-agora/config-client` is deprecated; it keeps its published 0.1.0 for existing installs.
