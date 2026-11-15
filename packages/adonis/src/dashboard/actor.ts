import type { HttpContext } from '@adonisjs/core/http';

/** Who is acting in the console: `act` (RFC 8693 impersonation) when present, else `sub`. */
export interface ConsoleActor {
  id: string;
  email?: string;
}

const IDENTITY_TIMEOUT_MS = 250;

function read(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolves the audit actor, structurally: authkit's per-request identity when there is one
 * (`userId`, `email`, `raw.act.sub`), else `ctx.auth.user` (`id`/`userId`, `email`, `actor.sub`),
 * else `console`. The subject authorizes; the actor is what the audit trail records.
 */
export async function consoleActor(ctx: HttpContext): Promise<ConsoleActor> {
  const authkit = read(ctx, 'authkit');
  let identity = read(authkit, 'identity');
  const getIdentity = read(authkit, 'getIdentity');
  if ((identity === null || identity === undefined) && typeof getIdentity === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      identity = await Promise.race([
        Promise.resolve(getIdentity.call(authkit)),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), IDENTITY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      identity = undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  const user = read(read(ctx, 'auth'), 'user');
  const sub =
    text(read(identity, 'userId')) ?? text(read(user, 'id')) ?? text(read(user, 'userId'));
  const actor =
    text(read(read(read(identity, 'raw'), 'act'), 'sub')) ??
    text(read(read(user, 'actor'), 'sub')) ??
    text(read(user, 'act'));
  const email = text(read(identity, 'email')) ?? text(read(user, 'email'));
  const id = actor ?? sub ?? 'console';
  return { id, ...(email ? { email } : {}) };
}
