import { CONFIG_RESOURCE, CONFIG_SCOPES } from '@adonis-agora/config-core';

/** Where a client gets the bearer token it presents to the control plane. */
export interface TenantToken {
  get(): Promise<string>;
  /** Drops a cached token (after a 401), so the next `get` fetches a fresh one. */
  invalidate?(): void;
}

/** A fixed string, a function, or an object with `get()`. */
export type TenantTokenSource = string | (() => Promise<string>) | TenantToken;

/** Normalizes every accepted token source into {@link TenantToken}. */
export function resolveTokenSource(source: TenantTokenSource): TenantToken {
  if (typeof source === 'string') {
    if (source === '') throw new Error('config: the token is empty');
    return { get: async () => source };
  }
  if (typeof source === 'function') return { get: source };
  if (source && typeof source.get === 'function') {
    return {
      get: () => source.get(),
      ...(typeof source.invalidate === 'function'
        ? { invalidate: () => source.invalidate?.() }
        : {}),
    };
  }
  throw new Error('config: a token source must be a string, a function or an object with get()');
}

export interface ClientCredentialsOptions {
  /** The issuer (authkit-server or any OIDC provider): discovery finds the token endpoint. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The `resource` (RFC 8707). Default `urn:agora:config`. */
  resource?: string;
  /** The scopes. Default `config:read`. Add `config:secrets:read` for secret values. */
  scope?: string | string[];
  /** Refresh this long before expiry (ms). Default 30000. */
  leewayMs?: number;
  fetch?: typeof fetch;
}

export type AuthkitTokenOptions = ClientCredentialsOptions;

interface Discovery {
  token_endpoint?: unknown;
}

/**
 * OAuth 2.0 client credentials (RFC 6749 §4.4) discovered from the issuer's
 * `/.well-known/openid-configuration` — never a hard-coded `/oauth/token`. Tokens are cached until
 * shortly before they expire and concurrent callers share one in-flight request.
 */
export function clientCredentials(options: ClientCredentialsOptions): TenantToken {
  const fetcher = options.fetch ?? fetch;
  const issuer = options.issuer.replace(/\/$/, '');
  const resource = options.resource ?? CONFIG_RESOURCE;
  const scope = Array.isArray(options.scope)
    ? options.scope.join(' ')
    : (options.scope ?? CONFIG_SCOPES.read);
  const leeway = options.leewayMs ?? 30_000;
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  let endpoint: string | undefined;

  const discover = async (): Promise<string> => {
    if (endpoint) return endpoint;
    let response: Response;
    try {
      response = await fetcher(`${issuer}/.well-known/openid-configuration`);
    } catch (error) {
      throw new Error(
        `config: discovery failed at ${issuer}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`config: discovery answered ${response.status} at ${issuer}`);
    }
    const discovery = (await response.json()) as Discovery;
    if (typeof discovery.token_endpoint !== 'string' || discovery.token_endpoint === '') {
      throw new Error(`config: ${issuer} discovery has no token_endpoint`);
    }
    endpoint = discovery.token_endpoint;
    return endpoint;
  };

  const fetchToken = async () => {
    const tokenEndpoint = await discover();
    const response = await fetcher(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        resource,
        audience: resource,
        scope,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `config: token endpoint answered ${response.status}: ${await response.text()}`,
      );
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('config: token endpoint returned no access_token');
    cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
    };
    return json.access_token;
  };

  return {
    async get() {
      if (cached && cached.expiresAt - leeway > Date.now()) return cached.token;
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * A token from authkit. Uses `authkitTenantToken()` from `@adonis-agora/authkit-client` when it is
 * installed, and otherwise the same client-credentials flow through discovery — so an app works
 * before that helper ships, and keeps working after.
 */
export async function authkitTokenSource(options: AuthkitTokenOptions): Promise<TenantToken> {
  try {
    const authkit = (await import('@adonis-agora/authkit-client')) as unknown as {
      authkitTenantToken?: (input: {
        issuer: string;
        clientId: string;
        clientSecret: string;
        resource?: string;
        scope?: string | string[];
      }) => unknown;
    };
    if (typeof authkit.authkitTenantToken === 'function') {
      const produced = await authkit.authkitTenantToken({
        issuer: options.issuer,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        resource: options.resource ?? CONFIG_RESOURCE,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
      });
      return resolveTokenSource(produced as TenantTokenSource);
    }
  } catch {
    // Not installed, an older version without the helper, or it failed: use discovery below.
  }
  return clientCredentials(options);
}

/** A lazily-resolved authkit token source: nothing is imported or fetched until the first `get()`. */
export function authkitToken(options: AuthkitTokenOptions): TenantToken {
  let resolved: Promise<TenantToken> | undefined;
  const load = () => (resolved ??= authkitTokenSource(options));
  return {
    get: async () => (await load()).get(),
    invalidate: () => {
      void load().then((token) => token.invalidate?.());
    },
  };
}

export const tokens = {
  /** A fixed token (a shared secret). */
  static(token: string): TenantToken {
    if (!token) throw new Error('config: the token is empty');
    return { get: async () => token };
  },
  /** OAuth 2.0 client credentials with discovery. */
  clientCredentials,
  /** Authkit (preferred) or the same client-credentials flow when authkit-client is not installed. */
  authkit: authkitToken,
};
