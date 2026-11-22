import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigScope } from '@adonis-agora/config-core';

/**
 * Browser tokens for the direct mode: short-lived and HMAC-signed. A tenant mints them for its own
 * pages, and the control plane verifies them before serving that scope's browser values.
 *
 * Each scope signs with its own key, derived from the control plane's secret and the scope. The
 * control plane derives the key again from the token's scope, so a token cannot be moved to another
 * app, environment or label, and an app can only mint tokens for itself. A tenant gets its key over
 * its authenticated tenant connection, so there is no extra secret to distribute.
 */

const VERSION = 'v1';

export interface BrowserTokenPayload {
  app: string;
  env: string;
  label: string;
  /** The tenant's `browser.keys`, so listed keys are served too. */
  keys?: string[];
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface VerifiedBrowserToken {
  scope: ConfigScope;
  keys: string[];
  /** Epoch ms. */
  expiresAt: number;
}

export interface IssuedBrowserToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** What a tenant signs with: the key of its own scope. */
export interface BrowserKey {
  key: string;
  app: string;
  environment: string;
  label: string;
}

/** The signing key of one scope. */
export function browserKeyOf(secret: string, scope: ConfigScope): string {
  return createHmac('sha256', secret)
    .update(`config-browser-key:${VERSION}:${scope.app}:${scope.environment}:${scope.label}`)
    .digest('base64url');
}

export function signBrowserToken(
  key: BrowserKey,
  options: { keys?: readonly string[]; ttlSeconds?: number } = {},
): IssuedBrowserToken {
  const exp = Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 600);
  const payload: BrowserTokenPayload = {
    app: key.app,
    env: key.environment,
    label: key.label,
    ...(options.keys && options.keys.length > 0 ? { keys: [...options.keys] } : {}),
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key.key).update(`${VERSION}.${body}`).digest('base64url');
  return { token: `${VERSION}.${body}.${signature}`, expiresAt: exp * 1000 };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verifies a browser token against the control plane's secret. `null` when invalid or expired. */
export function verifyBrowserToken(
  token: string | undefined,
  secret: string,
): VerifiedBrowserToken | null {
  if (!token) return null;
  const [version, body, signature] = token.split('.');
  if (version !== VERSION || !body || !signature) return null;
  let payload: Partial<BrowserTokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload.app !== 'string' ||
    typeof payload.env !== 'string' ||
    typeof payload.label !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp * 1000 < Date.now()
  ) {
    return null;
  }
  const scope = { app: payload.app, environment: payload.env, label: payload.label };
  const expected = createHmac('sha256', browserKeyOf(secret, scope))
    .update(`${VERSION}.${body}`)
    .digest('base64url');
  if (!sameString(signature, expected)) return null;
  const keys = Array.isArray(payload.keys)
    ? payload.keys.filter((key): key is string => typeof key === 'string' && key !== '*')
    : [];
  return { scope, keys, expiresAt: payload.exp * 1000 };
}
