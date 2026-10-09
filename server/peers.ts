import { configuredPeerLinks, onPeersChanged, peersChanged, peerStatuses, peerToken, sharedConnection, validPeerName, validPeerUrl, type PeerStatus } from './peer-settings.ts';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { encrypt, randomId, randomToken, sha256 } from './crypto.ts';
import { all, db, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import { connectionChanged, onConnectionChange } from './connection-events.ts';
import { acceptRoute, peerRoute, instanceId, forwardingRoute, PEER_PROTOCOL, PEER_MAX_MESSAGE, PEER_OPERATIONS, MAX_PEER_HOPS } from './peer-protocol.ts';

const PROTOCOL = PEER_PROTOCOL;
const REQUEST_TIMEOUT = 120_000;
const MAX_MESSAGE = PEER_MAX_MESSAGE;

export interface PeerConnection {
  id: string; name: string; serviceId: string; serviceName: string; kind: 'http' | 'mcp';
  icon?: string; hasOpenapi: boolean; status: 'ok' | 'error' | 'unavailable'; route: string[];
}

interface Session {
  socket: WebSocket;
  peerId: string;
  connectedAt: number;
  lastHeartbeat: number;
  remoteInstance?: string;
  dispose(): void;
  inFlight: Map<string, { controller: AbortController; connection: string }>;
  pending: Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
}

const sessions = new Map<string, Session>();

function view(r: any) {
  const session = sessions.get(r.id);
  return {
    id: r.id,
    name: r.name,
    ownerUserId: r.owner_user_id,
    disabled: !!r.disabled,
    direction: r.direction, url: r.url, remoteInstanceId: r.remote_instance_id,
    sharedConnections: one('SELECT COUNT(*) AS n FROM connection_peer_shares WHERE peer_id = ?', r.id).n,
    state: r.disabled ? 'disabled' : session ? 'online' : peerStatuses.get(r.id)?.state ?? 'offline',
    lastError: peerStatuses.get(r.id)?.lastError ?? null, nextRetryAt: peerStatuses.get(r.id)?.nextRetryAt ?? null,
    online: !!session && session.socket.readyState === WebSocket.OPEN,
    connectedAt: session?.connectedAt ?? null,
    lastSeenAt: r.last_seen_at ?? null,
    catalogVersion: r.catalog_version ?? null,
    connections: catalog(r).connections,
    userIds: all<{ user_id: string }>('SELECT user_id FROM peer_users WHERE peer_id = ? ORDER BY user_id', r.id).map((x) => x.user_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function catalog(r: any): { connections: PeerConnection[] } {
  try { const parsed = JSON.parse(r.catalog_json ?? '{}'); return { connections: Array.isArray(parsed.connections) ? parsed.connections : [] }; }
  catch { return { connections: [] }; }
}

/** Materialized per-user handles retain existing ids and saved calls, without provider secrets. */
export function syncPeerConnections(userId: string) {
  const peers = all(`SELECT s.* FROM peers s JOIN peer_users su ON su.peer_id = s.id
    JOIN users u ON u.id = su.user_id WHERE su.user_id = ? AND s.disabled = 0 AND u.disabled = 0`, userId);
  for (const peer of peers) for (const c of catalog(peer).connections) {
    const existing = one('SELECT * FROM connections WHERE user_id = ? AND peer_id = ? AND remote_connection_id = ?', userId, peer.id, c.id);
    const t = now();
    if (existing) {
      if (existing.kind !== c.kind || existing.status !== c.status) connectionChanged(existing.id);
      run('UPDATE connections SET kind = ?, status = ?, config_enc = NULL, credentials_enc = NULL, account_id = NULL, account_label = NULL, account_avatar = NULL WHERE id = ?', c.kind, c.status, existing.id);
      continue;
    }
    const base = c.name.replace(/[^a-zA-Z0-9._@+-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'shared';
    let name = base;
    for (let n = 2; one('SELECT 1 FROM connections WHERE user_id = ? AND name = ?', userId, name); n++) name = `${base}-${n}`;
    run(`INSERT INTO connections (id, user_id, service_id, method_id, name, status, created_at, updated_at, peer_id, remote_connection_id, kind)
      VALUES (?, ?, ?, 'shared', ?, ?, ?, ?, ?, ?, ?)`, randomId('c'), userId, remoteServiceId(peer.id, c.serviceId), name, c.status, t, t, peer.id, c.id, c.kind);
  }
}

export function peerConnection(userId: string, peerId: string, connectionId: string): PeerConnection {
  if (!userCanUsePeer(userId, peerId)) throw new HttpError(403, 'You cannot use this peer');
  const row = one('SELECT * FROM peers WHERE id = ?', peerId);
  const c = row && catalog(row).connections.find(c => c.id === connectionId);
  if (!c) throw new HttpError(403, 'This connection is no longer shared by the peer');
  return c;
}

export function listPeers() {
  return all('SELECT * FROM peers WHERE removed = 0 ORDER BY name COLLATE NOCASE').map(view);
}

export function getPeer(id: string) {
  const r = one('SELECT * FROM peers WHERE id = ?', id);
  if (!r || r.removed) throw notFound('Peer not found');
  return view(r);
}

export function createPeer(name: string, ownerUserId: string) {
  name = String(name ?? '').trim();
  if (!name || name.length > 100) throw badRequest('Give the peer a name of at most 100 characters');
  if (!one('SELECT 1 FROM users WHERE id = ? AND disabled = 0', ownerUserId)) throw badRequest('Unknown owner');
  if (one('SELECT 1 FROM peers WHERE name = ? AND removed = 0', name)) throw badRequest('A peer already has that name');
  const id = randomId('peer');
  const token = `swp_${randomToken(32)}`;
  const t = now();
  run('INSERT INTO peers (id, name, owner_user_id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, ownerUserId, sha256(token), t, t);
  run('INSERT INTO peer_users (peer_id, user_id, created_at) VALUES (?, ?, ?)', id, ownerUserId, t);
  peersChanged();
  return { peer: getPeer(id), token };
}

export function rotatePeerToken(id: string) {
  const current = getPeer(id);
  if (current.direction !== 'incoming') throw badRequest('Rotate the token on the peer that accepted this connection');
  const token = `swp_${randomToken(32)}`;
  run('UPDATE peers SET token_hash = ?, updated_at = ? WHERE id = ?', sha256(token), now(), id);
  closeSession(id, 4001, 'Credentials rotated');
  return { token };
}

export function updatePeer(id: string, patch: { name?: string; disabled?: boolean; userIds?: string[]; url?: string; token?: string }) {
  const current = getPeer(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Expected a peer object');
  if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') throw badRequest('disabled must be a boolean');
  const name = patch.name === undefined ? current.name : validPeerName(patch.name, id);
  let url: string | undefined; let token: string | undefined; let ids: string[] | undefined;
  if (patch.url !== undefined || patch.token !== undefined) {
    if (current.direction !== 'outgoing') throw badRequest('Only outgoing peers have a URL and saved token');
    if (patch.url !== undefined) url = validPeerUrl(patch.url);
    if (patch.token !== undefined && patch.token !== '') {
      if (typeof patch.token !== 'string' || !patch.token.trim()) throw badRequest('A peer token is required');
      token = encrypt(patch.token.trim());
    }
  }
  if (patch.userIds !== undefined) {
    if (!Array.isArray(patch.userIds) || patch.userIds.length > 1000 || patch.userIds.some(id => typeof id !== 'string')) throw badRequest('userIds must be an array of user ids');
    ids = [...new Set([...patch.userIds, current.ownerUserId])];
    for (const userId of ids) if (!one('SELECT 1 FROM users WHERE id = ?', userId)) throw badRequest(`Unknown user "${userId}"`);
  }
  db.exec('BEGIN');
  try {
    run('UPDATE peers SET name = ?, disabled = ?, updated_at = ? WHERE id = ?', name, +(patch.disabled ?? current.disabled), now(), id);
    if (url !== undefined) run('UPDATE peers SET url = ? WHERE id = ?', url, id);
    if (token !== undefined) run('UPDATE peers SET token_enc = ? WHERE id = ?', token, id);
    if (ids) { run('DELETE FROM peer_users WHERE peer_id = ?', id); for (const userId of ids) run('INSERT INTO peer_users(peer_id, user_id, created_at) VALUES (?, ?, ?)', id, userId, now()); }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (ids || patch.disabled) connectionChanged();
  if (patch.disabled) closeSession(id, 4001, 'Peer disabled');
  peersChanged(); return getPeer(id);
}

export function deletePeer(id: string) {
  getPeer(id);
  closeSession(id, 4001, 'Peer removed');
  connectionChanged();
  run('DELETE FROM peer_users WHERE peer_id = ?', id);
  run('UPDATE peers SET disabled = 1, removed = 1, name = ?, catalog_json = NULL WHERE id = ?', `removed-${id}`, id);
  // Preserve imported handles referenced by saved calls; this tombstone cannot reconnect.
  run('UPDATE peers SET token_hash = ? WHERE id = ?', sha256(randomToken(32)), id);
  run('DELETE FROM connection_peer_shares WHERE peer_id = ?', id);
  peersChanged();
}

export function userCanUsePeer(userId: string, peerId: string) {
  return !!one(
    `SELECT 1 FROM peers s JOIN peer_users su ON su.peer_id = s.id
     WHERE s.id = ? AND su.user_id = ? AND s.disabled = 0 AND s.removed = 0 AND EXISTS(SELECT 1 FROM users u WHERE u.id = su.user_id AND u.disabled = 0)`,
    peerId, userId,
  );
}

export const remoteServiceId = (peerId: string, serviceId: string) => `peer/${peerId}/${serviceId}`;

export function parseRemoteServiceId(value: string): { peerId: string; serviceId: string } | undefined {
  const m = value.match(/^peer\/([A-Za-z0-9_-]+)\/(.+)$/);
  return m ? { peerId: m[1], serviceId: m[2] } : undefined;
}

export function validatePeerCatalog(value: any): { instanceId: string; connections: PeerConnection[] } {
  if (!value || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 100 || value.instanceId === instanceId() || !Array.isArray(value.connections) || value.connections.length > 1000) throw new Error('Invalid peer connection catalogue');
  const seen = new Set<string>();
  const connections = value.connections.map((c: any) => {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || seen.has(c.id)) throw new Error('Invalid or duplicate shared connection id');
    if (typeof c.name !== 'string' || !c.name.trim() || typeof c.serviceId !== 'string' || !c.serviceId || c.serviceId.length > 200 || typeof c.serviceName !== 'string' || !c.serviceName) throw new Error('Invalid shared connection');
    if (!['http', 'mcp'].includes(c.kind) || !['ok', 'error', 'unavailable'].includes(c.status)) throw new Error('Invalid shared connection kind or status');
    if (!Array.isArray(c.route) || !c.route.length || c.route.length > MAX_PEER_HOPS || c.route.some((id: any) => typeof id !== 'string' || !id || id.length > 100) || new Set(c.route).size !== c.route.length || c.route.includes(instanceId()) || c.route.at(-1) !== value.instanceId) throw new Error('Peer route contains a loop');
    seen.add(c.id);
    return { id: c.id, name: c.name.slice(0, 100), serviceId: c.serviceId, serviceName: c.serviceName.slice(0, 100), kind: c.kind, status: c.status,
      hasOpenapi: !!c.hasOpenapi, icon: typeof c.icon === 'string' && c.icon.length <= 100_000 ? c.icon : undefined, route: [...c.route] };
  });
  return { instanceId: value.instanceId, connections };
}

function closeSession(id: string, code: number, reason: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.dispose();
  for (const p of session.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(503, `${reason}; the request outcome may be unknown`)); }
  session.pending.clear();
  for (const active of session.inFlight.values()) active.controller.abort();
  session.inFlight.clear();
  session.socket.close(code, reason.slice(0, 123));
}

function bindIdentity(id: string, remote: unknown): string {
  if (typeof remote !== 'string' || !remote || remote.length > 100 || remote === instanceId()) throw new Error('Invalid peer identity');
  const row = one('SELECT remote_instance_id FROM peers WHERE id = ? AND removed = 0 AND disabled = 0', id);
  if (!row || (row.remote_instance_id && row.remote_instance_id !== remote)) throw new Error('Peer identity changed; remove and pair again');
  run('UPDATE peers SET remote_instance_id = ? WHERE id = ?', remote, id);
  return remote;
}

/** Both incoming and outgoing sockets use the same catalogue, execution and cancellation paths. */
function registerSession(socket: WebSocket, peerId: string, remote?: string) {
  closeSession(peerId, 4000, 'Replaced by a new connection');
  const session: Session = { socket, peerId, connectedAt: now(), lastHeartbeat: now(), pending: new Map(), inFlight: new Map(), remoteInstance: remote, dispose: () => {} };
  if (remote) bindIdentity(peerId, remote);
  sessions.set(peerId, session);
  let sentCatalog = '';
  const send = (message: any) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocol: PROTOCOL, ...message })); };
  const refresh = async () => {
    if (!session.remoteInstance || socket.readyState !== WebSocket.OPEN) return;
    const { sharedCatalogue } = await import('./peer-agent.ts');
    if (sessions.get(peerId) !== session) return;
    const catalog = sharedCatalogue(peerId, session.remoteInstance); const serialized = JSON.stringify(catalog);
    if (serialized === sentCatalog) return;
    sentCatalog = serialized; send({ type: 'catalog', version: String(now()), catalog });
  };
  const unlisten = onConnectionChange(id => {
    for (const active of session.inFlight.values()) if (!id || active.connection === id) active.controller.abort();
    void refresh();
  });
  const unshare = onPeersChanged(() => {
    const row = one('SELECT * FROM peers WHERE id = ?', peerId);
    if (!row || row.disabled || row.removed) { closeSession(peerId, 4001, 'Peer disabled or removed'); return; }
    for (const active of session.inFlight.values()) { try { sharedConnection(peerId, active.connection); } catch { active.controller.abort(); } }
    void refresh();
  });
  const timer = setInterval(() => {
    if (session.lastHeartbeat < now() - 70_000) { closeSession(peerId, 4000, 'Heartbeat expired'); return; }
    send({ type: 'heartbeat' }); void refresh();
  }, 20_000); timer.unref();
  session.dispose = () => { clearInterval(timer); unlisten(); unshare(); };
  socket.on('message', async raw => {
    let message: any;
    try { message = JSON.parse(String(raw)); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (message?.protocol !== PROTOCOL || typeof message.type !== 'string') { socket.close(1008, 'Unsupported peer protocol'); return; }
    session.lastHeartbeat = now(); run('UPDATE peers SET last_seen_at = ? WHERE id = ?', session.lastHeartbeat, peerId);
    if (message.type === 'heartbeat') return;
    if (message.type === 'catalog') {
      try {
        const value = validatePeerCatalog(message.catalog);
        session.remoteInstance = bindIdentity(peerId, value.instanceId);
        const previous = one('SELECT * FROM peers WHERE id = ?', peerId);
        if (JSON.stringify(catalog(previous)) !== JSON.stringify({ connections: value.connections })) {
          for (const row of all('SELECT id FROM connections WHERE peer_id = ?', peerId)) connectionChanged(row.id);
        }
        run('UPDATE peers SET catalog_json = ?, catalog_version = ?, updated_at = ? WHERE id = ?', JSON.stringify(value), String(message.version ?? '').slice(0, 100) || null, now(), peerId);
        send({ type: 'catalog.accepted', version: message.version ?? null }); void refresh();
      } catch (error: any) { send({ type: 'catalog.rejected', error: String(error.message).slice(0, 500) }); socket.close(1008, 'Invalid peer catalogue or identity'); }
      return;
    }
    if (!session.remoteInstance) { socket.close(1008, 'Expected peer identity catalogue'); return; }
    if (message.type === 'result' || message.type === 'error') {
      const pending = session.pending.get(String(message.requestId)); if (!pending) return;
      session.pending.delete(String(message.requestId)); clearTimeout(pending.timer);
      if (message.type === 'error') pending.reject(new HttpError(Number.isInteger(message.status) && message.status >= 400 && message.status <= 599 ? message.status : 502, String(message.error ?? 'Peer request failed').slice(0, 2000)));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === 'cancel') { session.inFlight.get(message.requestId)?.controller.abort(); return; }
    if (message.type === 'catalog.rejected') { socket.close(1008, 'Peer rejected catalogue'); return; }
    if (message.type !== 'request') return;
    if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100 || session.inFlight.has(message.requestId) || session.inFlight.size >= 100) { socket.close(1008, 'Invalid request id or too many pending requests'); return; }
    const controller = new AbortController(); session.inFlight.set(message.requestId, { controller, connection: message.payload?.connection });
    try {
      const route = acceptRoute(message.route, message.deadline);
      if (route.path.at(-1) !== session.remoteInstance) throw new HttpError(403, 'Request route does not match authenticated peer');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, route.deadline - now()))]);
      const { handleSharedRequest } = await import('./peer-agent.ts');
      const result = await peerRoute.run(route, () => handleSharedRequest(peerId, String(message.userId ?? ''), String(message.operation), message.payload, signal));
      if (signal.aborted) throw new HttpError(499, 'Peer request cancelled; the outcome may be unknown');
      const response = JSON.stringify({ protocol: PROTOCOL, type: 'result', requestId: message.requestId, result });
      if (Buffer.byteLength(response) > MAX_MESSAGE) throw new HttpError(502, 'Peer result exceeded the message limit');
      if (socket.readyState === WebSocket.OPEN) socket.send(response);
    } catch (error: any) { send({ type: 'error', requestId: message.requestId, status: error?.status ?? 502, error: String(error?.message ?? error).slice(0, 500) }); }
    finally { session.inFlight.delete(message.requestId); }
  });
  socket.on('close', () => { if (sessions.get(peerId) === session) closeSession(peerId, 1000, 'Peer disconnected'); });
  socket.on('error', () => {});
  void refresh();
  return session;
}

export function attachPeerWebSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    // Explicit upgrade rejection for the historical protocol endpoint.
    if (pathname === '/api/satellites/connect') { socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUpgrade both Switchboards to peer protocol 3'); socket.destroy(); return; }
    if (pathname !== '/api/peers/connect') return;
    if (request.headers['x-switchboard-peer-protocol'] !== String(PROTOCOL)) { socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUpgrade both Switchboards to peer protocol 3'); socket.destroy(); return; }
    const header = request.headers.authorization; const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const row = token && one("SELECT * FROM peers WHERE token_hash = ? AND direction = 'incoming' AND removed = 0 AND disabled = 0", sha256(token));
    if (!row) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      registerSession(ws, row.id);
      ws.send(JSON.stringify({ protocol: PROTOCOL, type: 'welcome', instanceId: instanceId(), peerId: row.id, heartbeatSeconds: 20, maxMessageBytes: MAX_MESSAGE }));
    });
  });
  return () => { for (const id of [...sessions.keys()]) closeSession(id, 1001, 'Server stopping'); wss.close(); };
}

export function startPeerAgent() {
  const clients = new Map<string, { fingerprint: string; stop(): void }>();
  const reconcile = () => {
    const rows = configuredPeerLinks();
    const fingerprint = (row: any) => JSON.stringify([row.url, row.token_enc, row.disabled]);
    for (const [id, client] of clients) if (!rows.some(row => row.id === id && !row.disabled && client.fingerprint === fingerprint(row))) { client.stop(); clients.delete(id); peerStatuses.delete(id); }
    for (const row of rows) {
      if (row.disabled || clients.has(row.id)) continue;
      let stopped = false; let socket: WebSocket | undefined; let retry: NodeJS.Timeout | undefined; let retryMs = 1000;
      const status: PeerStatus = { state: 'connecting', connectedAt: null, lastSeenAt: null, lastError: null, nextRetryAt: null }; peerStatuses.set(row.id, status);
      const connect = () => {
        if (stopped) return;
        status.state = 'connecting'; status.nextRetryAt = null;
        const url = new URL(row.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/api/peers/connect';
        const current = new WebSocket(url, { maxPayload: MAX_MESSAGE, headers: { authorization: `Bearer ${peerToken(row)}`, 'x-switchboard-peer-protocol': String(PROTOCOL) } }); socket = current;
        const welcomeTimer = setTimeout(() => current.close(1008, 'Peer handshake timed out'), 15_000); welcomeTimer.unref();
        current.once('message', raw => {
          clearTimeout(welcomeTimer);
          try {
            const message = JSON.parse(String(raw));
            if (message.protocol !== PROTOCOL || message.type !== 'welcome') throw new Error('Upgrade both Switchboards to peer protocol 3');
            registerSession(current, row.id, bindIdentity(row.id, message.instanceId)); retryMs = 1000;
            Object.assign(status, { state: 'online', connectedAt: now(), lastSeenAt: now(), lastError: null });
          } catch (error: any) { status.lastError = error.message; current.close(1008, 'Peer handshake failed'); }
        });
        current.on('error', error => { status.lastError = error.message; });
        current.on('close', () => {
          clearTimeout(welcomeTimer);
          if (stopped) return;
          const delay = retryMs + Math.floor(Math.random() * Math.min(retryMs, 5000));
          Object.assign(status, { state: 'offline', connectedAt: null, nextRetryAt: now() + delay }); retry = setTimeout(connect, delay); retryMs = Math.min(retryMs * 2, 60_000);
        });
      };
      clients.set(row.id, { fingerprint: fingerprint(row), stop() { stopped = true; if (retry) clearTimeout(retry); closeSession(row.id, 1000, 'Peer stopped'); socket?.close(); } }); connect();
    }
  };
  const unlisten = onPeersChanged(reconcile); reconcile();
  return () => { unlisten(); for (const client of clients.values()) client.stop(); clients.clear(); peerStatuses.clear(); };
}

export async function requestPeer<T>(peerId: string, userId: string, operation: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT, signal?: AbortSignal): Promise<T> {
  if (!PEER_OPERATIONS.has(operation)) throw new HttpError(403, 'Peers may only execute explicitly shared connections');
  const remote = (payload as any)?.connection;
  if (typeof remote !== 'string') throw badRequest('A shared connection id is required');
  const descriptor = peerConnection(userId, peerId, remote);
  if (descriptor.status !== 'ok') throw new HttpError(503, 'The shared connection is unavailable on its peer');
  if (signal?.aborted) throw new HttpError(499, 'Request cancelled; the outcome may be unknown');
  if (!userCanUsePeer(userId, peerId)) throw new HttpError(403, 'You cannot use this peer');
  const peer = getPeer(peerId);
  const session = sessions.get(peerId);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    const error = new HttpError(503, `${peer.name} is offline${peer.lastSeenAt ? ` (last seen ${new Date(peer.lastSeenAt).toISOString()})` : ''}`) as HttpError & { code?: string };
    error.code = 'peer_offline';
    throw error;
  }
  if (session.pending.size >= 100) throw new HttpError(429, 'Too many pending peer requests');
  const requestId = randomId('pr');
  const handles = new Set(all<{ id: string }>('SELECT id FROM connections WHERE peer_id = ? AND remote_connection_id = ?', peerId, remote).map(c => c.id));
  const { path: route, deadline } = forwardingRoute(timeoutMs);
  return new Promise<T>((resolve, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => { signal?.removeEventListener('abort', abort); unsubscribe(); };
    const cancel = () => {
      session.pending.delete(requestId);
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'cancel', requestId }));
    };
    const abort = () => {
      clearTimeout(timer);
      cancel();
      cleanup();
      reject(new HttpError(499, 'Request cancelled; the peer outcome may be unknown'));
    };
    const timer = setTimeout(() => {
      cancel();
      cleanup();
      reject(new HttpError(504, `Request to ${peer.name} timed out; the outcome may be unknown`));
    }, deadline - now());
    session.pending.set(requestId, {
      resolve: value => { cleanup(); resolve(value); },
      reject: error => { cleanup(); reject(error); }, timer,
    });
    unsubscribe = onConnectionChange(id => { if (!id || handles.has(id)) abort(); });
    signal?.addEventListener('abort', abort, { once: true });
    session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'request', requestId, userId, operation, deadline, route, payload }));
  });
}
