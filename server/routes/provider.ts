// Switchboard as an OAuth 2.1 authorization server, so other Switchboards and MCP clients can get a Switchboard token
// by sending the user here. PKCE (S256) is required. Clients identify themselves in one of three ways:
//  - Client ID Metadata Document: client_id is an https URL (with a path) of a JSON document that
//    lists the client's redirect URIs. Preferred by the MCP specification.
//  - Dynamic Client Registration (RFC 7591) at /oauth/register, for clients that do not support the above.
//  - A plain URL client id whose redirect URI is on the same origin (IndieAuth style), used by Switchboards.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Hono } from 'hono';
import { type Env, requireFullAccess, requireUser } from '../auth.ts';
import { config } from '../config.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { now, one, run } from '../db.ts';
import { badRequest } from '../http.ts';
import { listConnections } from '../connections.ts';
import { createToken, deleteToken, getUser } from '../users.ts';

export const MCP_RESOURCE = `${config.publicUrl}/mcp`;
const DCR_PREFIX = 'swbc_';
/** Registered client ids from before the rename to Switchboard. */
const isRegisteredClient = (id: string) => id.startsWith(DCR_PREFIX) || id.startsWith('hubc_');

interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  scope?: string;
}

interface Client {
  kind: 'metadata' | 'registered' | 'origin' | 'local';
  name: string;
  /** Whether `name` was checked: true for origin clients (it is their host), false for self-asserted names. */
  verifiedName: boolean;
  /** Host vouching for the client: the metadata document's host, or the client's own. */
  domain?: string;
}

const isLoopback = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

/** Exact match, except that loopback redirect URIs may use any port (RFC 8252 section 7.3). */
function redirectAllowed(requested: string, allowed: string[]) {
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  return allowed.some((a) => {
    if (a === requested) return true;
    try {
      const u = new URL(a);
      return isLoopback(u) && isLoopback(r) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

// Fetching a client's metadata document must not become a way to probe Switchboard's network.
// With a plain-http public URL (local development) these checks are relaxed.
const devMode = !config.secure;

function privateAddress(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

const metadataCache = new Map<string, { at: number; doc: any }>();

async function fetchClientMetadata(clientId: string): Promise<{ client_name?: string; redirect_uris: string[] }> {
  const hit = metadataCache.get(clientId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.doc;
  const url = new URL(clientId);
  if (!devMode) {
    const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addresses.length) throw badRequest(`Could not resolve ${url.hostname}`);
    if (addresses.some((a) => privateAddress(a.address))) throw badRequest('The client metadata document is on a private network address');
  }
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch (e: any) {
    throw badRequest(`Could not fetch the client metadata document: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw badRequest(`The client metadata document responded ${res.status}`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw badRequest('The client metadata document is too large');
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw badRequest('The client metadata document is not valid JSON');
  }
  if (doc?.client_id !== clientId) throw badRequest('The client metadata document has a different client_id');
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) throw badRequest('The client metadata document lists no redirect_uris');
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') throw badRequest('Only public clients (token_endpoint_auth_method "none") are supported');
  metadataCache.set(clientId, { at: Date.now(), doc });
  return doc;
}

async function resolveClient(clientId: string, redirectUri: string): Promise<Client> {
  if (isRegisteredClient(clientId)) {
    const row = one('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
    if (!row) throw badRequest('Unknown client_id');
    if (!redirectAllowed(redirectUri, JSON.parse(row.redirect_uris))) throw badRequest('redirect_uri is not registered for this client');
    return { kind: 'registered', name: row.client_name, verifiedName: false };
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw badRequest('redirect_uri must be a URL');
  }
  let client: URL;
  try {
    client = new URL(clientId);
  } catch {
    // Some native clients use a fixed, unregistered id. That is only safe when the code goes to
    // this computer (a loopback redirect), where no remote attacker can receive it.
    if (!isLoopback(redirect)) throw badRequest('Unknown client_id; register the client or use a URL client_id');
    if (!/^[\w.@:-]{1,100}$/.test(clientId)) throw badRequest('Invalid client_id');
    return { kind: 'local', name: clientId, verifiedName: false };
  }
  if (!/^https?:$/.test(client.protocol)) throw badRequest('client_id must be an http(s) URL');
  if (client.pathname !== '/' && (client.protocol === 'https:' || devMode)) {
    const doc = await fetchClientMetadata(clientId);
    if (!redirectAllowed(redirectUri, doc.redirect_uris)) throw badRequest('redirect_uri is not listed in the client metadata document');
    return { kind: 'metadata', name: String(doc.client_name || client.host).slice(0, 100), verifiedName: false, domain: client.host };
  }
  if (redirect.origin !== client.origin) throw badRequest(`redirect_uri must be on ${client.origin}`);
  return { kind: 'origin', name: client.host, verifiedName: true, domain: client.host };
}

/** Normalizes a resource indicator (RFC 8707); only Switchboard itself and its MCP endpoint are known resources. */
function audienceFor(resource?: string): string | null | undefined {
  if (!resource) return null;
  const r = resource.replace(/\/+$/, '').replace(/^(https?:\/\/)([^/]+)/i, (_m, s, h) => s.toLowerCase() + h.toLowerCase());
  if (r === MCP_RESOURCE) return 'mcp';
  if (r === config.publicUrl) return null;
  return undefined;
}

async function validate(p: AuthorizeParams) {
  if (p.response_type !== 'code') throw badRequest('Unsupported response_type; use "code"');
  if (!p.client_id || !p.redirect_uri) throw badRequest('client_id and redirect_uri are required');
  const client = await resolveClient(p.client_id, p.redirect_uri);
  if (!p.code_challenge || p.code_challenge_method !== 'S256') throw badRequest('PKCE with S256 is required');
  if (audienceFor(p.resource) === undefined) throw badRequest(`Unknown resource ${p.resource}`);
  const redirect = new URL(p.redirect_uri);
  return { client, redirect };
}

/** Pages and API for the signed-in user. */
export const authorizeApi = new Hono<Env>();
authorizeApi.use('*', requireUser, requireFullAccess);

authorizeApi.get('/', async (c) => {
  const p = c.req.query() as AuthorizeParams;
  const { client, redirect } = await validate(p);
  return c.json({
    client: client.name,
    verifiedName: client.verifiedName,
    domain: client.domain ?? null,
    redirectHost: isLoopback(redirect) ? 'an app on your computer' : redirect.host,
    forMcp: audienceFor(p.resource) === 'mcp',
    secure: redirect.protocol === 'https:' || isLoopback(redirect),
  });
});

authorizeApi.post('/', async (c) => {
  const b = await c.req.json<AuthorizeParams & { approve: boolean; connectionIds?: string[] | null }>();
  const { client, redirect } = await validate(b);
  if (b.state) redirect.searchParams.set('state', b.state);
  // RFC 9207: lets the client check which authorization server answered.
  redirect.searchParams.set('iss', config.publicUrl);
  if (!b.approve) {
    redirect.searchParams.set('error', 'access_denied');
    return c.json({ redirect: redirect.toString() });
  }
  const user = c.get('user');
  let ids: string[] | null = null;
  if (b.connectionIds) {
    const own = new Set(listConnections(user.id).map((x) => x.id));
    ids = b.connectionIds.filter((id) => own.has(id));
    if (!ids.length) throw badRequest('Choose at least one connection');
  }
  const code = randomToken();
  run('DELETE FROM oauth_codes WHERE expires_at < ?', now());
  run(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, token_name, connection_ids, expires_at, resource, client_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(code), user.id, b.client_id!, b.redirect_uri!, b.code_challenge!, client.name, ids ? JSON.stringify(ids) : null, now() + 5 * 60_000, b.resource ?? null,
    client.kind === 'origin' ? null : client.name,
  );
  if (client.kind === 'registered') run('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?', now(), b.client_id);
  redirect.searchParams.set('code', code);
  return c.json({ redirect: redirect.toString() });
});

/** Token endpoint, called by the client. */
export const tokenEndpoint = new Hono<Env>();

tokenEndpoint.post('/', async (c) => {
  const type = c.req.header('content-type') ?? '';
  const p: Record<string, string> = type.includes('json') ? await c.req.json() : Object.fromEntries(new URLSearchParams(await c.req.text()));
  const fail = (error: string, description: string) => c.json({ error, error_description: description }, 400);
  c.header('cache-control', 'no-store');
  if (p.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 'Only authorization_code is supported');
  const row = p.code ? one('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(p.code)) : undefined;
  if (row) run('DELETE FROM oauth_codes WHERE code_hash = ?', row.code_hash);
  if (!row || row.expires_at < now()) return fail('invalid_grant', 'The code is invalid or expired');
  if (row.client_id !== p.client_id || row.redirect_uri !== p.redirect_uri) return fail('invalid_grant', 'client_id or redirect_uri does not match');
  const challenge = crypto.createHash('sha256').update(p.code_verifier ?? '').digest('base64url');
  if (!p.code_verifier || challenge !== row.code_challenge) return fail('invalid_grant', 'code_verifier does not match');
  // RFC 8707: the token request names the same resource as the authorization request.
  const resource = p.resource ?? row.resource ?? undefined;
  if (row.resource && p.resource && audienceFor(p.resource) !== audienceFor(row.resource)) return fail('invalid_target', 'resource does not match the authorization request');
  const audience = audienceFor(resource);
  if (audience === undefined) return fail('invalid_target', `Unknown resource ${resource}`);
  const user = getUser(row.user_id);
  if (!user || user.disabled) return fail('invalid_grant', 'The user is not active');
  const name = audience === 'mcp' ? `${row.token_name} (MCP)` : row.token_name;
  const { token, secret } = createToken(user.id, name, row.connection_ids ? JSON.parse(row.connection_ids) : null, null, { audience, clientName: row.client_name });
  return c.json({ access_token: secret, token_type: 'bearer', token_id: token.id, scope: row.connection_ids ? 'connections' : 'full' });
});

// --- Dynamic Client Registration (RFC 7591) ---

const registrations = new Map<string, number[]>();

export const registerEndpoint = new Hono<Env>();

registerEndpoint.post('/', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
  const recent = (registrations.get(ip) ?? []).filter((t) => t > Date.now() - 3600_000);
  if (recent.length >= 20) return c.json({ error: 'invalid_client_metadata', error_description: 'Too many registrations; try again later' }, 429);
  const b = await c.req.json<{ redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string; grant_types?: string[] }>().catch(() => ({}) as any);
  const err = (description: string) => c.json({ error: 'invalid_client_metadata', error_description: description }, 400);
  if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 10) return err('redirect_uris is required');
  for (const u of b.redirect_uris) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return c.json({ error: 'invalid_redirect_uri', error_description: `${u} is not a URL` }, 400);
    }
    // Native apps may use custom schemes; plain http only for loopback.
    if (url.protocol === 'http:' && !isLoopback(url) && !devMode) return c.json({ error: 'invalid_redirect_uri', error_description: 'http redirect URIs must be loopback' }, 400);
    if (url.hash) return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect URIs cannot have a fragment' }, 400);
  }
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') return err('Only public clients (token_endpoint_auth_method "none") are supported');
  const clientId = `${DCR_PREFIX}${randomToken(16)}`;
  const name = String(b.client_name || 'Unnamed app').slice(0, 100);
  run('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)', clientId, name, JSON.stringify(b.redirect_uris), now());
  registrations.set(ip, [...recent, Date.now()]);
  // Registrations that were never used are removed after a day.
  run('DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ?', now() - 86400_000);
  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: b.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    201,
  );
});

// --- discovery ---

export function authorizationServerMetadata() {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728: tells MCP clients where to get a token for the MCP endpoint. */
export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'Switchboard',
    resource_documentation: `${config.publicUrl}/tokens`,
  };
}

/** Lets any token revoke itself, e.g. when the client disconnects. */
export const selfRevoke = new Hono<Env>();
selfRevoke.delete('/', requireUser, (c) => {
  const t = c.get('token');
  if (!t) throw badRequest('Only API tokens can be revoked this way');
  deleteToken(c.get('user').id, t.id);
  return c.json({ ok: true });
});

