---
"@adonis-agora/config": patch
---

`transports.redis({ connection })` takes the connection from the app container instead of `@adonisjs/redis/services/main`. That service is only set once the app has booted, while a control plane builds its transport during provider boot, so an ace command such as `migration:run` crashed with `Cannot read properties of undefined (reading 'connection')`.
