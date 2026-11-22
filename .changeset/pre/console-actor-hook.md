---
'@adonis-agora/config': patch
---

Console: new `console.actor` option, which says who the audit trail records for a change or a reveal made in the console. Use it when people do not sign in through authkit-client, for example `actor: (ctx) => ({ id: realAccountId(ctx) })` on a Hub. Without it, the console records the authkit identity, else `ctx.auth.user`, else `console`.
