# adonis-config

Centralized configuration for AdonisJS apps, in the shape of Spring Cloud Config: one control plane
owns the configuration of every app, per environment and label, with history and audit; each app is a
tenant that boots from the server (or from its last snapshot) and hot-reloads what can be reloaded.

Part of the Agora ecosystem.

- `@adonis-agora/config` — the AdonisJS control plane and tenant.
- `@adonis-agora/config-core` — the document format, flattening, diffing and versioning.
- `@adonis-agora/config-dashboard` — the console SPA, served by the control plane.

Docs live in [`docs/`](./docs).
