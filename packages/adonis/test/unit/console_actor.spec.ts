import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { consoleActor } from '../../src/dashboard/actor.js';

function ctx(input: Record<string, unknown>): HttpContext {
  return input as unknown as HttpContext;
}

describe('consoleActor', () => {
  it('uses the Wave 1 Identity.actor as the audit actor, not the subject', async () => {
    const actor = await consoleActor(
      ctx({
        authkit: {
          identity: {
            userId: 'user-1',
            email: 'user@example.com',
            actor: { sub: 'admin-1', email: 'admin@example.com' },
          },
        },
      }),
    );
    expect(actor).toEqual({ id: 'admin-1', email: 'admin@example.com' });
  });

  it('reads the legacy raw.act claim and resolves identity lazily', async () => {
    const actor = await consoleActor(
      ctx({
        authkit: {
          getIdentity: async () => ({
            userId: 'user-1',
            raw: { act: { sub: 'on-call' } },
          }),
        },
      }),
    );
    expect(actor).toEqual({ id: 'on-call' });
  });

  it('falls back to the subject, then to ctx.auth.user, then to console', async () => {
    expect(await consoleActor(ctx({ authkit: { identity: { userId: 'user-1' } } }))).toEqual({
      id: 'user-1',
    });
    expect(
      await consoleActor(ctx({ auth: { user: { id: 7, email: 'seven@example.com' } } })),
    ).toEqual({ id: '7', email: 'seven@example.com' });
    expect(await consoleActor(ctx({}))).toEqual({ id: 'console' });
  });

  it('survives a throwing identity getter', async () => {
    expect(
      await consoleActor(
        ctx({
          authkit: {
            getIdentity: () => {
              throw new Error('nope');
            },
          },
        }),
      ),
    ).toEqual({ id: 'console' });
  });
});
