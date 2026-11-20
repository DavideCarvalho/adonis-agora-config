---
"@adonis-agora/config": minor
"@adonis-agora/config-core": minor
---

createdAt / updatedAt on what the config lib keeps. Each entry now records `createdAt` (when its key was first set, kept by later writes; absent on entries written before) next to `updatedAt` / `updatedBy`. `config_tenant_keys` gains `updated_at` (last activated or retired), added at boot to existing tables as a NULL-able column (no rewrite, no backfill). With `autoCreateSchema: false`, add a migration calling `createConfigTables` (`agora:doctor` reports missing columns as `config.schema-columns`, and `missingConfigColumns()` lists them). Versions and the audit trail are append-only and keep their single timestamp.

The console API adds `createdAt` (ISO 8601 or `null`) to entries, and `document: { version, createdAt, updatedAt }` (the scope's first and latest version) to `GET /entries`. `TenantPublicKey` gains an optional `updatedAt`. Bundles the console that shows them.
