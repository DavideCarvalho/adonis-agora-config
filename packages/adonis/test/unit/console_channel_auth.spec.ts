import { createHmac } from 'node:crypto';
import { canonicalJson } from '@adonis-agora/config-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_COMMAND_MAX_AGE_MS,
  type ConsoleCommand,
  consoleMacKey,
  RedisConsoleChannel,
} from '../../src/federation/redis_channel.js';
import { RedisBus } from '../support/redis_bus.js';

const SECRET = 'a-shared-secret-0123456789';
const PREFIX = 'et';
const COMMANDS = `${PREFIX}-config-console`;
const REPLIES = `${PREFIX}-config-console-reply`;

const command = (id = 'c1'): ConsoleCommand => ({
  id,
  verb: 'reveal',
  args: [],
  actor: 'ana',
  capabilities: ['config:secrets:read'],
});

function signed(key: Buffer, kind: 'command' | 'reply', body: unknown): string {
  return createHmac('sha256', key)
    .update(`config-console:${kind}\n${canonicalJson(body)}`)
    .digest('base64url');
}

/** Lets the bus deliver what was published (it hands messages over on a microtask). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

async function answering(bus: RedisBus, secret: string | undefined = SECRET) {
  const runs: ConsoleCommand[] = [];
  const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX, secret });
  await channel.answer(async (cmd) => {
    runs.push(cmd);
    return { ran: cmd.verb };
  });
  return { channel, runs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('authenticated console channel', () => {
  it('runs a signed command once and the console accepts the signed answer', async () => {
    const bus = new RedisBus();
    const { runs } = await answering(bus);
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const reply = await console.send(command(), { timeoutMs: 500 });
    expect(reply).toEqual({ id: 'c1', ok: true, data: { ran: 'reveal' } });
    expect(runs).toHaveLength(1);
    // Replaying the exact same signed command (fresh, same id) finds the claim taken.
    const sent = bus.published.find((p) => p.channel === COMMANDS)!;
    await bus.connection().publish(COMMANDS, sent.message);
    await flush();
    expect(runs).toHaveLength(1);
  });

  it('drops unsigned, forged, wrongly keyed and stale commands without throwing', async () => {
    const bus = new RedisBus();
    const { runs } = await answering(bus);
    const raw = bus.connection();
    const key = consoleMacKey(SECRET, PREFIX);
    const wrong = consoleMacKey('another-secret-0123456789', PREFIX);
    const now = Date.now();

    // The 0.x wire format: a bare command.
    await raw.publish(COMMANDS, JSON.stringify(command('bare')));
    // Garbage.
    await raw.publish(COMMANDS, '{not json');
    await raw.publish(COMMANDS, JSON.stringify(null));
    // Signed with another secret.
    const c2 = command('wrong-key');
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        v: 1,
        ts: now,
        command: c2,
        mac: signed(wrong, 'command', [PREFIX, now, c2]),
      }),
    );
    // Correctly signed, then altered (capabilities widened).
    const c3 = command('tampered');
    const mac3 = signed(key, 'command', [PREFIX, now, c3]);
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        v: 1,
        ts: now,
        command: { ...c3, capabilities: ['config:*'] },
        mac: mac3,
      }),
    );
    // Correctly signed but stale.
    const old = now - CONSOLE_COMMAND_MAX_AGE_MS - 1_000;
    const c4 = command('stale');
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        v: 1,
        ts: old,
        command: c4,
        mac: signed(key, 'command', [PREFIX, old, c4]),
      }),
    );
    // Correctly signed for another prefix.
    const c5 = command('other-prefix');
    await raw.publish(
      COMMANDS,
      JSON.stringify({ v: 1, ts: now, command: c5, mac: signed(key, 'command', ['hub', now, c5]) }),
    );
    await flush();
    expect(runs).toEqual([]);

    // Control: a correctly signed, fresh command does run.
    const ok = command('ok');
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        v: 1,
        ts: now,
        command: ok,
        mac: signed(key, 'command', [PREFIX, now, ok]),
      }),
    );
    await flush();
    expect(runs.map((r) => r.id)).toEqual(['ok']);
  });

  it('the console ignores answers that are not signed with the secret', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A fake "app" that answers every command with an unsigned or wrongly signed reply.
    await raw.subscribe(COMMANDS, (message) => {
      const { command: cmd } = JSON.parse(message) as { command: ConsoleCommand };
      const forged = { id: cmd.id, ok: true, data: 'forged' };
      void raw.publish(REPLIES, JSON.stringify(forged));
      void raw.publish(
        REPLIES,
        JSON.stringify({
          v: 1,
          reply: forged,
          mac: signed(consoleMacKey('another-secret-0123456789', PREFIX), 'reply', [
            PREFIX,
            forged,
          ]),
        }),
      );
    });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    await expect(console.send(command(), { timeoutMs: 100 })).rejects.toThrow(/within 100ms/);
  });

  it('fails closed without a secret: no command sent, none answered', async () => {
    const bus = new RedisBus();
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    expect(console.authenticated).toBe(false);
    await expect(console.send(command())).rejects.toThrow(/controlPlane\.secret/);
    expect(bus.published).toEqual([]);
    const app = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    await expect(app.answer(async () => null)).rejects.toThrow(/consoleCommands\.secret/);
    expect(
      () => new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX, secret: 'short' }),
    ).toThrow(/at least 16/);
  });
});
