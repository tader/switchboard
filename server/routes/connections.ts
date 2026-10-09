import { Hono, type Context } from 'hono';
import { type Env, assertConnectionAccess, identify, requireFullAccess, requireUser } from '../auth.ts';
import { config } from '../config.ts';
import {
  cancelFlow, completeFromPaste, completeRedirect, deleteConnection, getConnectionRow, listConnections, listServices, loadConnection, pollDevice, renameConnection, startConnect,
} from '../connections.ts';
import { randomId } from '../crypto.ts';
import { all, now, one, run } from '../db.ts';
import { HttpError, badRequest, notFound } from '../http.ts';
import { describe } from '../openapi.ts';
import { type CallInput, envelope, execute, issueToken, passThrough } from '../proxy.ts';
import { auditFacets, auditHistogram, callerFrom, getAudit, queryAudit } from '../audit.ts';
import { getDoc, guidesByService, listDocs } from '../docs.ts';
import { listPeers, requestPeer } from '../peers.ts';
import { connectionShares, setConnectionShares, setConnectionPeerShare, sharingMatrix } from '../peer-settings.ts';
import { mcpClientMetadata } from '../mcp-auth.ts';
import { executeMcp, validateMcpInput, type McpInput, type McpOperation } from '../provider-mcp.ts';

export const api = new Hono<Env>();
api.use('*', requireUser);

api.get('/services', (c) => {
  const guides = guidesByService();
  return c.json(listServices(c.get('user').id).map((s) => ({ ...s, guides: guides.get(s.id) ?? [] })));
});

api.get('/docs', (c) => c.json(listDocs(c.get('user').role === 'admin')));
api.get('/docs/*', (c) => c.json(getDoc(decodeURIComponent(c.req.path.replace(/^\/api\/docs\//, '')), c.get('user').role === 'admin')));

api.get('/peers', requireFullAccess, (c) => c.json(listPeers().map(({ id, name, url, disabled, state, direction, remoteInstanceId }) => ({ id, name, url, disabled, state, direction, remoteInstanceId }))));
api.get('/connection-shares', requireFullAccess, c => c.json(sharingMatrix(c.get('user').id)));
api.put('/connections/:ref/shares/:peerId', requireFullAccess, async c => c.json(setConnectionPeerShare(c.get('user').id, c.req.param('ref'), c.req.param('peerId'), (await c.req.json()).shared)));
api.get('/connections/:ref/shares', requireFullAccess, (c) => c.json(connectionShares(c.get('user').id, c.req.param('ref'))));
api.put('/connections/:ref/shares', requireFullAccess, async (c) => c.json(setConnectionShares(c.get('user').id, c.req.param('ref'), await c.req.json())));

api.get('/connections', (c) => c.json(listConnections(c.get('user').id, c.get('token')?.connectionIds)));

api.get('/connections/:ref', (c) => {
  const row = getConnectionRow(c.get('user').id, c.req.param('ref'));
  assertConnectionAccess(c, row.id);
  return c.json(listConnections(c.get('user').id, [row.id])[0]);
});

// POST keeps argument values out of query strings and requires same-origin cookie requests.
api.post('/connections/:ref/mcp/tools/get', async c => {
  const row = getConnectionRow(c.get('user').id, c.req.param('ref'));
  assertConnectionAccess(c, row.id);
  const { name } = await c.req.json();
  if (typeof name !== 'string' || !name) throw badRequest('MCP tool name is required');
  const result = await executeMcp(c.get('user'), row.id, { operation: 'tools/list' }, c.req.raw.signal, callerFrom(c, 'call'));
  const tool = result.tools.find((t: any) => t.name === name);
  if (!tool) throw notFound('MCP tool not found');
  return c.json(tool);
});
for (const operation of ['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete'] as McpOperation[]) {
  api.post(`/connections/:ref/mcp/${operation}`, async (c) => {
    const row = getConnectionRow(c.get('user').id, c.req.param('ref')!);
    assertConnectionAccess(c, row.id);
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('MCP input must be an object');
    return c.json(await executeMcp(c.get('user'), row.id, { ...body, operation } as McpInput, c.req.raw.signal, callerFrom(c, 'call')));
  });
}

api.post('/connections', requireFullAccess, async (c) => {
  const body = await c.req.json();
  return c.json(await startConnect(c.get('user'), body));
});

api.post('/connections/:ref/reconnect', requireFullAccess, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await startConnect(c.get('user'), { ...body, connection: c.req.param('ref') }));
});

api.patch('/connections/:ref', requireFullAccess, async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  return c.json(renameConnection(c.get('user').id, c.req.param('ref'), name ?? ''));
});

api.delete('/connections/:ref', requireFullAccess, async (c) => {
  await deleteConnection(c.get('user').id, c.req.param('ref'));
  return c.json({ ok: true });
});

const tokenHandler = async (c: Context<Env>) => {
  const row = getConnectionRow(c.get('user').id, c.req.param('ref')!);
  assertConnectionAccess(c, row.id);
  return c.json(await issueToken(c.get('user'), row.id, c.req.query('force') === '1', callerFrom(c, 'token')));
};
api.get('/connections/:ref/token', tokenHandler);
api.post('/connections/:ref/token', tokenHandler);

api.get('/connections/:ref/openapi', async (c) => {
  const row = getConnectionRow(c.get('user').id, c.req.param('ref'));
  assertConnectionAccess(c, row.id);
  if (row.peer_id) {
    const d = await requestPeer(row.peer_id, c.get('user').id, 'openapi', { connection: row.remote_connection_id, refresh: c.req.query('refresh') === '1' });
    if (!d) throw notFound('This service has no API description');
    return c.json(d);
  }
  const { conn, service } = loadConnection(c.get('user').id, row.id);
  const d = await describe(service, conn, c.req.query('refresh') === '1');
  if (!d) throw notFound(`${service.name} has no API description`);
  return c.json(d);
});

api.post('/connect/:flow/complete', requireFullAccess, async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  return c.json({ status: 'connected', connection: await completeFromPaste(c.req.param('flow'), url, c.get('user')) });
});
api.post('/connect/:flow/poll', requireFullAccess, async (c) => c.json(await pollDevice(c.req.param('flow'), c.get('user'))));
api.delete('/connect/:flow', requireFullAccess, (c) => {
  cancelFlow(c.req.param('flow'), c.get('user'));
  return c.json({ ok: true });
});

// --- calls ---

type Pair = { key: string; value: string; enabled?: boolean };

function pairs(v: unknown): [string, string][] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((p: any) => (Array.isArray(p) ? { key: p[0], value: p[1] } : p) as Pair)
      .filter((p) => p && p.key && p.enabled !== false)
      .map((p) => [String(p.key), String(p.value ?? '')]);
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) =>
      Array.isArray(val) ? val.map((x) => [k, String(x)] as [string, string]) : [[k, String(val ?? '')] as [string, string]],
    );
  }
  throw badRequest('query and headers must be arrays or objects');
}

interface CallBody {
  connection: string;
  method?: string;
  url?: string;
  pathParams?: Record<string, string>;
  query?: unknown;
  headers?: unknown;
  body?: unknown;
  bodyEncoding?: 'utf8' | 'base64';
}

function toInput(b: CallBody): CallInput {
  let body: string | Uint8Array | null = null;
  if (b.body !== undefined && b.body !== null && b.body !== '') {
    if (b.bodyEncoding === 'base64') body = Buffer.from(String(b.body), 'base64');
    else body = typeof b.body === 'string' ? b.body : JSON.stringify(b.body);
  }
  const headers = pairs(b.headers);
  if (b.body && typeof b.body === 'object' && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['content-type', 'application/json']);
  return { method: b.method ?? 'GET', url: b.url ?? '', pathParams: b.pathParams, query: pairs(b.query), headers, body };
}

/** Runs a request and returns a JSON envelope with status, headers and body. */
api.post('/call', async (c) => {
  const b = await c.req.json<CallBody>();
  if (!b.connection) throw badRequest('connection is required');
  const row = getConnectionRow(c.get('user').id, b.connection);
  assertConnectionAccess(c, row.id);
  return c.json(await envelope(await execute(c.get('user'), row.id, toInput(b), c.req.raw.signal, callerFrom(c, 'call'))));
});

// --- audit trail ---

// Limited tokens (agents) cannot read the trail: it covers all of the user's connections.
const includePeerActivity = (c: Context<Env>) => c.get('user').role === 'admin';
api.get('/audit', requireFullAccess, (c) => {
  const q = c.req.query();
  const num = (v?: string) => (v ? Number(v) : undefined);
  return c.json(queryAudit(c.get('user').id, { ...q, from: num(q.from), to: num(q.to), limit: num(q.limit), offset: num(q.offset) }, includePeerActivity(c)));
});
api.get('/audit/histogram', requireFullAccess, (c) => {
  const q = c.req.query();
  const num = (v?: string) => (v ? Number(v) : undefined);
  return c.json(auditHistogram(c.get('user').id, { ...q, from: num(q.from), to: num(q.to), tz: num(q.tz), buckets: num(q.buckets) }, includePeerActivity(c)));
});
api.get('/audit/facets', requireFullAccess, (c) => c.json(auditFacets(c.get('user').id, includePeerActivity(c))));
api.get('/audit/:id', requireFullAccess, (c) => c.json(getAudit(c.get('user').id, Number(c.req.param('id')), includePeerActivity(c))));

// --- saved calls ---

const toSaved = (r: any) => ({
  id: r.id,
  kind: r.kind,
  mcpRequest: r.mcp_request ? JSON.parse(r.mcp_request) : null,
  name: r.name,
  connectionId: r.connection_id,
  method: r.method,
  url: r.url,
  pathParams: r.path_params ? JSON.parse(r.path_params) : {},
  query: r.query ? JSON.parse(r.query) : [],
  headers: r.headers ? JSON.parse(r.headers) : [],
  body: r.body ?? '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function savedFields(b: any) {
  const kind = b.kind ?? 'http';
  if (kind !== 'http' && kind !== 'mcp') throw badRequest('Saved request kind must be http or mcp');
  if (kind === 'mcp') {
    validateMcpInput(b.mcpRequest);
    if (!['tools/call', 'resources/read', 'prompts/get'].includes(b.mcpRequest.operation)) throw badRequest('Save a tool call, resource read or prompt request');
  }
  const name = String(b.name ?? '').trim();
  if (!name) throw badRequest('Give the call a name');
  const list = (v: any): Pair[] => (Array.isArray(v) ? v.filter((p) => p && (p.key || p.value)).map((p) => ({ key: String(p.key ?? ''), value: String(p.value ?? ''), enabled: p.enabled !== false })) : []);
  return {
    kind,
    mcpRequest: kind === 'mcp' ? JSON.stringify(b.mcpRequest) : null,
    name,
    method: String(b.method ?? 'GET').toUpperCase(),
    url: String(b.url ?? ''),
    pathParams: JSON.stringify(b.pathParams ?? {}),
    query: JSON.stringify(list(b.query)),
    headers: JSON.stringify(list(b.headers)),
    body: typeof b.body === 'string' ? b.body : b.body == null ? '' : JSON.stringify(b.body, null, 2),
  };
}

function savedConnectionId(c: Context<Env>, ref: unknown, kind?: string): string | null {
  if (!ref) return null;
  const row = getConnectionRow(c.get('user').id, String(ref));
  assertConnectionAccess(c, row.id);
  if (kind && row.kind !== kind) throw badRequest('The saved request and connection must use the same protocol');
  return row.id;
}

api.get('/calls', (c) => {
  const ids = c.get('token')?.connectionIds;
  const rows = all('SELECT * FROM saved_calls WHERE user_id = ? ORDER BY name COLLATE NOCASE', c.get('user').id);
  return c.json(rows.filter((r) => !ids || ids.includes(r.connection_id)).map(toSaved));
});

api.post('/calls', requireFullAccess, async (c) => {
  const b = await c.req.json();
  const f = savedFields(b);
  const id = randomId('s');
  run(
    `INSERT INTO saved_calls (id, user_id, connection_id, name, method, url, path_params, query, headers, body, created_at, updated_at, kind, mcp_request)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, c.get('user').id, savedConnectionId(c, b.connectionId, f.kind), f.name, f.method, f.url, f.pathParams, f.query, f.headers, f.body, now(), now(), f.kind, f.mcpRequest,
  );
  return c.json(toSaved(one('SELECT * FROM saved_calls WHERE id = ?', id)), 201);
});

function getSaved(c: Context<Env>, id: string) {
  const r = one('SELECT * FROM saved_calls WHERE user_id = ? AND (id = ? OR name = ?)', c.get('user').id, id, id);
  if (!r) throw notFound('Saved call not found');
  const ids = c.get('token')?.connectionIds;
  if (ids && !ids.includes(r.connection_id)) throw notFound('Saved call not found');
  return r;
}

api.get('/calls/:id', (c) => c.json(toSaved(getSaved(c, c.req.param('id')))));

api.put('/calls/:id', requireFullAccess, async (c) => {
  const r = getSaved(c, c.req.param('id'));
  const b = await c.req.json();
  const f = savedFields(b);
  run(
    `UPDATE saved_calls SET connection_id = ?, name = ?, method = ?, url = ?, path_params = ?, query = ?, headers = ?, body = ?, updated_at = ?, kind = ?, mcp_request = ? WHERE id = ?`,
    savedConnectionId(c, b.connectionId, f.kind), f.name, f.method, f.url, f.pathParams, f.query, f.headers, f.body, now(), f.kind, f.mcpRequest, r.id,
  );
  return c.json(toSaved(one('SELECT * FROM saved_calls WHERE id = ?', r.id)));
});

api.delete('/calls/:id', requireFullAccess, (c) => {
  run('DELETE FROM saved_calls WHERE id = ? AND user_id = ?', getSaved(c, c.req.param('id')).id, c.get('user').id);
  return c.json({ ok: true });
});

/**
 * Runs a saved call and passes the peer response through as-is.
 * The JSON body may override connection, pathParams, query (merged), headers (merged) and body.
 */
api.post('/calls/:id/run', async (c) => {
  const s = toSaved(getSaved(c, c.req.param('id')));
  const o = await c.req.json().catch(() => ({}));
  const connection = o.connection ?? s.connectionId;
  if (!connection) throw badRequest('This saved call has no connection; pass one as "connection"');
  const row = getConnectionRow(c.get('user').id, connection);
  assertConnectionAccess(c, row.id);
  if (s.kind === 'mcp') {
    if (o.arguments !== undefined && (!o.arguments || typeof o.arguments !== 'object' || Array.isArray(o.arguments))) throw badRequest('MCP arguments must be an object');
    const input = { ...s.mcpRequest, ...(o.arguments === undefined ? {} : { arguments: { ...s.mcpRequest.arguments, ...o.arguments } }), ...(o.uri === undefined ? {} : { uri: o.uri }) };
    return c.json(await executeMcp(c.get('user'), row.id, input, c.req.raw.signal, callerFrom(c, 'saved-call', s.name)));
  }
  const merge = (base: Pair[], extra: unknown) => {
    const m = new Map(pairs(base).map(([k, v]) => [k.toLowerCase(), [k, v] as [string, string]]));
    for (const [k, v] of pairs(extra)) m.set(k.toLowerCase(), [k, v]);
    return [...m.values()].map(([key, value]) => ({ key, value }));
  };
  const input = toInput({
    connection: row.id,
    method: s.method,
    url: s.url,
    pathParams: { ...s.pathParams, ...(o.pathParams ?? {}) },
    query: merge(s.query, o.query),
    headers: merge(s.headers, o.headers),
    body: o.body !== undefined ? o.body : s.body,
    bodyEncoding: o.bodyEncoding,
  });
  const ex = await execute(c.get('user'), row.id, input, c.req.raw.signal, callerFrom(c, 'saved-call', s.name));
  return passThrough(ex);
});

// --- transparent proxy: /proxy/<connection>/<path relative to the base URL, or an absolute URL> ---

export const proxy = new Hono<Env>();

const proxyHandler = async (c: Context<Env>) => {
  const raw = new URL(c.req.url);
  const m = raw.pathname.match(/^\/proxy\/([^/]+)(.*)$/);
  if (!m) throw notFound();
  const row = getConnectionRow(c.get('user').id, decodeURIComponent(m[1]));
  assertConnectionAccess(c, row.id);
  // /proxy/<conn>/https://host/path (some clients collapse "//")
  const abs = m[2].match(/^\/(https?):\/\/?(.*)$/);
  const url = abs ? `${abs[1]}://${abs[2]}` : m[2];
  const query = [...raw.searchParams.entries()];
  const headers: [string, string][] = [];
  c.req.raw.headers.forEach((v, k) => headers.push([k, v]));
  const body = ['GET', 'HEAD'].includes(c.req.method) ? null : new Uint8Array(await c.req.arrayBuffer());
  const ex = await execute(c.get('user'), row.id, { method: c.req.method, url, query, headers, body }, c.req.raw.signal, callerFrom(c, 'proxy'));
  return passThrough(ex);
};
proxy.all('/:ref', requireUser, proxyHandler);
proxy.all('/:ref/*', requireUser, proxyHandler);

// --- OAuth redirect target ---

export const oauth = new Hono<Env>();
oauth.get('/mcp-client-metadata', (c) => c.json(mcpClientMetadata));

oauth.get('/callback', async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const back = (q: Record<string, string>) => c.redirect(`${config.publicUrl}/connections?${new URLSearchParams(q)}`);
  try {
    if (!identify(c)) throw new HttpError(401, 'Sign in to Switchboard first, then connect again');
    if (!params.state) throw badRequest('The provider did not return a state');
    const conn = await completeRedirect(params.state, params, c.get('user'));
    return back({ connected: conn.id });
  } catch (e: any) {
    return back({ error: e?.message ?? 'Connecting failed' });
  }
});
