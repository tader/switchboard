// Audit trail of every request the hub makes on a user's behalf, and every raw token it hands out.
// Everything is redacted before it is written: credentials the hub added are already masked by the
// proxy, and secret-looking values the caller sent are masked here.
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Env } from './auth.ts';
import { config } from './config.ts';
import { all, now, one, run } from './db.ts';
import { badRequest, notFound } from './http.ts';

export type AuditSource = 'proxy' | 'call' | 'saved-call' | 'console' | 'token' | 'mcp';

/** Who made the request: from the route's context. */
export interface Caller {
  source: AuditSource;
  tokenId: string | null;
  tokenName: string | null;
  ip: string | null;
  userAgent: string | null;
  savedCall?: string;
}

export function callerFrom(c: Context<Env>, source: AuditSource, savedCall?: string): Caller {
  const token = c.get('token');
  // A call from the web app's console is a "console" call, even though it uses /api/call.
  const src = source === 'call' && !token ? 'console' : source;
  return {
    source: src,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    ip: c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? remoteAddress(c),
    userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
    savedCall,
  };
}

function remoteAddress(c: Context<Env>): string | null {
  try {
    return getConnInfo(c).remote.address?.replace(/^::ffff:/, '') ?? null;
  } catch {
    return null;
  }
}

const MASK = '••••••••';
const SECRET_PATTERN = /(pass(word|wd)?$|secret|token|api[-_]?key|^authorization$|^auth$|credential|session[-_]?id|signature|private[-_]?key|^key$|^sig$|^code$|^cookie$)/i;
/** Names that match the pattern but are not secrets, such as pagination cursors. */
const NOT_SECRET = /^(next_?)?page_?token$|^sync_?token$|^token_?type$|^max_?tokens$/i;
const SECRET_NAME = { test: (name: string) => SECRET_PATTERN.test(name) && !NOT_SECRET.test(name) };
const BODY_LIMIT = 4096;

/** Masks query parameters with secret-looking names (the hub's own credentials are already masked). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of new Set(u.searchParams.keys())) if (SECRET_NAME.test(k)) u.searchParams.set(k, MASK);
    return u.toString();
  } catch {
    return url;
  }
}

export function redactHeaders(headers: { name: string; value: string; byHub: boolean }[]) {
  return headers.map((h) => ({ ...h, value: h.byHub || SECRET_NAME.test(h.name) || h.name === 'cookie' ? (h.value.includes(MASK) ? h.value : MASK) : h.value }));
}

function redactJson(v: unknown, depth = 0): unknown {
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_NAME.test(k) && (typeof x === 'string' || typeof x === 'number') ? MASK : redactJson(x, depth + 1)]));
}

/** Redacts secret-looking fields in JSON and form bodies, and keeps at most 4 KB. */
export function redactBody(body: Uint8Array | string | undefined | null, contentType: string): string | null {
  if (body === undefined || body === null) return null;
  const buf = Buffer.from(body as any);
  if (!buf.length) return null;
  const textual = !contentType || /json|text|xml|form-urlencoded|javascript|yaml|graphql/i.test(contentType);
  if (!textual) return `[${buf.length} bytes, ${contentType}]`;
  let text = buf.toString('utf8');
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(redactJson(JSON.parse(text)));
    } catch {}
  } else if (/form-urlencoded/i.test(contentType)) {
    const p = new URLSearchParams(text);
    for (const k of new Set(p.keys())) if (SECRET_NAME.test(k)) p.set(k, MASK);
    text = p.toString();
  }
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}… [${buf.length} bytes]` : text;
}

export interface AuditEntry {
  userId: string;
  caller: Caller;
  connection?: { id: string; name: string; serviceId: string };
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestSize?: number;
  responseSize?: number | null;
  responseType?: string | null;
  retried?: boolean;
  error?: string;
  requestHeaders?: { name: string; value: string; byHub: boolean }[];
  requestBody?: string | null;
}

/** Writes an entry and returns its id, e.g. to fill in the response size once streamed. */
export function record(e: AuditEntry): number {
  const url = e.url ? redactUrl(e.url) : null;
  let host: string | null = null;
  try {
    host = url ? new URL(url).host : null;
  } catch {}
  const r = run(
    `INSERT INTO audit_log (user_id, created_at, source, connection_id, connection_name, service_id, token_id, token_name, saved_call,
       method, url, host, status, duration_ms, request_size, response_size, response_type, retried, error, ip, user_agent, request_headers, request_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.userId, now(), e.caller.source, e.connection?.id ?? null, e.connection?.name ?? null, e.connection?.serviceId ?? null,
    e.caller.tokenId, e.caller.tokenName, e.caller.savedCall ?? null, e.method ?? null, url, host, e.status ?? null, e.durationMs ?? null,
    e.requestSize ?? null, e.responseSize ?? null, e.responseType ?? null, e.retried ? 1 : 0, e.error?.slice(0, 1000) ?? null,
    e.caller.ip, e.caller.userAgent, e.requestHeaders ? JSON.stringify(redactHeaders(e.requestHeaders)) : null, e.requestBody ?? null,
  );
  return Number(r.lastInsertRowid);
}

export function setResponseSize(id: number, size: number) {
  run('UPDATE audit_log SET response_size = ? WHERE id = ?', size, id);
}

/** Counts bytes of a streamed response and stores the total when the stream ends. */
export function countingStream(id: number): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  return new TransformStream({
    transform(chunk, ctrl) {
      size += chunk.byteLength;
      ctrl.enqueue(chunk);
    },
    flush() {
      setResponseSize(id, size);
    },
  });
}

// --- querying ---

const SORTS: Record<string, string> = { time: 'created_at', duration: 'duration_ms', status: 'status', size: 'response_size' };

export interface AuditQuery {
  connection?: string;
  /** Token id, or "web" for the web console. */
  client?: string;
  status?: string; // 2xx, 3xx, 4xx, 5xx, error, or an exact code
  method?: string;
  source?: string;
  q?: string;
  from?: number;
  to?: number;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

function where(userId: string, q: AuditQuery) {
  const clauses = ['user_id = ?'];
  const params: any[] = [userId];
  if (q.connection) {
    clauses.push('(connection_id = ? OR connection_name = ?)');
    params.push(q.connection, q.connection);
  }
  if (q.client === 'web') clauses.push('token_id IS NULL');
  else if (q.client) {
    clauses.push('token_id = ?');
    params.push(q.client);
  }
  if (q.status) {
    const m = q.status.match(/^([1-5])xx$/);
    if (m) {
      clauses.push('status >= ? AND status < ?');
      params.push(Number(m[1]) * 100, Number(m[1]) * 100 + 100);
    } else if (q.status === 'error') clauses.push('(error IS NOT NULL OR status >= 400)');
    else if (/^\d{3}$/.test(q.status)) {
      clauses.push('status = ?');
      params.push(Number(q.status));
    } else throw badRequest('status must be 2xx..5xx, error, or a code');
  }
  if (q.method) {
    clauses.push('method = ?');
    params.push(q.method.toUpperCase());
  }
  if (q.source) {
    clauses.push('source = ?');
    params.push(q.source);
  }
  if (q.q) {
    clauses.push(`(url LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR saved_call LIKE ? ESCAPE '\\')`);
    const like = `%${q.q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    params.push(like, like, like);
  }
  if (q.from) {
    clauses.push('created_at >= ?');
    params.push(q.from);
  }
  if (q.to) {
    clauses.push('created_at <= ?');
    params.push(q.to);
  }
  return { sql: clauses.join(' AND '), params };
}

const toEntry = (r: any, full = false) => ({
  id: r.id,
  at: r.created_at,
  source: r.source,
  connection: r.connection_id ? { id: r.connection_id, name: r.connection_name, serviceId: r.service_id } : null,
  client: r.token_id ? { tokenId: r.token_id, name: r.token_name } : null,
  savedCall: r.saved_call,
  method: r.method,
  url: r.url,
  host: r.host,
  status: r.status,
  durationMs: r.duration_ms,
  requestSize: r.request_size,
  responseSize: r.response_size,
  responseType: r.response_type,
  retried: !!r.retried,
  error: r.error,
  ...(full
    ? { ip: r.ip, userAgent: r.user_agent, requestHeaders: r.request_headers ? JSON.parse(r.request_headers) : [], requestBody: r.request_body }
    : {}),
});

export function queryAudit(userId: string, q: AuditQuery) {
  const w = where(userId, q);
  const col = SORTS[q.sort ?? 'time'];
  if (!col) throw badRequest('sort must be time, duration, status or size');
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);
  // Rows without a value (e.g. no duration for failed requests) go last either way.
  const rows = all(`SELECT * FROM audit_log WHERE ${w.sql} ORDER BY ${col} IS NULL, ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`, ...w.params, limit, offset);
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE ${w.sql}`, ...w.params)!.n;
  return { items: rows.map((r) => toEntry(r)), total, limit, offset };
}

export function getAudit(userId: string, id: number) {
  const r = one('SELECT * FROM audit_log WHERE id = ? AND user_id = ?', id, userId);
  if (!r) throw notFound('Entry not found');
  return toEntry(r, true);
}

/** Values to offer in filters, including tokens and connections that no longer exist. */
export function auditFacets(userId: string) {
  return {
    connections: all(
      `SELECT connection_id AS id, connection_name AS name, service_id AS serviceId, COUNT(*) AS count FROM audit_log
       WHERE user_id = ? AND connection_id IS NOT NULL GROUP BY connection_id ORDER BY connection_name`,
      userId,
    ),
    clients: all(
      `SELECT token_id AS id, token_name AS name, COUNT(*) AS count FROM audit_log WHERE user_id = ? AND token_id IS NOT NULL GROUP BY token_id ORDER BY token_name`,
      userId,
    ),
    methods: all(`SELECT DISTINCT method FROM audit_log WHERE user_id = ? AND method IS NOT NULL ORDER BY method`, userId).map((r) => r.method),
  };
}

export function prune() {
  if (!config.auditRetentionDays) return;
  run('DELETE FROM audit_log WHERE created_at < ?', now() - config.auditRetentionDays * 86400_000);
}
