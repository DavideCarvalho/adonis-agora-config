---
'@adonis-agora/config': minor
---

`importRemoteConfig` gains `retry` (attempts with backoff, like `spring-retry`) and `failFast` (like `spring.cloud.config.fail-fast`). When every attempt failed and there is no snapshot, `failFast` makes the boot throw `RemoteConfigUnavailableError` (`E_REMOTE_CONFIG_UNAVAILABLE`) instead of booting on the local environment.
