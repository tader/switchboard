import type { AccountInfo, AuthMethod, Connection, Field, OutgoingRequest, PluginContext } from '../../server/plugins/api.ts';

type Cfg = Record<string, any>;
type Value<T> = T | ((config: Cfg) => T);

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  idToken?: string;
}

export interface OAuthOptions {
  id?: string;
  name?: string;
  description?: string;
  unavailable?: string;
  fields?: Field[];
  clientId: Value<string | undefined>;
  clientSecret?: Value<string | undefined>;
  tokenUrl: Value<string>;
  scopes?: Value<string[]>;
  scopeSeparator?: string;
  /** How the client authenticates at the token endpoint. Default: "post". */
  tokenAuth?: Value<'post' | 'basic' | undefined>;
  extraTokenHeaders?: Record<string, string>;
  /** Looks up who signed in. */
  identify?(credentials: OAuthCredentials, config: Cfg, raw: any): Promise<AccountInfo | undefined> | AccountInfo | undefined;
  revoke?(credentials: OAuthCredentials, config: Cfg): Promise<void>;
}

export interface AuthorizationCodeOptions extends OAuthOptions {
  authorizeUrl: Value<string>;
  authorizeParams?: Value<Record<string, string>>;
  /** Default: true. */
  pkce?: Value<boolean>;
}

export interface DeviceCodeOptions extends OAuthOptions {
  deviceAuthorizationUrl: Value<string>;
}

const val = <T>(v: Value<T> | undefined, cfg: Cfg): T | undefined => (typeof v === 'function' ? (v as (c: Cfg) => T)(cfg) : v);

function scopeString(o: OAuthOptions, cfg: Cfg) {
  const s = val(o.scopes, cfg) ?? [];
  return s.filter(Boolean).join(o.scopeSeparator ?? ' ');
}

function b64url(buf: ArrayBuffer | Uint8Array) {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64url');
}

export class OAuthError extends Error {
  code: string;
  constructor(code: string, description?: string) {
    super(description ? `${description} (${code})` : code);
    this.code = code;
  }
}

/** POSTs to a token endpoint and returns the parsed response. Throws OAuthError on an error response. */
export async function tokenRequest(o: OAuthOptions, cfg: Cfg, params: Record<string, string>): Promise<any> {
  const clientId = val(o.clientId, cfg);
  const clientSecret = val(o.clientSecret, cfg);
  if (!clientId) throw new Error('No OAuth client id is configured');
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...o.extraTokenHeaders };
  if (val(o.tokenAuth, cfg) === 'basic' && clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
  }
  const res = await fetch(val(o.tokenUrl, cfg)!, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }
  if (data.error) throw new OAuthError(data.error, data.error_description);
  if (!res.ok) throw new Error(`Token endpoint responded ${res.status}: ${text.slice(0, 200)}`);
  if (!data.access_token) throw new Error('The token endpoint did not return an access token');
  return data;
}

export function toCredentials(data: any, previous?: OAuthCredentials): OAuthCredentials {
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    tokenType: data.token_type,
    scope: data.scope ?? previous?.scope,
    idToken: data.id_token ?? previous?.idToken,
  };
}

/**
 * Returns credentials that are valid for at least another minute, refreshing when needed.
 * `refreshed` is true when the caller should persist them.
 */
export async function freshCredentials(
  o: OAuthOptions,
  conn: Connection,
  force = false,
  renew?: () => Promise<OAuthCredentials>,
): Promise<{ credentials: OAuthCredentials; refreshed: boolean }> {
  const c = conn.credentials as OAuthCredentials;
  const expiring = c.expiresAt !== undefined && c.expiresAt - 60_000 < Date.now();
  if (!force && !expiring) return { credentials: c, refreshed: false };
  if (c.refreshToken) {
    const data = await tokenRequest(o, conn.config, { grant_type: 'refresh_token', refresh_token: c.refreshToken });
    return { credentials: toCredentials(data, c), refreshed: true };
  }
  if (renew) return { credentials: await renew(), refreshed: true };
  if (expiring) throw new Error('The access token expired and there is no refresh token; reconnect the account');
  return { credentials: c, refreshed: false };
}

function bearerMethodParts(o: OAuthOptions, renew?: (conn: Connection) => () => Promise<OAuthCredentials>) {
  return {
    async authorize(req: OutgoingRequest, conn: Connection, opts: { force?: boolean }) {
      const { credentials, refreshed } = await freshCredentials(o, conn, opts.force, renew?.(conn));
      req.headers.set('authorization', `Bearer ${credentials.accessToken}`);
      return refreshed ? { credentials } : undefined;
    },
    async token(conn: Connection, opts: { force?: boolean }) {
      const { credentials, refreshed } = await freshCredentials(o, conn, opts.force, renew?.(conn));
      return { accessToken: credentials.accessToken, tokenType: 'Bearer', expiresAt: credentials.expiresAt, credentials: refreshed ? credentials : undefined };
    },
    async revoke(conn: Connection) {
      await o.revoke?.(conn.credentials, conn.config);
    },
  };
}

async function connected(o: OAuthOptions, cfg: Cfg, data: any) {
  const credentials = toCredentials(data);
  const account = (await o.identify?.(credentials, cfg, data)) ?? undefined;
  return { credentials, account };
}

/** The browser-based authorization code flow, with PKCE. */
export function authorizationCode(o: AuthorizationCodeOptions): AuthMethod {
  return {
    id: o.id ?? 'oauth',
    name: o.name ?? 'Sign in',
    description: o.description,
    unavailable: o.unavailable,
    fields: o.fields,
    async connect({ config, callbackUrl, state }) {
      const clientId = val(o.clientId, config);
      if (!clientId) throw new Error('No OAuth client id is configured');
      const url = new URL(val(o.authorizeUrl, config)!);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('state', state);
      const scope = scopeString(o, config);
      if (scope) url.searchParams.set('scope', scope);
      let verifier: string | undefined;
      if (val(o.pkce, config) !== false) {
        verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
        url.searchParams.set('code_challenge', b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      for (const [k, v] of Object.entries(val(o.authorizeParams, config) ?? {})) url.searchParams.set(k, v);
      return { redirect: url.toString(), pending: { verifier } };
    },
    async callback({ config, callbackUrl, pending, params }) {
      if (!params.code) throw new Error('The provider did not return an authorization code');
      const extra: Record<string, string> = pending?.verifier ? { code_verifier: pending.verifier } : {};
      const data = await tokenRequest(o, config, { grant_type: 'authorization_code', code: params.code, redirect_uri: callbackUrl, ...extra });
      return connected(o, config, data);
    },
    ...bearerMethodParts(o),
  };
}

/** RFC 8628 device authorization: the user enters a code on another device. */
export function deviceCode(o: DeviceCodeOptions): AuthMethod {
  return {
    id: o.id ?? 'device',
    name: o.name ?? 'Sign in with a code',
    description: o.description,
    unavailable: o.unavailable,
    fields: o.fields,
    async connect({ config }) {
      const clientId = val(o.clientId, config);
      if (!clientId) throw new Error('No OAuth client id is configured');
      const body = new URLSearchParams({ client_id: clientId });
      const scope = scopeString(o, config);
      if (scope) body.set('scope', scope);
      const res = await fetch(val(o.deviceAuthorizationUrl, config)!, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = Object.fromEntries(new URLSearchParams(text));
      }
      if (data.error) throw new OAuthError(data.error, data.error_description);
      if (!res.ok || !data.device_code) throw new Error(`Device authorization failed (${res.status})`);
      return {
        device: {
          userCode: data.user_code,
          verificationUri: data.verification_uri ?? data.verification_url,
          verificationUriComplete: data.verification_uri_complete,
          expiresIn: Number(data.expires_in) || 900,
          interval: Number(data.interval) || 5,
        },
        pending: { deviceCode: data.device_code },
      };
    },
    async poll({ config, pending }) {
      try {
        const data = await tokenRequest(o, config, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.deviceCode });
        return connected(o, config, data);
      } catch (e) {
        if (e instanceof OAuthError && e.code === 'authorization_pending') return { wait: true };
        if (e instanceof OAuthError && e.code === 'slow_down') return { wait: true, interval: 10 };
        if (e instanceof OAuthError && e.code === 'expired_token') throw new Error('The code expired. Please start again.');
        if (e instanceof OAuthError && e.code === 'access_denied') throw new Error('Access was denied');
        throw e;
      }
    },
    ...bearerMethodParts(o),
  };
}

/** Machine-to-machine: tokens are requested with the client's own credentials. */
export function clientCredentials(o: OAuthOptions & { label?: Value<string | undefined> }): AuthMethod {
  const request = async (cfg: Cfg) => {
    const scope = scopeString(o, cfg);
    return toCredentials(await tokenRequest(o, cfg, { grant_type: 'client_credentials', ...(scope ? { scope } : {}) }));
  };
  return {
    id: o.id ?? 'client-credentials',
    name: o.name ?? 'Client credentials',
    description: o.description,
    unavailable: o.unavailable,
    fields: o.fields,
    async connect({ config }) {
      const credentials = await request(config);
      const account = (await o.identify?.(credentials, config, null)) ?? { label: val(o.label, config) ?? String(val(o.clientId, config)) };
      return { credentials, account };
    },
    ...bearerMethodParts(o, (conn) => () => request(conn.config)),
  };
}

// --- the generic "OAuth 2.0" service ---

const common: Field[] = [
  { key: 'baseUrl', label: 'API base URL', type: 'url', required: true, placeholder: 'https://api.example.com' },
  { key: 'tokenUrl', label: 'Token URL', type: 'url', required: true },
  { key: 'clientId', label: 'Client ID', required: true },
  { key: 'clientSecret', label: 'Client secret', type: 'secret' },
  { key: 'scopes', label: 'Scopes', placeholder: 'Separated by spaces' },
  { key: 'label', label: 'Account label', description: 'Shown in Switchboard to tell accounts apart' },
  { key: 'allowedHosts', label: 'Other allowed hosts', advanced: true, placeholder: 'api2.example.com, *.example.com', description: 'Hosts besides the base URL that may receive the token' },
  { key: 'openapi', label: 'OpenAPI URL', type: 'url', advanced: true },
  { key: 'tokenAuth', label: 'Client authentication', type: 'select', advanced: true, default: 'post', options: [{ value: 'post', label: 'In the request body' }, { value: 'basic', label: 'HTTP Basic' }] },
];

const fromConfig: OAuthOptions = {
  clientId: (c) => c.clientId,
  clientSecret: (c) => c.clientSecret,
  tokenUrl: (c) => c.tokenUrl,
  scopes: (c) => String(c.scopes ?? '').split(/[\s,]+/).filter(Boolean),
  tokenAuth: (c) => c.tokenAuth,
  identify: (_creds, c) => ({ label: c.label || new URL(c.baseUrl).host }),
};

export default function setup(_ctx: PluginContext) {
  const generic = {
    id: 'oauth2',
    name: 'OAuth 2.0 API',
    description: 'Any API that uses OAuth 2.0',
    icon: 'icon.svg',
    baseUrl: (conn: Connection) => conn.config.baseUrl,
    allowedHosts: (conn: Connection) => [
      new URL(conn.config.baseUrl).host,
      ...String(conn.config.allowedHosts ?? '').split(/[\s,]+/).filter(Boolean),
    ],
    openapi: (conn: Connection) => conn.config.openapi || undefined,
    authMethods: [
      authorizationCode({
        ...fromConfig,
        name: 'Authorization code',
        description: 'Sign in through the browser',
        authorizeUrl: (c) => c.authorizeUrl,
        pkce: (c) => c.pkce !== false,
        fields: [
          { key: 'authorizeUrl', label: 'Authorization URL', type: 'url', required: true },
          ...common,
          { key: 'pkce', label: 'Use PKCE', type: 'boolean', default: true, advanced: true },
        ],
      }),
      deviceCode({
        ...fromConfig,
        name: 'Device code',
        description: 'Enter a code on the provider’s website',
        deviceAuthorizationUrl: (c) => c.deviceAuthorizationUrl,
        fields: [{ key: 'deviceAuthorizationUrl', label: 'Device authorization URL', type: 'url', required: true }, ...common],
      }),
      clientCredentials({
        ...fromConfig,
        name: 'Client credentials',
        description: 'For service accounts, no user sign-in',
        fields: common,
      }),
    ],
  };
  return {
    services: [generic],
    exports: { authorizationCode, deviceCode, clientCredentials, tokenRequest, toCredentials, freshCredentials, OAuthError },
  };
}
