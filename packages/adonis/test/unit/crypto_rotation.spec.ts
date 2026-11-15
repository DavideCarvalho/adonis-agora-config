import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigKeyring, keyringCodec, type SecretCodec } from '../../src/crypto/secrets.js';
import { type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { testScope } from '../../src/testing/index.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function sqlite(): Promise<SqlDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-rotate-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

const oldKey = 'the-old-app-key-of-32-characters!';
const newKey = 'the-new-app-key-of-32-characters!';

function oldCodec(): SecretCodec {
  return keyringCodec(createConfigKeyring({ appKey: oldKey }));
}

function rotatingCodec(): SecretCodec {
  return keyringCodec(
    createConfigKeyring({
      keys: [
        { id: '2026-11', secret: newKey },
        { id: 'app', secret: oldKey },
      ],
      active: '2026-11',
    }),
  );
}

describe('crypto rotation', () => {
  it('reports retired values and re-seals them with the active key', async () => {
    const db = await sqlite();
    const before = new LucidStore(db, { secretCodec: oldCodec() });
    await before.setup();
    await before.write(testScope, [{ key: 'p', value: 'hunter2', secret: true }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });

    const after = new LucidStore(db, { secretCodec: rotatingCodec() });
    // The version and the audit after-image are both sealed values.
    expect(await after.cryptoStatus()).toEqual({
      active: 0,
      retired: 2,
      legacy: 0,
      unreadable: 0,
    });

    const dry = await after.reseal({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, scanned: 2, resealed: 2, failed: 0 });
    expect((await after.cryptoStatus()).retired).toBe(2);

    const real = await after.reseal();
    expect(real).toMatchObject({ dryRun: false, scanned: 2, resealed: 2, failed: 0 });
    expect(await after.cryptoStatus()).toEqual({
      active: 2,
      retired: 0,
      legacy: 0,
      unreadable: 0,
    });
    expect((await after.read(testScope))?.entries.p?.value).toBe('hunter2');

    // The historical version and the audit before/after were re-sealed too.
    expect((await after.readVersion(testScope, 1))?.entries.p?.value).toBe('hunter2');
    const audit = await after.listAudit(testScope, { number: 1, size: 10 });
    expect(audit.rows[0]?.after?.value).toBe('hunter2');
  });

  it('fails the value it cannot open instead of dropping it', async () => {
    const db = await sqlite();
    const before = new LucidStore(db, { secretCodec: oldCodec() });
    await before.setup();
    await before.write(testScope, [{ key: 'p', value: 'hunter2', secret: true }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });

    const stranger = new LucidStore(db, {
      secretCodec: keyringCodec(
        createConfigKeyring({
          keys: [{ id: 'other', secret: 'a-totally-different-key-32-chars!!' }],
        }),
      ),
    });
    expect(await stranger.cryptoStatus()).toMatchObject({ unreadable: 2 });
    const report = await stranger.reseal();
    expect(report).toMatchObject({ scanned: 2, resealed: 0, failed: 2 });
    // The ciphertext is still there: a failed reseal never loses the value.
    const raw = new LucidStore(db, { secretCodec: rotatingCodec() });
    expect(await raw.cryptoStatus()).toMatchObject({ retired: 2 });
  });
});
