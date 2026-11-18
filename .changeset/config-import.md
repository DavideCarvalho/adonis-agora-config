---
'@adonis-agora/config': minor
---

`node ace config:import [--file] [--secrets] [--skip] [--dry-run]` imports env variables into entries in one version. The input can be a `.env`, a JSON object or stdin. `RESEND_API_KEY` becomes `resend.api.key`, values are kept as text, and names matching the secret pattern are stored as secrets. The command never prints a value. New `ConfigAdmin.setEntries()` writes several entries in one version.
