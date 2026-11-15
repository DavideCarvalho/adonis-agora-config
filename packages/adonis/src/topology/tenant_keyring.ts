import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConfigValue } from '@adonis-agora/config-core';
import type { SecretCodec } from '../crypto/secrets.js';
import { generateKeyPair, type OkpJwk, openWith, publicJwk, sealTo } from '../crypto-kit/index.js';

/** Default location of a tenant's key file, relative to the app root. */
export const DEFAULT_TENANT_KEY_PATH = 'storage/config-tenant-key.json';

/** What the key file holds: the private keys, each sealed by the app's symmetric codec. */
interface TenantKeyFile {
  v: 1;
  /** The kid new `sealTo` values use. */
  active: string;
  /** Newest first; retired keys stay so old values still open. */
  keys: Array<{ kid: string; sealed: string }>;
}

export interface TenantKeyringOptions {
  /** Absolute path of the key file (created with mode 0600 when missing). */
  path: string;
  /**
   * The symmetric codec that seals the private keys at rest (the config crypto kit over APP_KEY).
   * The control plane never sees this file or this key.
   */
  codec: SecretCodec;
  /**
   * AAD base for the sealed private keys, e.g. `config:tenant-key:<app>`; each key adds `:<kid>`,
   * so a key file (or one key in it) cannot be moved to another app.
   */
  aad: string;
}

/** How this app's key stands, for the doctor and the CLI. */
export interface TenantKeyringStatus {
  activeKid: string;
  kids: string[];
  path: string;
}

/**
 * A tenant app's own X25519 key pair, for secrets the control plane must not read. The private
 * keys never leave the app: they are sealed with the app's symmetric keyring at rest (mode 0600)
 * and only the public halves are registered with the control plane.
 *
 * Rotation keeps the retired private keys, so values sealed to them still open while the CLI
 * re-seals them to the new key. Nothing here is config-specific: it is the crypto kit's
 * `generateKeyPair`/`sealTo`/`openWith` plus a small file.
 */
export class TenantKeyring {
  readonly path: string;
  readonly #codec: SecretCodec;
  readonly #aad: string;
  #keys: Array<{ kid: string; privateKey: OkpJwk }>;
  #activeKid: string;

  private constructor(
    options: TenantKeyringOptions,
    keys: Array<{ kid: string; privateKey: OkpJwk }>,
    active: string,
  ) {
    this.path = options.path;
    this.#codec = options.codec;
    this.#aad = options.aad;
    this.#keys = keys;
    this.#activeKid = active;
  }

  /**
   * Reads the key file, creating a first key pair when it does not exist. A file that exists but
   * cannot be opened is an error: silently generating a new key would strand every sealed value.
   */
  static async load(options: TenantKeyringOptions): Promise<TenantKeyring> {
    let text: string | undefined;
    try {
      text = await readFile(options.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (text === undefined) {
      const created = new TenantKeyring(options, [], '');
      await created.rotate();
      return created;
    }
    let file: TenantKeyFile;
    try {
      file = JSON.parse(text) as TenantKeyFile;
    } catch {
      throw new Error(`config: the tenant key file at ${options.path} is not valid JSON`);
    }
    if (file.v !== 1 || !Array.isArray(file.keys) || typeof file.active !== 'string') {
      throw new Error(`config: the tenant key file at ${options.path} has an unknown shape`);
    }
    const keys: Array<{ kid: string; privateKey: OkpJwk }> = [];
    for (const entry of file.keys) {
      if (typeof entry.kid !== 'string' || typeof entry.sealed !== 'string') {
        throw new Error(`config: the tenant key file at ${options.path} has a malformed key entry`);
      }
      let privateKey: OkpJwk;
      try {
        privateKey = (await options.codec.open(entry.sealed, {
          aad: `${options.aad}:${entry.kid}`,
        })) as unknown as OkpJwk;
      } catch {
        throw new Error(
          `config: cannot open the tenant private key "${entry.kid}" at ${options.path}; the app encryption key changed, or the file was copied from another app`,
        );
      }
      if (
        privateKey?.kty !== 'OKP' ||
        privateKey.crv !== 'X25519' ||
        typeof privateKey.d !== 'string' ||
        privateKey.kid !== entry.kid
      ) {
        throw new Error(
          `config: the tenant private key "${entry.kid}" at ${options.path} is not an X25519 private JWK`,
        );
      }
      keys.push({ kid: entry.kid, privateKey });
    }
    if (keys.length === 0 || !keys.some((key) => key.kid === file.active)) {
      throw new Error(`config: the tenant key file at ${options.path} has no active key`);
    }
    return new TenantKeyring(options, keys, file.active);
  }

  get activeKid(): string {
    return this.#activeKid;
  }

  /** The private key new `sealTo` values use. */
  get activePrivateKey(): OkpJwk {
    return this.#keys.find((key) => key.kid === this.#activeKid)!.privateKey;
  }

  status(): TenantKeyringStatus {
    return {
      activeKid: this.#activeKid,
      kids: this.#keys.map((key) => key.kid),
      path: this.path,
    };
  }

  /** The public halves to register with the control plane, active first. */
  publicKeys(): OkpJwk[] {
    return this.#keys.map((key) => publicJwk(key.privateKey));
  }

  /** Every private key, active first: the ring `openWith` searches by kid. */
  privateKeys(): OkpJwk[] {
    return [
      this.activePrivateKey,
      ...this.#keys.filter((key) => key.kid !== this.#activeKid).map((key) => key.privateKey),
    ];
  }

  /** Opens an `agora:pk1:…` value sealed to one of this app's keys. */
  open(sealed: string, aad: string): string {
    return openWith(this.privateKeys(), sealed, { aad });
  }

  /** Seals a value to this app's active public key (the control plane cannot open it). */
  seal(value: string, aad: string): string {
    return sealTo(publicJwk(this.activePrivateKey), value, { aad });
  }

  /**
   * Adds a fresh active key pair, keeping the retired private keys (so values sealed to them still
   * open until they are re-sealed). Persists the file before returning.
   */
  async rotate(): Promise<OkpJwk> {
    const pair = generateKeyPair('x25519');
    this.#keys = [{ kid: pair.publicKey.kid, privateKey: pair.privateKey }, ...this.#keys];
    this.#activeKid = pair.publicKey.kid;
    await this.save();
    return pair.publicKey;
  }

  /** Writes the file atomically, mode 0600: a crash never leaves a truncated key file. */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file: TenantKeyFile = {
      v: 1,
      active: this.#activeKid,
      keys: [],
    };
    for (const key of this.#keys) {
      const sealed = await this.#codec.seal(key.privateKey as unknown as ConfigValue, {
        aad: `${this.#aad}:${key.kid}`,
      });
      file.keys.push({ kid: key.kid, sealed });
    }
    // The temp file is created 0600 and renamed over the target, so the mode is never wider.
    await writeFile(`${this.path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }

  /** The AAD of a private key, exported for tests and for a future migration. */
  aadFor(kid: string): string {
    return `${this.#aad}:${kid}`;
  }
}
