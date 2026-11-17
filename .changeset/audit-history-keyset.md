---
"@adonis-agora/config": minor
"@adonis-agora/config-dashboard": minor
---

The console's Audit and History pages page by cursor, so a deep page costs what the first one does and no page counts the scope's whole trail.

- `GET /audit` and `GET /versions` accept `first`/`after` and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The audit seeks past `(at, version, id)` and the versions past `version`, with no `COUNT(*)`. `page`/`size` keep the offset envelope and its total. `ConfigAdmin.auditCursor` / `versionsCursor` are the same reads in code.
- Stores gain optional `seekAudit` / `seekVersions`; both built-in stores implement them. The audit order now breaks ties on `at` and `version` by `id`, so rows written by one multi-key change keep one order across pages.
- The console walks both lists with Previous/Next and keeps the walked cursors in the URL (`#/audit?after=…`). It no longer shows a row total.
- New migration `add_config_audit_indexes` (published by `configure`), plus `createConfigAuditIndexes` / `dropConfigAuditIndexes`. `config_audit` had no index but its primary key. The migration indexes it by scope + `at`, scope + key, and scope + action, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Deployment).
- Fix: `node ace configure @adonis-agora/config` failed to render its stubs. `config/config.stub` had no `exports({ to })` header, and backticks in the comments of both stubs broke the stub template. A spec now renders every stub through the real engine.
