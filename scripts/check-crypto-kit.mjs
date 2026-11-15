#!/usr/bin/env node
/**
 * agora crypto-kit drift check v1 — keep identical across libs.
 *
 * Every @adonis-agora lib that stores secrets keeps a verbatim copy of the canonical crypto kit at
 * `src/crypto-kit/`. This fails when a copy differs from the canonical files pinned below.
 *
 * Usage: node scripts/check-crypto-kit.mjs <package dir> [<package dir> ...]
 * e.g.   node scripts/check-crypto-kit.mjs packages/adonis
 *
 * Never edit a copy or these hashes in one repo: update _1x/shared/crypto-kit, re-copy every lib,
 * then update the hashes here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FROZEN = {
  'asymmetric.ts': '53e757d3e57799b1446f2631b0245d8f2c1326baaa72841a42b8c0e74799ec5b',
  'crypto-kit.cases.ts': '5185db7aca395fbf8bae3f393984fb31e0dcd7ab408986116f0f9cdcd77a38da',
  'index.ts': '8e4efd7177cab65767d0b5d1e1ca0b771170ed2f0f0ef970641ddd9f48c17d7f',
  'keyring.ts': '9ca9066d509d9694b71b0fe4f1a1f15aa74f7bbf24a892e44aef59ed6736f49f',
  'kms.ts': '0363c60641e136c511b193c3b35cff01d9e2e8b97966e98da7caea719a4a48d8',
  'seal.ts': 'd4900af5c1d9804e570fc5eaa499bfb20e9fb2352191a7b1bbc307db7650d726',
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/check-crypto-kit.mjs <package dir> [<package dir> ...]');
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  for (const [file, sha256] of Object.entries(FROZEN)) {
    const path = join(resolve(dir), 'src', 'crypto-kit', file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.error(`✖ ${path}: missing`);
      failed = true;
      continue;
    }
    const actual = createHash('sha256').update(text).digest('hex');
    if (!text.startsWith('// agora crypto-kit v1')) {
      console.error(`✖ ${path}: missing the canonical header`);
      failed = true;
    } else if (actual !== sha256) {
      console.error(
        `✖ ${path}: differs from the canonical copy (sha256 ${actual}, expected ${sha256})`,
      );
      failed = true;
    } else {
      console.log(`✔ ${path}`);
    }
  }
}
process.exit(failed ? 1 : 0);
