---
'@adonis-agora/config': patch
---

Console: opening a version on the History page no longer crashes ("Cannot read properties of undefined (reading 'createdBy')"). `GET <console>/api/versions/:version` answers `{ version, entries }`, the shape the page reads.
