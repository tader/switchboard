import type { AccountInfo, AuthMethod, Connection, Field, PluginContext } from '../../server/plugins/api.ts';

type Cfg = Record<string, any>;

interface Options {
  id?: string;
  name?: string;
  description?: string;
  unavailable?: string;
  /** Extra fields asked besides the secret(s). */
  fields?: Field[];
  /** Label and help for the secret field. */
  secretLabel?: string;
  secretDescription?: string;
  /** Validates the credentials and tells who they belong to. Throw to reject them. */
  identify?(credentials: Record<string, string>, config: Cfg): Promise<AccountInfo | undefined> | AccountInfo | undefined;
}

/** Splits the secret fields off into credentials, so they are never shown back as config. */
function method(o: Options, defaults: { id: string; name: string }, secrets: Field[], apply: AuthMethod['authorize'], token?: (creds: any) => string): AuthMethod {
  const secretKeys = secrets.map((f) => f.key);
  return {
    id: o.id ?? defaults.id,
    name: o.name ?? defaults.name,
    description: o.description,
    unavailable: o.unavailable,
    fields: [...secrets, ...(o.fields ?? [])],
    async connect({ config }) {
      const credentials: Record<string, string> = {};
      const rest: Cfg = {};
      for (const [k, v] of Object.entries(config)) (secretKeys.includes(k) ? credentials : rest)[k] = v;
      const account = (await o.identify?.(credentials, rest)) ?? { label: rest.label || (rest.baseUrl ? new URL(rest.baseUrl).host : defaults.name) };
      return { credentials, account, config: rest };
    },
    authorize: apply,
    token: token && (async (conn: Connection) => ({ accessToken: token(conn.credentials), tokenType: 'Bearer' })),
  };
}

export function bearerToken(o: Options = {}): AuthMethod {
  return method(
    o,
    { id: 'token', name: 'Access token' },
    [{ key: 'token', label: o.secretLabel ?? 'Token', type: 'secret', required: true, description: o.secretDescription }],
    (req, conn) => void req.headers.set('authorization', `Bearer ${conn.credentials.token}`),
    (c) => c.token,
  );
}

export function headerKey(o: Options & { header?: string; prefix?: string } = {}): AuthMethod {
  const fixed = o.header;
  const m = method(o, { id: 'header', name: 'API key (header)' }, [{ key: 'key', label: o.secretLabel ?? 'API key', type: 'secret', required: true, description: o.secretDescription }], (req, conn) => {
    req.headers.set(fixed ?? conn.config.header, `${o.prefix ?? ''}${conn.credentials.key}`);
  });
  return fixed ? m : withExtraFields(m, [{ key: 'header', label: 'Header name', required: true, default: 'X-API-Key' }]);
}

export function queryKey(o: Options & { param?: string } = {}): AuthMethod {
  const fixed = o.param;
  const m = method(o, { id: 'query', name: 'API key (query parameter)' }, [{ key: 'key', label: o.secretLabel ?? 'API key', type: 'secret', required: true, description: o.secretDescription }], (req, conn) => {
    req.url.searchParams.set(fixed ?? conn.config.param, conn.credentials.key);
  });
  return fixed ? m : withExtraFields(m, [{ key: 'param', label: 'Parameter name', required: true, default: 'api_key' }]);
}

export function basicAuth(o: Options & { usernameLabel?: string; usernameDescription?: string } = {}): AuthMethod {
  return method(
    o,
    { id: 'basic', name: 'Username and password' },
    [
      { key: 'username', label: o.usernameLabel ?? 'Username', required: true, description: o.usernameDescription },
      { key: 'password', label: o.secretLabel ?? 'Password', type: 'secret', required: true, description: o.secretDescription },
    ],
    (req, conn) => {
      const { username, password } = conn.credentials;
      req.headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    },
  );
}

/** Inserts non-secret fields right after the secret ones. */
function withExtraFields(m: AuthMethod, extra: Field[]): AuthMethod {
  const fields = m.fields ?? [];
  return { ...m, fields: [fields[0], ...extra, ...fields.slice(1)] };
}

// --- the generic "HTTP API" service ---

const common: Field[] = [
  { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://api.example.com' },
  { key: 'label', label: 'Account label', description: 'Shown in the hub to tell accounts apart' },
  { key: 'allowedHosts', label: 'Other allowed hosts', advanced: true, placeholder: 'api2.example.com, *.example.com', description: 'Hosts besides the base URL that may receive the credentials' },
  { key: 'openapi', label: 'OpenAPI URL', type: 'url', advanced: true },
];

export default function setup(_ctx: PluginContext) {
  return {
    services: [
      {
        id: 'http',
        name: 'HTTP API',
        description: 'Any API with a token, API key or password',
        icon: 'icon.svg',
        baseUrl: (conn: Connection) => conn.config.baseUrl,
        allowedHosts: (conn: Connection) => [new URL(conn.config.baseUrl).host, ...String(conn.config.allowedHosts ?? '').split(/[\s,]+/).filter(Boolean)],
        openapi: (conn: Connection) => conn.config.openapi || undefined,
        authMethods: [
          bearerToken({ name: 'Bearer token', fields: common }),
          headerKey({ fields: common }),
          queryKey({ fields: common }),
          basicAuth({ fields: common }),
        ],
      },
    ],
    exports: { bearerToken, headerKey, queryKey, basicAuth },
  };
}
