import { HttpError, badRequest } from './http.ts';
import type { Connection, ServiceDefinition } from './plugins/api.ts';
import { loadConnection, markError, resolveBaseUrl, saveCredentials, touch, withLock } from './connections.ts';
import type { User } from './users.ts';
import { type Caller, countingStream, record, redactBody, setResponseSize } from './audit.ts';
import { getConnectionRow } from './connections.ts';
import { requestSatellite } from './satellites.ts';

export interface CallInput {
  method: string;
  /** Absolute, or relative to the service's base URL. May contain {placeholders}. */
  url: string;
  pathParams?: Record<string, string>;
  query?: [string, string][];
  headers?: [string, string][];
  body?: Uint8Array | string | null;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'cookie', 'authorization', 'x-switchboard-token', 'x-hub-token', 'origin', 'referer',
]);
const RESPONSE_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'alt-svc', 'strict-transport-security']);

export function allowedHosts(service: ServiceDefinition, conn: Connection): string[] {
  const list = typeof service.allowedHosts === 'function' ? service.allowedHosts(conn) : service.allowedHosts;
  if (list?.length) return list.map((h) => h.toLowerCase());
  const base = resolveBaseUrl(service, conn);
  return base ? [new URL(base).host.toLowerCase()] : [];
}

export function hostAllowed(host: string, patterns: string[]) {
  host = host.toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

/**
 * Escapes a path parameter but keeps "/": values such as Google's resource names
 * ("notes/abc", "projects/p/topics/t") are paths, not single segments.
 */
export function encodePathValue(v: string) {
  return String(v).split('/').map(encodeURIComponent).join('/');
}

export function buildUrl(service: ServiceDefinition, conn: Connection, input: Pick<CallInput, 'url' | 'pathParams' | 'query'>): URL {
  let raw = (input.url ?? '').trim();
  for (const [k, v] of Object.entries(input.pathParams ?? {})) raw = raw.split(`{${k}}`).join(encodePathValue(v));
  let url: URL;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else {
    const base = resolveBaseUrl(service, conn);
    if (!base) throw badRequest(`${service.name} has no base URL; use an absolute URL`);
    url = new URL(base.replace(/\/+$/, '') + (raw ? '/' + raw.replace(/^\/+/, '') : ''));
  }
  for (const [k, v] of input.query ?? []) if (k) url.searchParams.append(k, v);
  const allowed = allowedHosts(service, conn);
  if (!hostAllowed(url.host, allowed)) {
    throw badRequest(`${url.host} is not an allowed host for ${service.name}${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ''}`);
  }
  if (url.protocol !== 'https:') {
    const base = resolveBaseUrl(service, conn);
    if (!base || new URL(base).protocol !== 'http:') throw badRequest('Only https URLs are allowed');
  }
  return url;
}

export interface Executed {
  response: Response;
  url: URL;
  durationMs: number;
  /** What was sent upstream, with credentials masked. */
  sent: SentRequest;
  /** Audit trail entry, when recorded. */
  auditId?: number;
}

export interface SentRequest {
  method: string;
  url: string;
  /** [name, value, addedByHub]; values the auth method added or changed are masked. */
  headers: [string, string, boolean][];
  /** Query parameters the auth method added (masked in `url`). */
  authQuery: string[];
  body?: Uint8Array | string;
  /** The first attempt got a 401 and was retried with refreshed credentials. */
  retried: boolean;
}

const MASK = '••••••••';

/** Masks a credential, keeping a scheme word like "Bearer" or "Basic" so the header stays readable. */
function mask(value: string) {
  const m = value.match(/^([A-Za-z][\w-]*) +\S/);
  return m && m[1].length <= 16 ? `${m[1]} ${MASK}` : MASK;
}

/** Compares the request before and after the auth method ran and masks what it added. */
function describeSent(method: string, before: { url: URL; headers: Headers }, after: { url: URL; headers: Headers }, body: CallInput['body'], retried: boolean): SentRequest {
  const headers: [string, string, boolean][] = [];
  after.headers.forEach((v, k) => {
    const byHub = before.headers.get(k) !== v;
    headers.push([k, byHub ? mask(v) : v, byHub]);
  });
  const url = new URL(after.url);
  const authQuery: string[] = [];
  for (const k of new Set(url.searchParams.keys())) {
    if (before.url.searchParams.getAll(k).join('\0') !== url.searchParams.getAll(k).join('\0')) {
      authQuery.push(k);
      url.searchParams.set(k, MASK);
    }
  }
  return { method, url: url.toString(), headers, authQuery, body: body ?? undefined, retried };
}

export async function execute(user: User, connectionRef: string, input: CallInput, signal?: AbortSignal, caller?: Caller): Promise<Executed> {
  const method = (input.method || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw badRequest('Invalid HTTP method');
  const remoteRow = getConnectionRow(user.id, connectionRef);
  if (remoteRow.kind === 'mcp') throw badRequest('This connection is an MCP server; use an MCP operation');
  if (remoteRow.satellite_id) return executeRemote(user, remoteRow, input, method, signal, caller);
  const loaded = loadConnection(user.id, connectionRef);
  const { conn } = loaded;
  const started = Date.now();
  try {
    const ex = await executeLoaded(loaded, user, input, method, signal);
    if (caller) {
      const type = ex.sent.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
      const length = ex.response.headers.get('content-length');
      ex.auditId = record({
        userId: user.id,
        caller,
        connection: { id: conn.id, name: conn.name, serviceId: conn.serviceId },
        method,
        url: ex.sent.url,
        status: ex.response.status,
        durationMs: ex.durationMs,
        requestSize: ex.sent.body ? Buffer.byteLength(ex.sent.body as any) : 0,
        responseSize: length ? Number(length) : null,
        responseType: ex.response.headers.get('content-type'),
        retried: ex.sent.retried,
        requestHeaders: ex.sent.headers.map(([name, value, byHub]) => ({ name, value, byHub })),
        requestBody: redactBody(ex.sent.body, type),
      });
    }
    return ex;
  } catch (e: any) {
    // Failures are recorded too: refused hosts and failed sign-ins are what you want to see from an agent.
    if (caller) {
      let url = input.url;
      try {
        url = buildUrl(loaded.service, conn, input).toString();
      } catch {}
      record({
        userId: user.id,
        caller,
        connection: { id: conn.id, name: conn.name, serviceId: conn.serviceId },
        method,
        url,
        status: e instanceof HttpError ? e.status : 500,
        durationMs: Date.now() - started,
        error: e?.message ?? String(e),
      });
    }
    throw e;
  }
}

async function executeRemote(user: User, row: any, input: CallInput, method: string, signal?: AbortSignal, caller?: Caller): Promise<Executed> {
  const started = Date.now();
  const encoded = {
    ...input,
    body: input.body == null ? null : Buffer.from(input.body as any).toString('base64'),
    bodyEncoding: input.body == null ? undefined : 'base64',
  };
  let aborted = false;
  const abort = () => { aborted = true; };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new HttpError(499, 'Request cancelled');
    const r = await requestSatellite<any>(row.satellite_id, user.id, 'call', { connection: row.remote_connection_id, input: encoded, caller });
    if (aborted) throw new HttpError(499, 'Request cancelled; the outcome may be unknown');
    const sent: SentRequest = {
      ...r.sent,
      body: r.sent?.body == null ? undefined : Buffer.from(r.sent.body, r.sent.bodyEncoding === 'base64' ? 'base64' : 'utf8'),
    };
    const ex: Executed = {
      response: new Response(Buffer.from(r.body ?? '', 'base64'), { status: r.status, statusText: r.statusText, headers: r.headers }),
      url: new URL(r.url), durationMs: r.durationMs, sent,
    };
    if (caller) {
      const type = sent.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
      ex.auditId = record({
        userId: user.id, caller, connection: { id: row.id, name: row.name, serviceId: row.service_id }, method,
        url: sent.url, status: ex.response.status, durationMs: ex.durationMs,
        requestSize: sent.body ? Buffer.byteLength(sent.body as any) : 0,
        responseSize: Buffer.byteLength(r.body ?? '', 'base64'), responseType: ex.response.headers.get('content-type'), retried: sent.retried,
        requestHeaders: sent.headers.map(([name, value, byHub]) => ({ name, value, byHub })), requestBody: redactBody(sent.body, type),
      });
    }
    touch(row.id);
    return ex;
  } catch (e: any) {
    if (caller) record({
      userId: user.id, caller, connection: { id: row.id, name: row.name, serviceId: row.service_id }, method,
      url: input.url, status: e instanceof HttpError ? e.status : 500, durationMs: Date.now() - started, error: e?.message ?? String(e),
    });
    throw e;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function executeLoaded(loaded: ReturnType<typeof loadConnection>, user: User, input: CallInput, method: string, signal?: AbortSignal): Promise<Executed> {
  const { conn, service, method: auth } = loaded;
  const url = buildUrl(service, conn, input);

  const baseHeaders = new Headers();
  for (const [k, v] of input.headers ?? []) {
    const lower = k.toLowerCase();
    if (!k || HOP_BY_HOP.has(lower) || lower.startsWith('x-switchboard-') || lower.startsWith('x-hub-')) continue;
    try {
      baseHeaders.append(k, v);
    } catch {
      throw badRequest(`Invalid header ${k}`);
    }
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : input.body ?? undefined;

  const attempt = async (force: boolean) => {
    const req = { method, url: new URL(url), headers: new Headers(baseHeaders) };
    const before = { url: new URL(url), headers: new Headers(baseHeaders) };
    await withLock(conn.id, async () => {
      // Re-read inside the lock: another request may just have refreshed the credentials.
      const fresh = loadConnection(user.id, conn.id).conn;
      try {
        const result = await auth.authorize(req, fresh, { force });
        if (result && result.credentials !== undefined) saveCredentials(conn.id, result.credentials);
      } catch (e: any) {
        markError(conn.id, e?.message ?? String(e));
        throw new HttpError(502, `Could not authenticate with ${service.name}: ${e?.message ?? e}`);
      }
    });
    if (!hostAllowed(req.url.host, allowedHosts(service, conn))) throw badRequest('The plugin changed the request to a host that is not allowed');
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(req.url, {
        method,
        headers: req.headers,
        body: body as any,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      throw new HttpError(502, `Request to ${req.url.host} failed: ${e?.cause?.message ?? e?.message ?? e}`);
    }
    return { response, url: req.url, durationMs: Math.round(performance.now() - started), sent: describeSent(method, before, req, body, force) };
  };

  let result: Executed = await attempt(false);
  if (result.response.status === 401) {
    await result.response.body?.cancel();
    result = await attempt(true);
  }
  touch(conn.id);
  return result;
}

/** Passes an upstream response through, counting its size for the audit trail. */
export function passThrough(ex: Executed): Response {
  const body = ex.response.body && ex.auditId ? ex.response.body.pipeThrough(countingStream(ex.auditId)) : ex.response.body;
  return new Response(body, { status: ex.response.status, headers: responseHeaders(ex.response) });
}

export function responseHeaders(res: Response): Headers {
  const h = new Headers();
  res.headers.forEach((v, k) => {
    if (!RESPONSE_DROP.has(k)) h.append(k, v);
  });
  return h;
}

/** Hands out the raw access token. Recorded, since calls made with it no longer pass through Switchboard. */
export async function issueToken(user: User, connectionRef: string, force = false, caller?: Caller) {
  const row = getConnectionRow(user.id, connectionRef);
  if (row.satellite_id) throw badRequest('Satellite connections do not hand out raw access tokens; use the proxy instead');
  const { conn, service, method } = loadConnection(user.id, connectionRef);
  const started = Date.now();
  const audit = (status: number, error?: string) =>
    caller &&
    record({
      userId: user.id,
      caller,
      connection: { id: conn.id, name: conn.name, serviceId: conn.serviceId },
      method: 'TOKEN',
      url: force ? 'Issued access token (forced refresh)' : 'Issued access token',
      status,
      durationMs: Date.now() - started,
      error,
    });
  if (!method.token) {
    const msg = `${service.name} (${method.name}) does not hand out tokens; use the proxy instead`;
    audit(400, msg);
    throw badRequest(msg);
  }
  return withLock(conn.id, async () => {
    const fresh = loadConnection(user.id, conn.id).conn;
    try {
      const t = await method.token!(fresh, { force });
      if (t.credentials !== undefined) saveCredentials(conn.id, t.credentials);
      audit(200);
      return { access_token: t.accessToken, token_type: t.tokenType ?? 'Bearer', expires_at: t.expiresAt ?? null };
    } catch (e: any) {
      markError(conn.id, e?.message ?? String(e));
      const msg = `Could not get a token from ${service.name}: ${e?.message ?? e}`;
      audit(502, msg);
      throw new HttpError(502, msg);
    }
  });
}

const DISPLAY_LIMIT = 1024 * 1024;

function bodyForDisplay(body: Uint8Array | string | undefined, type: string) {
  if (body === undefined || body === null) return { body: '', bodyEncoding: 'utf8' as const, size: 0, truncated: false };
  const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const textual = typeof body === 'string' || !type || TEXTUAL.test(type);
  const shown = buf.subarray(0, DISPLAY_LIMIT);
  return { body: textual ? shown.toString('utf8') : shown.toString('base64'), bodyEncoding: textual ? ('utf8' as const) : ('base64' as const), size: buf.length, truncated: buf.length > DISPLAY_LIMIT };
}

const TEXTUAL = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|x-ndjson))/i;

/** JSON envelope used by the web console and /api/call. */
export async function envelope(ex: Executed) {
  const res = ex.response;
  const buf = Buffer.from(await res.arrayBuffer());
  if (ex.auditId) setResponseSize(ex.auditId, buf.length);
  const type = res.headers.get('content-type') ?? '';
  const textual = !buf.length || TEXTUAL.test(type);
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => headers.push([k, v]));
  return {
    status: res.status,
    statusText: res.statusText,
    // Masked: an API key may be in the query string.
    url: ex.sent.url,
    headers,
    durationMs: ex.durationMs,
    size: buf.length,
    bodyEncoding: textual ? 'utf8' : 'base64',
    body: textual ? buf.toString('utf8') : buf.toString('base64'),
    request: {
      method: ex.sent.method,
      url: ex.sent.url,
      headers: ex.sent.headers.map(([name, value, byHub]) => ({ name, value, byHub })),
      retried: ex.sent.retried,
      ...bodyForDisplay(ex.sent.body, ex.sent.headers.find(([k]) => k === 'content-type')?.[1] ?? ''),
    },
  };
}
