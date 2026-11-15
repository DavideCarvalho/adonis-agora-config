import { describe, expect, it } from 'vitest';
import { ensureGitignore, hasEncryptedValues, upsertConfigBlock } from '../../src/env_file.js';

describe('upsertConfigBlock', () => {
  it('writes a managed block and keeps everything else', () => {
    const result = upsertConfigBlock('APP_KEY=base64:x\n', {
      DB_HOST: 'db.internal',
      DB_PORT: '5432',
    });
    expect(result.added).toEqual(['DB_HOST', 'DB_PORT']);
    expect(result.skipped).toEqual([]);
    expect(result.content).toContain('APP_KEY=base64:x');
    expect(result.content).toContain('# config:start');
    expect(result.content).toContain('DB_HOST=db.internal\nDB_PORT=5432');
    expect(result.content.trimEnd().endsWith('# config:end')).toBe(true);
  });

  it('skips a key the file already sets outside the block', () => {
    const existing =
      'DB_PORT=5789\n\n# config:start\n# old\nDB_PORT=5432\nDB_HOST=old\n# config:end\n';
    const result = upsertConfigBlock(existing, { DB_PORT: '5432', DB_HOST: 'db.internal' });
    expect(result.added).toEqual(['DB_HOST']);
    expect(result.skipped).toEqual(['DB_PORT']);
    expect(result.content).toContain('DB_PORT=5789');
    expect(result.content).not.toContain('DB_HOST=old');
    expect(result.content.match(/# config:start/g)).toHaveLength(1);
  });

  it('is idempotent and places our block before Sail', () => {
    const existing = '# sail:start\nDB_PORT=5789\n# sail:end\n';
    const first = upsertConfigBlock(existing, { DB_HOST: 'db.internal' });
    expect(first.content.indexOf('# config:start')).toBeLessThan(
      first.content.indexOf('# sail:start'),
    );
    const second = upsertConfigBlock(first.content, { DB_HOST: 'db.internal' });
    expect(second.content).toBe(first.content);
  });

  it('removes the block when there is nothing to add', () => {
    const existing = '# config:start\nDB_HOST=x\n# config:end\nDB_HOST=local\n';
    const result = upsertConfigBlock(existing, { DB_HOST: 'server' });
    expect(result.content).not.toContain('# config:start');
    expect(result.content).toContain('DB_HOST=local');
    expect(result.skipped).toEqual(['DB_HOST']);
  });
});

describe('env file safety', () => {
  it('detects varlock ciphertext', () => {
    expect(hasEncryptedValues('SECRET=varlock(local:abc)')).toBe(true);
    expect(hasEncryptedValues('SECRET=plain')).toBe(false);
  });

  it('adds an exact .gitignore line once', () => {
    expect(ensureGitignore('node_modules/\n', '.env.local')).toEqual({
      content: 'node_modules/\n.env.local\n',
      changed: true,
    });
    expect(ensureGitignore('node_modules/\n.env.local\n', '.env.local').changed).toBe(false);
  });
});
