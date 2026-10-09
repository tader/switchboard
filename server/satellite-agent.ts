import WebSocket from 'ws';
import { toView, loadConnection } from './connections.ts';
import { plugins } from './plugins/manager.ts';
import { execute, type CallInput } from './proxy.ts';
import { setResponseSize, type AuditSource, type Caller } from './audit.ts';
import { describe } from './openapi.ts';
import { getUser } from './users.ts';
import { all } from './db.ts';
import { executeMcp } from './upstream-mcp.ts';
import { onConnectionChange } from './connection-events.ts';
import { configuredUpstreams, onUpstreamsChanged, sharedConnection, upstreamStatuses, upstreamToken } from './upstreams.ts';
import { satelliteConnection } from './satellites.ts';
import { acceptRoute, instanceId, MAX_SATELLITE_HOPS, satelliteRoute, SATELLITE_MAX_MESSAGE, SATELLITE_OPERATIONS, SATELLITE_PROTOCOL } from './satellite-protocol.ts';
import { HttpError } from './http.ts';

const auditSources = new Set<AuditSource>(['proxy', 'call', 'saved-call', 'console', 'token', 'mcp']);
function socketUrl(base: string) { const u = new URL(base); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; u.pathname = '/api/satellites/connect'; return u.toString(); }
export function sharedCatalogue(upstreamId: string, targetInstance?: string) {
  const connections = all(`SELECT c.* FROM connections c JOIN connection_upstream_shares sh ON sh.connection_id = c.id
    JOIN users u ON u.id = c.user_id WHERE sh.upstream_id = ? AND u.disabled = 0 AND u.satellite_shadow = 0 ORDER BY c.id`, upstreamId).flatMap(row => {
    const c = toView(row);
    let route = [instanceId()];
    if (row.satellite_id) {
      try { route = [...satelliteConnection(row.user_id, row.satellite_id, row.remote_connection_id).route, instanceId()]; }
      catch { return []; }
    }
    if (route.length > MAX_SATELLITE_HOPS || new Set(route).size !== route.length || (targetInstance && route.includes(targetInstance))) return [];
    return [{ id: row.id, name: c.name, serviceId: c.serviceId, serviceName: c.serviceName, kind: c.kind,
      icon: row.satellite_id ? satelliteConnection(row.user_id, row.satellite_id, row.remote_connection_id).icon : plugins.service(c.serviceId)?.icon,
      hasOpenapi: c.hasOpenapi, status: c.status, route }];
  });
  return { instanceId: instanceId(), connections };
}
function decodeInput(raw: any): CallInput {
  return { method: String(raw?.method ?? 'GET'), url: String(raw?.url ?? ''), pathParams: raw?.pathParams, query: raw?.query, headers: raw?.headers,
    body: raw?.body == null ? null : raw.bodyEncoding === 'base64' ? Buffer.from(String(raw.body), 'base64') : String(raw.body) };
}
function upstreamCaller(upstreamId: string, upstreamUserId: string, raw: any): Caller {
  const source = auditSources.has(raw?.source) ? raw.source as AuditSource : 'call';
  return { source, upstreamId, upstreamUserId: upstreamUserId.slice(0, 200),
    tokenId: `upstream:${upstreamId}:${typeof raw?.tokenId === 'string' ? raw.tokenId.slice(0, 200) : 'web:' + upstreamUserId.slice(0, 200)}`,
    tokenName: `Upstream: ${typeof raw?.tokenName === 'string' ? raw.tokenName.slice(0, 200) : 'Web console'}`,
    ip: typeof raw?.ip === 'string' ? raw.ip.slice(0, 100) : null, userAgent: typeof raw?.userAgent === 'string' ? raw.userAgent.slice(0, 300) : 'Upstream Switchboard',
    savedCall: typeof raw?.savedCall === 'string' ? raw.savedCall.slice(0, 200) : undefined };
}
export async function handleSharedRequest(upstreamId: string, upstreamUserId: string, operation: string, payload: any, signal?: AbortSignal) {
  if (!SATELLITE_OPERATIONS.has(operation)) throw new HttpError(403, 'Upstreams may only execute explicitly shared connections');
  if (!payload || typeof payload.connection !== 'string') throw new HttpError(400, 'A shared connection id is required');
  const row = sharedConnection(upstreamId, payload.connection);
  const user = getUser(row.user_id)!;
  const caller = upstreamCaller(upstreamId, upstreamUserId, payload.caller);
  if (operation === 'mcp') return executeMcp(user, row.id, payload.input, signal, caller);
  if (operation === 'openapi') {
    if (row.satellite_id) {
      const { requestSatellite } = await import('./satellites.ts');
      return requestSatellite(row.satellite_id, user.id, 'openapi', { connection: row.remote_connection_id, refresh: !!payload.refresh }, 120_000, signal);
    }
    const { conn, service } = loadConnection(user.id, row.id); return describe(service, conn, !!payload.refresh);
  }
  const ex = await execute(user, row.id, decodeInput(payload.input), signal, caller);
  const reader = ex.response.body?.getReader(); const chunks: Buffer[] = []; let size = 0;
  if (reader) try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new HttpError(502, 'Satellite response exceeded the size limit'); }
      chunks.push(Buffer.from(chunk.value)); }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks); if (ex.auditId) setResponseSize(ex.auditId, body.length);
  return { status: ex.response.status, statusText: ex.response.statusText, headers: [...ex.response.headers.entries()], body: body.toString('base64'),
    url: ex.url.toString(), durationMs: ex.durationMs,
    sent: { ...ex.sent, body: ex.sent.body == null ? undefined : Buffer.from(ex.sent.body as any).toString('base64'), bodyEncoding: ex.sent.body == null ? undefined : 'base64' } };
}

interface Agent { fingerprint: string; stop(): void; refresh(): void }
export function startSatelliteAgent() {
  const agents = new Map<string, Agent>(); let stopped = false;
  const start = (row: any): Agent => {
    const status = { state: 'connecting' as 'connecting' | 'online' | 'offline' | 'disabled', connectedAt: null as number | null, lastSeenAt: null as number | null, lastError: null as string | null, nextRetryAt: null as number | null };
    upstreamStatuses.set(row.id, status);
    let closed = false; let socket: WebSocket | undefined; let heartbeat: NodeJS.Timeout | undefined; let catalogTimer: NodeJS.Timeout | undefined; let retry: NodeJS.Timeout | undefined;
    let retryMs = 1000; let sentCatalog = ''; let targetInstance: string | undefined; let welcomed = false;
    const inFlight = new Map<string, { controller: AbortController; connection: string }>();
    const refresh = () => {
      for (const active of inFlight.values()) { try { sharedConnection(row.id, active.connection); } catch { active.controller.abort(); } }
      if (!welcomed || socket?.readyState !== WebSocket.OPEN) return;
      const catalog = sharedCatalogue(row.id, targetInstance); const serialized = JSON.stringify(catalog);
      if (serialized === sentCatalog) return; sentCatalog = serialized;
      socket.send(JSON.stringify({ protocol: SATELLITE_PROTOCOL, type: 'catalog', version: String(Date.now()), catalog }));
    };
    const unlisten = onConnectionChange(id => { for (const active of inFlight.values()) if (!id || active.connection === id) active.controller.abort(); refresh(); });
    const connect = () => {
      if (closed) return;
      status.state = 'connecting'; status.nextRetryAt = null;
      const current = new WebSocket(socketUrl(row.url), { maxPayload: SATELLITE_MAX_MESSAGE, headers: { authorization: `Bearer ${upstreamToken(row)}`, 'x-switchboard-satellite-protocol': String(SATELLITE_PROTOCOL) } });
      socket = current;
      current.on('message', async data => {
        let message: any; try { message = JSON.parse(String(data)); } catch { current.close(1007, 'Invalid JSON'); return; }
        if (message.protocol !== SATELLITE_PROTOCOL) { status.lastError = 'Upgrade both Switchboards to satellite protocol 2'; current.close(1008, 'Satellite protocol 2 required'); return; }
        if (message.type === 'welcome') {
          if (welcomed || typeof message.instanceId !== 'string' || message.instanceId === instanceId()) { current.close(1008, 'Invalid upstream identity'); return; }
          targetInstance = message.instanceId; welcomed = true; retryMs = 1000;
          Object.assign(status, { state: 'online', connectedAt: Date.now(), lastSeenAt: Date.now(), lastError: null, nextRetryAt: null });
          refresh(); catalogTimer = setInterval(refresh, 2000);
          heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) { current.send(JSON.stringify({ protocol: SATELLITE_PROTOCOL, type: 'heartbeat' })); status.lastSeenAt = Date.now(); } }, 20_000);
          return;
        }
        if (!welcomed) { current.close(1008, 'Expected welcome'); return; }
        if (message.type === 'catalog.rejected') { status.lastError = String(message.error ?? 'Shared catalogue rejected'); return; }
        if (message.type === 'cancel') { inFlight.get(message.requestId)?.controller.abort(); return; }
        if (message.type !== 'request') return;
        if (typeof message.requestId !== 'string' || message.requestId.length > 100 || inFlight.has(message.requestId) || inFlight.size >= 100) { current.close(1008, 'Invalid request id or too many pending requests'); return; }
        const controller = new AbortController(); inFlight.set(message.requestId, { controller, connection: message.payload?.connection });
        try {
          const route = acceptRoute(message.route, message.deadline);
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, route.deadline - Date.now()))]);
          const result = await satelliteRoute.run(route, () => handleSharedRequest(row.id, String(message.userId ?? ''), String(message.operation), message.payload, signal));
          if (current.readyState === WebSocket.OPEN) {
            const response = JSON.stringify({ protocol: SATELLITE_PROTOCOL, type: 'result', requestId: message.requestId, result });
            if (Buffer.byteLength(response) > SATELLITE_MAX_MESSAGE) throw new HttpError(502, 'Satellite result exceeded the message limit');
            current.send(response);
          }
        } catch (error: any) {
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ protocol: SATELLITE_PROTOCOL, type: 'error', requestId: message.requestId, status: error?.status ?? 502, error: String(error?.message ?? error).slice(0, 500) }));
        } finally { inFlight.delete(message.requestId); }
      });
      current.on('close', () => {
        for (const active of inFlight.values()) active.controller.abort(); inFlight.clear();
        if (heartbeat) clearInterval(heartbeat); if (catalogTimer) clearInterval(catalogTimer); sentCatalog = ''; welcomed = false;
        if (!closed) { const delay = retryMs + Math.floor(Math.random() * Math.min(retryMs, 5000)); Object.assign(status, { state: 'offline', connectedAt: null, nextRetryAt: Date.now() + delay }); retry = setTimeout(connect, delay); retryMs = Math.min(retryMs * 2, 60_000); }
      });
      current.on('error', error => { status.lastError = error.message; });
    };
    connect();
    return { fingerprint: JSON.stringify([row.url, row.token_enc, row.enabled]), refresh,
      stop() { closed = true; unlisten(); for (const active of inFlight.values()) active.controller.abort(); if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat); if (catalogTimer) clearInterval(catalogTimer); socket?.close(1000, 'Upstream stopped'); } };
  };
  const reconcile = () => {
    if (stopped) return;
    const rows = configuredUpstreams();
    for (const [id, agent] of agents) if (!rows.some(row => row.id === id && row.enabled && agent.fingerprint === JSON.stringify([row.url, row.token_enc, row.enabled]))) { agent.stop(); agents.delete(id); upstreamStatuses.delete(id); }
    for (const row of rows) {
      if (!row.enabled) continue;
      if (!agents.has(row.id)) agents.set(row.id, start(row)); else agents.get(row.id)!.refresh();
    }
  };
  const unlisten = onUpstreamsChanged(reconcile); reconcile();
  return () => { stopped = true; unlisten(); for (const agent of agents.values()) agent.stop(); agents.clear(); upstreamStatuses.clear(); };
}
