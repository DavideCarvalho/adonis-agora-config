---
"@adonis-agora/config": patch
---

`node ace add @adonis-agora/config` (and `node ace configure @adonis-agora/config`) now runs the configure hook: the main entry exports `configure`, which Adonis looks for there. Before, it only warned "the module does not export the configure hook" and published nothing.
