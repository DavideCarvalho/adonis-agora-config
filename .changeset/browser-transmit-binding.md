---
'@adonis-agora/config': patch
---

`browser.realtime` now broadcasts. The provider read `@adonisjs/transmit/services/main` before the app booted, when that module's export is still `undefined`, so every change was dropped silently. It now reads the `transmit` binding from the container once the app has booted, and logs a warning when a broadcast fails.
