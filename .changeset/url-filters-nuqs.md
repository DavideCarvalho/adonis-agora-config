---
"@adonis-agora/config-dashboard": minor
---

The console's view state now lives in the URL, so a view can be shared, bookmarked and reloaded, and back/forward step through it: the app/environment/label scope picked in the topbar, the Entries search and page, the History page, open version and diff, and the Audit action and page. They sit in the hash's query (`#/history?env=staging&from=10&to=12`); a value at its default is left out, so existing links open as before, and the scope is kept when you move between pages.
