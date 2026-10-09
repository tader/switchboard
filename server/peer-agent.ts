import { toView, loadConnection } from './connections.ts';
import { plugins } from './plugins/manager.ts';
import { execute, type CallInput } from './proxy.ts';
import { setResponseSize, type AuditSource, type Caller } from './audit.ts';
import { describe } from './openapi.ts';
import { getUser } from './users.ts';
import { all } from './db.ts';
import { executeMcp } from './provider-mcp.ts';
import { sharedConnection } from './peer-settings.ts';
import { peerConnection } from './peers.ts';
import { instanceId, MAX_PEER_HOPS, PEER_OPERATIONS } from './peer-protocol.ts';
import { HttpError } from './http.ts';

const auditSources = new Set<AuditSource>(['proxy', 'call', 'saved-call', 'console', 'token', 'mcp']);
export function sharedCatalogue(peerId: string, targetInstance?: string) {
  const connections = all(`SELECT c.* FROM connections c JOIN connection_peer_shares sh ON sh.connection_id = c.id
    JOIN users u ON u.id = c.user_id WHERE sh.peer_id = ? AND u.disabled = 0 AND u.peer_shadow = 0 ORDER BY c.id`, peerId).flatMap(row => {
    const c = toView(row);
    let route = [instanceId()];
    if (row.peer_id) {
      try { route = [...peerConnection(row.user_id, row.peer_id, row.remote_connection_id).route, instanceId()]; }
      catch { return []; }
    }
    if (route.length > MAX_PEER_HOPS || new Set(route).size !== route.length || (targetInstance && route.includes(targetInstance))) return [];
    return [{ id: row.id, name: c.name, serviceId: c.serviceId, serviceName: c.serviceName, kind: c.kind,
      icon: row.peer_id ? peerConnection(row.user_id, row.peer_id, row.remote_connection_id).icon : plugins.service(c.serviceId)?.icon,
      hasOpenapi: c.hasOpenapi, status: c.status, route }];
  });
  return { instanceId: instanceId(), connections };
}
function decodeInput(raw: any): CallInput {
  return { method: String(raw?.method ?? 'GET'), url: String(raw?.url ?? ''), pathParams: raw?.pathParams, query: raw?.query, headers: raw?.headers,
    body: raw?.body == null ? null : raw.bodyEncoding === 'base64' ? Buffer.from(String(raw.body), 'base64') : String(raw.body) };
}
function peerCaller(peerId: string, peerUserId: string, raw: any): Caller {
  const source = auditSources.has(raw?.source) ? raw.source as AuditSource : 'call';
  return { source, peerId, peerUserId: peerUserId.slice(0, 200),
    tokenId: `peer:${peerId}:${typeof raw?.tokenId === 'string' ? raw.tokenId.slice(0, 200) : 'web:' + peerUserId.slice(0, 200)}`,
    tokenName: `Peer: ${typeof raw?.tokenName === 'string' ? raw.tokenName.slice(0, 200) : 'Web console'}`,
    ip: typeof raw?.ip === 'string' ? raw.ip.slice(0, 100) : null, userAgent: typeof raw?.userAgent === 'string' ? raw.userAgent.slice(0, 300) : 'Peer Switchboard',
    savedCall: typeof raw?.savedCall === 'string' ? raw.savedCall.slice(0, 200) : undefined };
}
export async function handleSharedRequest(peerId: string, peerUserId: string, operation: string, payload: any, signal?: AbortSignal) {
  if (!PEER_OPERATIONS.has(operation)) throw new HttpError(403, 'Peers may only execute explicitly shared connections');
  if (!payload || typeof payload.connection !== 'string') throw new HttpError(400, 'A shared connection id is required');
  const row = sharedConnection(peerId, payload.connection);
  const user = getUser(row.user_id)!;
  const caller = peerCaller(peerId, peerUserId, payload.caller);
  if (operation === 'mcp') return executeMcp(user, row.id, payload.input, signal, caller);
  if (operation === 'openapi') {
    if (row.peer_id) {
      const { requestPeer } = await import('./peers.ts');
      return requestPeer(row.peer_id, user.id, 'openapi', { connection: row.remote_connection_id, refresh: !!payload.refresh }, 120_000, signal);
    }
    const { conn, service } = loadConnection(user.id, row.id); return describe(service, conn, !!payload.refresh);
  }
  const ex = await execute(user, row.id, decodeInput(payload.input), signal, caller);
  const reader = ex.response.body?.getReader(); const chunks: Buffer[] = []; let size = 0;
  if (reader) try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new HttpError(502, 'Peer response exceeded the size limit'); }
      chunks.push(Buffer.from(chunk.value)); }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks); if (ex.auditId) setResponseSize(ex.auditId, body.length);
  return { status: ex.response.status, statusText: ex.response.statusText, headers: [...ex.response.headers.entries()], body: body.toString('base64'),
    url: ex.url.toString(), durationMs: ex.durationMs,
    sent: { ...ex.sent, body: ex.sent.body == null ? undefined : Buffer.from(ex.sent.body as any).toString('base64'), bodyEncoding: ex.sent.body == null ? undefined : 'base64' } };
}
