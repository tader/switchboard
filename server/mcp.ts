// MCP server at /mcp (Streamable HTTP). Dual-era: requests carrying per-request `_meta`
// (protocol 2026-07-28) are served statelessly with header validation; clients on earlier
// revisions open with `initialize` and are served without a session. Every tool runs as the
// token's user, limited to the token's connections, and is recorded in the activity log.
import { Hono, type Context } from 'hono';
import type { Env } from './auth.ts';
import { callerFrom } from './audit.ts';
import { config } from './config.ts';
import { getConnectionRow, listConnections, loadConnection, resolveBaseUrl, toView } from './connections.ts';
import { all, one } from './db.ts';
import { HttpError } from './http.ts';
import { describe } from './openapi.ts';
import { execute } from './proxy.ts';
import { isApiToken, tokenUser } from './users.ts';
import { requestSatellite } from './satellites.ts';

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'switchboard', title: 'Switchboard', version: '1.0.0' };
const META = 'io.modelcontextprotocol/';

const INSTRUCTIONS = `Switchboard signs in to services (Gmail, GitHub, Jira, ...) on the user's behalf and adds credentials to requests.
Use this sequence: list_connections → search_operations → get_operation → call_operation. Always inspect get_operation before calling so you use its supported path, query, header, and body parameters. Use the lower-level call only for undocumented or unusual endpoints.
These are MCP tools. If your host exposes them as deferred tools, invoke them through the host's deferred tool-call mechanism; do not treat a discovered operationId as a new native tool.
Paths are relative to the connection's base URL. Credentials are added by Switchboard; never send your own Authorization header.
For paginated operations, preserve the same filters and keep calling with the returned nextToken until it is absent before claiming the result is complete. Prefer restrictive filters before paginating.`;

type Json = Record<string, any>;

class RpcError extends Error {
  code: number;
  http: number;
  data?: unknown;
  constructor(code: number, message: string, http = 200, data?: unknown) {
    super(message);
    this.code = code;
    this.http = http;
    this.data = data;
  }
}

// --- tools ---

const MAX_TEXT = 100_000;

const tools = [
  {
    name: 'list_connections',
    title: 'List connections',
    description: 'Accounts this client may use, with their service and base URL. Use the connection name in the other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_operations',
    title: 'Search API operations',
    description: "Search a connection's API reference (OpenAPI) by keywords, e.g. 'list messages' or 'create issue'. Returns method, path, supported parameters, and pagination metadata. Follow with get_operation before call.",
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or id' },
        query: { type: 'string', description: 'Keywords; all must match. Empty lists the first operations.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_operation',
    title: 'Get an API operation',
    description: 'Get complete parameter, body, and pagination metadata for one operation. Inspect this immediately before call.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        operationId: { type: 'string' },
        method: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'call',
    title: 'Call an API',
    description:
      'Make an HTTP request through a connection. Switchboard adds the credentials. path is relative to the base URL (e.g. /gmail/v1/users/me/messages) or an absolute URL on an allowed host; {placeholders} are filled from path_params.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or id' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
        path: { type: 'string' },
        path_params: { type: 'object', additionalProperties: { type: 'string' } },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query parameters' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { description: 'Request body: a string, or JSON (sent as application/json)' },
      },
      required: ['connection', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'call_operation',
    title: 'Call an API operation',
    description: 'Call a documented OpenAPI operation by operationId. Switchboard validates and maps its path, query, header, and body inputs automatically. Prefer this over call after get_operation.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or id' },
        operationId: { type: 'string', description: 'Exact operationId returned by search_operations or get_operation' },
        parameters: { type: 'object', additionalProperties: {}, description: 'Parameters by their documented names' },
        body: { description: 'Documented request body' },
      },
      required: ['connection', 'operationId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_saved_calls',
    title: 'List saved calls',
    description: 'Requests the user saved for reuse.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_saved_call',
    title: 'Run a saved call',
    description: 'Run a saved call by name or id, optionally overriding path parameters, query, headers or body.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Saved call name or id' },
        path_params: { type: 'object', additionalProperties: { type: 'string' } },
        query: { type: 'object', additionalProperties: { type: 'string' } },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: {},
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

interface Ctx {
  c: Context<Env>;
  user: NonNullable<ReturnType<typeof tokenUser>>['user'];
  token: NonNullable<ReturnType<typeof tokenUser>>['token'];
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown) => ({ ...text(JSON.stringify(v, null, 2)), structuredContent: Array.isArray(v) ? { items: v } : v });

function connectionFor(ctx: Ctx, ref: unknown) {
  if (typeof ref !== 'string' || !ref) throw new ToolError('connection is required');
  let row;
  try {
    row = getConnectionRow(ctx.user.id, ref);
  } catch {
    throw new ToolError(`No connection "${ref}". Use list_connections.`);
  }
  if (ctx.token.connectionIds && !ctx.token.connectionIds.includes(row.id)) throw new ToolError(`This client may not use "${ref}". Use list_connections.`);
  return row;
}

class ToolError extends Error {}

const pairs = (v: unknown): [string, string][] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Json).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]) : [];

function operationMetadata(operation: { params: any[]; body?: any }) {
  const parameters = {
    path: operation.params.filter((p) => p.in === 'path'),
    query: operation.params.filter((p) => p.in === 'query'),
    header: operation.params.filter((p) => p.in === 'header'),
  };
  const token = parameters.query.find((p) => /^(next_?token|page_?token|cursor)$/i.test(p.name));
  return {
    parameters,
    ...(operation.body ? { requestBody: operation.body } : {}),
    ...(token ? { pagination: {
      nextTokenParameter: token.name,
      instruction: `Preserve all filters and pass the response's ${token.name} value as ${token.name} on the next call. Continue until the response omits it.`,
    } } : {}),
  };
}

async function apiDescription(ctx: Ctx, row: any) {
  if (row.satellite_id) {
    const description = await requestSatellite<Awaited<ReturnType<typeof describe>>>(row.satellite_id, ctx.user.id, 'openapi', { connection: row.remote_connection_id });
    return { description, serviceName: toView(row).serviceName, pathFor: (path: string) => path };
  }
  const { conn, service } = loadConnection(ctx.user.id, row.id);
  const description = await describe(service, conn);
  const base = (resolveBaseUrl(service, conn) ?? '').replace(/\/+$/, '');
  const prefix = description && base && description.server.startsWith(base) ? description.server.slice(base.length) : description?.server ?? '';
  return { description, serviceName: service.name, docsUrl: service.docsUrl, pathFor: (path: string) => prefix + path };
}

function parameterValue(param: any, value: unknown): string | string[] {
  const values = param.type === 'array' ? (Array.isArray(value) ? value : [value]) : [value];
  const converted = values.map((item) => {
    if (item === null || item === undefined || typeof item === 'object') throw new ToolError(`${param.name} must be ${param.type ?? 'a scalar value'}`);
    if (param.type === 'boolean' && item !== true && item !== false && item !== 'true' && item !== 'false') throw new ToolError(`${param.name} must be true or false`);
    if (param.type === 'integer' && (!Number.isInteger(Number(item)) || String(item).trim() === '')) throw new ToolError(`${param.name} must be an integer`);
    if (param.type === 'number' && (!Number.isFinite(Number(item)) || String(item).trim() === '')) throw new ToolError(`${param.name} must be a number`);
    const text = String(item);
    if (param.enum && !param.enum.includes(text)) throw new ToolError(`${param.name} must be one of: ${param.enum.join(', ')}`);
    return text;
  });
  return param.type === 'array' ? converted : converted[0];
}

function operationRequest(operation: any, path: string, supplied: unknown, body: unknown) {
  if (supplied !== undefined && (!supplied || Array.isArray(supplied) || typeof supplied !== 'object')) throw new ToolError('parameters must be an object');
  const input = (supplied ?? {}) as Json;
  const supported = new Set(operation.params.map((param: any) => param.name));
  const duplicate = operation.params.find((param: any, index: number) => operation.params.findIndex((other: any) => other.name === param.name) !== index);
  if (duplicate) throw new ToolError(`Operation has more than one parameter named ${duplicate.name}; use the lower-level call tool`);
  const unknown = Object.keys(input).filter((name) => !supported.has(name));
  if (unknown.length) throw new ToolError(`Unknown parameter${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Supported: ${[...supported].join(', ') || 'none'}`);
  const pathParams: Json = {};
  const query: [string, string][] = [];
  const headers: [string, string][] = [];
  for (const param of operation.params) {
    const raw = input[param.name] ?? param.default;
    if (raw === undefined || raw === null || raw === '') {
      if (param.required) throw new ToolError(`${param.name} is required`);
      continue;
    }
    const value = parameterValue(param, raw);
    const values = Array.isArray(value) ? value : [value];
    if (param.in === 'path') pathParams[param.name] = values.join(',');
    else if (param.in === 'query') for (const item of values) query.push([param.name, item]);
    else if (param.in === 'header') {
      if (/^(authorization|cookie|x-(switchboard|hub)-)/i.test(param.name)) throw new ToolError(`${param.name} is managed by Switchboard and cannot be supplied`);
      headers.push([param.name, values.join(',')]);
    }
  }
  if (operation.body?.required && (body === undefined || body === null)) throw new ToolError('body is required');
  if (body !== undefined && !operation.body) throw new ToolError('This operation does not define a request body');
  let requestBody = body;
  if (body !== undefined && body !== null && operation.body?.contentType) {
    const contentType = operation.body.contentType;
    if (/x-www-form-urlencoded/i.test(contentType) && typeof body === 'object' && !Array.isArray(body)) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(body as Json)) form.append(name, typeof value === 'string' ? value : String(value));
      requestBody = form.toString();
    } else if (!/json/i.test(contentType) && typeof body !== 'string') {
      throw new ToolError(`body must be a string for content type ${contentType}; use the lower-level call tool for complex encodings`);
    }
    headers.push(['content-type', contentType]);
  }
  return { method: operation.method, url: path, pathParams, query, headers, body: requestBody };
}

async function runCall(ctx: Ctx, connectionId: string, req: { method: string; url: string; pathParams?: Json; query?: [string, string][]; headers?: [string, string][]; body?: unknown }, savedCall?: string) {
  let body: string | undefined;
  const headers = req.headers ?? [];
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (typeof req.body !== 'string' && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['content-type', 'application/json']);
  }
  let ex;
  try {
    ex = await execute(
      ctx.user,
      connectionId,
      { method: req.method, url: req.url, pathParams: req.pathParams as Record<string, string>, query: req.query, headers, body },
      ctx.c.req.raw.signal,
      callerFrom(ctx.c, 'mcp', savedCall),
    );
  } catch (e: any) {
    throw new ToolError(e?.message ?? String(e));
  }
  const res = ex.response;
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  const keep = ['content-type', 'location', 'link', 'etag', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  const shown: Json = {};
  for (const k of keep) if (res.headers.get(k)) shown[k] = res.headers.get(k);
  const textual = !buf.length || /json|text|xml|javascript|yaml|form-urlencoded|graphql/i.test(type);
  let bodyText = textual ? buf.toString('utf8') : `[binary body, ${buf.length} bytes, ${type || 'unknown type'}]`;
  if (bodyText.length > MAX_TEXT) bodyText = `${bodyText.slice(0, MAX_TEXT)}\n… [truncated; ${buf.length} bytes in total]`;
  const head = `HTTP ${res.status} ${res.statusText}\n${Object.entries(shown).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  return text(`${head}\n\n${bodyText}`, res.status >= 400);
}

async function callTool(ctx: Ctx, name: string, args: Json) {
  switch (name) {
    case 'list_connections': {
      const list = listConnections(ctx.user.id, ctx.token.connectionIds).map((c) => ({
        name: c.name,
        service: c.serviceName,
        account: c.account?.label ?? null,
        baseUrl: c.baseUrl,
        hasApiReference: c.hasOpenapi,
        status: c.status,
        location: c.satellite ? { type: 'satellite', name: c.satellite.name, online: c.satellite.online } : { type: 'local' },
        ...(c.statusMessage ? { problem: c.statusMessage } : {}),
      }));
      return json(list);
    }
    case 'search_operations':
    case 'get_operation': {
      const row = connectionFor(ctx, args.connection);
      let api: Awaited<ReturnType<typeof apiDescription>>;
      try {
        api = await apiDescription(ctx, row);
      } catch (e: any) {
        throw new ToolError(`Could not load the API reference: ${e.message}`);
      }
      const d = api.description;
      if (!d) throw new ToolError(`${api.serviceName} has no API reference; use call with paths from its documentation${api.docsUrl ? ` (${api.docsUrl})` : ''}.`);
      if (name === 'search_operations') {
        const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const hits = d.operations.filter((o) => {
          const hay = `${o.method} ${o.path} ${o.summary ?? ''} ${o.id} ${o.tag} ${o.description ?? ''}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        return json({
          total: hits.length,
          instruction: 'Use get_operation for the selected operation before call.',
          operations: hits.slice(0, limit).map((o) => ({ operationId: o.id, method: o.method, path: api.pathFor(o.path), summary: o.summary, ...operationMetadata(o), ...(o.deprecated ? { deprecated: true } : {}) })),
        });
      }
      const op = d.operations.find((o) =>
        args.operationId ? o.id === args.operationId : o.method === String(args.method ?? '').toUpperCase() && (api.pathFor(o.path) === args.path || o.path === args.path),
      );
      if (!op) throw new ToolError('Operation not found; use search_operations');
      return json({ ...op, path: api.pathFor(op.path), ...operationMetadata(op), callMapping: {
        operationId: 'call_operation.operationId', parameters: 'call_operation.parameters', requestBody: 'call_operation.body',
      } });
    }
    case 'call': {
      const row = connectionFor(ctx, args.connection);
      return runCall(ctx, row.id, {
        method: String(args.method ?? 'GET').toUpperCase(),
        url: String(args.path ?? ''),
        pathParams: args.path_params,
        query: pairs(args.query),
        headers: pairs(args.headers),
        body: args.body,
      });
    }
    case 'call_operation': {
      const row = connectionFor(ctx, args.connection);
      let api: Awaited<ReturnType<typeof apiDescription>>;
      try {
        api = await apiDescription(ctx, row);
      } catch (e: any) {
        throw new ToolError(`Could not load the API reference: ${e.message}`);
      }
      if (!api.description) throw new ToolError(`${api.serviceName} has no API reference; use call for undocumented endpoints.`);
      const matches = api.description.operations.filter((operation) => operation.id === args.operationId);
      if (!matches.length) throw new ToolError(`Operation "${args.operationId}" not found; use search_operations.`);
      if (matches.length > 1) throw new ToolError(`OperationId "${args.operationId}" is ambiguous; use the lower-level call tool.`);
      const operation = matches[0];
      const result = await runCall(ctx, row.id, operationRequest(operation, api.pathFor(operation.path), args.parameters, args.body));
      const pagination = operationMetadata(operation).pagination;
      if (pagination) result.content[0].text += `\n\nPagination: ${pagination.instruction}`;
      if (operation.deprecated) result.content[0].text += '\n\nWarning: this operation is deprecated.';
      return result;
    }
    case 'list_saved_calls': {
      const rows = all('SELECT * FROM saved_calls WHERE user_id = ? ORDER BY name COLLATE NOCASE', ctx.user.id).filter(
        (r) => !ctx.token.connectionIds || ctx.token.connectionIds.includes(r.connection_id),
      );
      const names = new Map(listConnections(ctx.user.id).map((c) => [c.id, c.name]));
      return json(rows.map((r) => ({ name: r.name, id: r.id, method: r.method, url: r.url, connection: names.get(r.connection_id) ?? null })));
    }
    case 'run_saved_call': {
      const r = one('SELECT * FROM saved_calls WHERE user_id = ? AND (id = ? OR name = ?)', ctx.user.id, String(args.name ?? ''), String(args.name ?? ''));
      if (!r) throw new ToolError(`No saved call "${args.name}"; use list_saved_calls`);
      if (!r.connection_id) throw new ToolError('This saved call has no connection');
      const row = connectionFor(ctx, r.connection_id);
      const merge = (stored: string | null, extra: unknown) => {
        const m = new Map<string, [string, string]>();
        for (const p of JSON.parse(stored ?? '[]')) if (p.key && p.enabled !== false) m.set(p.key.toLowerCase(), [p.key, p.value]);
        for (const [k, v] of pairs(extra)) m.set(k.toLowerCase(), [k, v]);
        return [...m.values()];
      };
      return runCall(
        ctx,
        row.id,
        {
          method: r.method,
          url: r.url,
          pathParams: { ...JSON.parse(r.path_params ?? '{}'), ...(args.path_params ?? {}) },
          query: merge(r.query, args.query),
          headers: merge(r.headers, args.headers),
          body: args.body !== undefined ? args.body : r.body || undefined,
        },
        r.name,
      );
    }
  }
  throw new RpcError(-32602, `Unknown tool: ${name}`);
}

// --- protocol ---

const capabilities = { tools: { listChanged: false } };

async function dispatch(ctx: Ctx, msg: Json, modern: boolean) {
  const params = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return { protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0], capabilities, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    }
    case 'server/discover':
      return { supportedVersions: [...MODERN, ...LEGACY], capabilities, _meta: { [`${META}serverInfo`]: SERVER_INFO }, instructions: INSTRUCTIONS };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'tools/call': {
      if (!tools.some((t) => t.name === params.name)) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
      try {
        return await callTool(ctx, params.name, params.arguments ?? {});
      } catch (e: any) {
        // Tool failures are results the model can read and act on, not protocol errors.
        if (e instanceof ToolError) return text(e.message, true);
        throw e;
      }
    }
  }
  throw new RpcError(-32601, `Method not found: ${msg.method}`, modern ? 404 : 200);
}

/** Decodes the "=?base64?…?=" sentinel used for non-ASCII header values. */
function headerValue(v: string | undefined) {
  const m = v?.match(/^=\?base64\?(.*)\?=$/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

export const mcp = new Hono<Env>();

mcp.post('/', async (c) => {
  // DNS rebinding protection: browsers send Origin, and only Switchboard's own pages may use it.
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(config.publicUrl).origin) return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } }, 403);

  const auth = c.req.header('authorization');
  const secret = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
  const found = isApiToken(secret) ? tokenUser(secret) : undefined;
  if (!found) {
    c.header('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"${secret ? ', error="invalid_token"' : ''}`);
    return c.json({ jsonrpc: '2.0', error: { code: -32001, message: secret ? 'Invalid or expired token' : 'Authorization required' } }, 401);
  }
  c.set('user', found.user);
  c.set('token', found.token);

  let msg: Json;
  try {
    msg = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (Array.isArray(msg) || !msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: send one JSON-RPC message per POST' } }, 400);
  }
  const isNotification = !('id' in msg);
  if (isNotification) return c.body(null, 202);

  const id = msg.id;
  const meta = msg.params?._meta ?? {};
  const version: string | undefined = meta[`${META}protocolVersion`];
  const modern = version !== undefined;
  const reply = (body: Json, status = 200) => c.json({ jsonrpc: '2.0', id, ...body }, status as any);

  try {
    if (modern) {
      const mismatch = (what: string) => {
        throw new RpcError(-32020, `Header mismatch: ${what}`, 400);
      };
      if (c.req.header('mcp-protocol-version') !== version) mismatch('MCP-Protocol-Version does not match _meta');
      if (!MODERN.includes(version)) throw new RpcError(-32022, 'Unsupported protocol version', 400, { supported: [...MODERN, ...LEGACY], requested: version });
      if (c.req.header('mcp-method') !== msg.method) mismatch('Mcp-Method does not match the method');
      if (msg.method === 'tools/call' && headerValue(c.req.header('mcp-name')) !== msg.params?.name) mismatch('Mcp-Name does not match the tool name');
      if (msg.method === 'initialize') throw new RpcError(-32601, 'initialize is not used in this protocol version', 404);
    } else if (msg.method !== 'initialize') {
      const v = c.req.header('mcp-protocol-version');
      if (v && !LEGACY.includes(v) && !MODERN.includes(v)) throw new RpcError(-32600, `Unsupported protocol version ${v}; supported: ${[...MODERN, ...LEGACY].join(', ')}`, 400);
    }
    const result = await dispatch({ c, user: found.user, token: found.token }, msg, modern);
    return reply({ result: modern ? { resultType: 'complete', ...result } : result });
  } catch (e: any) {
    if (e instanceof RpcError) return reply({ error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } }, e.http);
    if (e instanceof HttpError) return reply({ error: { code: -32603, message: e.message } });
    console.error(e);
    return reply({ error: { code: -32603, message: 'Internal error' } });
  }
});

// No standalone SSE stream and no sessions.
mcp.on(['GET', 'DELETE'], '/', (c) => c.body(null, 405, { allow: 'POST' }));
