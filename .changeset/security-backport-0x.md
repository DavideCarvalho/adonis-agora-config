---
"@adonis-agora/config": minor
"@adonis-agora/config-core": patch
---

Security fixes backported to the 0.x line.

**Breaking:** federated console commands are now authenticated with a shared secret.

- The owning app must set `consoleCommands.secret` (at least 16 characters), and the console must set the same value as `federatedApps.<app>.controlPlane.secret` on every entry that may act (`actions` not `false`). Without it the web process refuses to boot and the error names the option to add. Every command and answer is signed (HMAC-SHA256), commands older than one minute are refused, and each command runs at most once.
- The console always sends its viewer's capabilities (every config capability when `authorize` does not narrow them). The app refuses a command without them; set, unset and rollback need `config:write`, a reveal needs `config:secrets:read`.
- `transports.redis({ secret })`: the control plane signs the Redis snapshot, and a tenant only boots from a snapshot whose signature checks out. Without a secret a tenant no longer boots from the Redis snapshot.

Other fixes:

- The control plane answers `400` to a label or environment that is not a plain name (letters, digits and `_ . : / @ + -`, at most 128 characters), and `etagOf` percent-encodes every part. `isValidScopeName` / `assertScopeName` are exported from `@adonis-agora/config-core`.
- `PUT /v1/keys` and `POST /v1/sealed` require `config:secrets:read` in addition to `config:read`.
- Vault resolvers receive `{ scope }` (the entry's app, environment and label), and the new `vault.allow(reference, scope)` refuses references an app should not reach; a refused reference is served masked. Add an `allow` rule when apps must not read each other's secrets.
- The MCP tools `config_list_entries`, `config_get_version` and `config_diff_versions` always mask secrets; reveal one through `config_get_entry`, which is audited.
- Version fingerprints hash secret values through an HMAC keyed by the app key (`fingerprintOf` accepts a `secretDigest`), and stored fingerprints are passed through it before they leave the store.
- `config:pull` shell-quotes printed values and skips invalid names; `--write` refuses values with line breaks or invalid names and escapes `$`.
- Tenant presence in the control plane is capped at 1,000 rows, and an SSE stream whose client left during setup is closed at once.
