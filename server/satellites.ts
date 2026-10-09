import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomId, randomToken, sha256 } from './crypto.ts';
import { all, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import { connectionChanged, onConnectionChange } from './connection-events.ts';
import { instanceId, forwardingRoute, SATELLITE_PROTOCOL, SATELLITE_MAX_MESSAGE, SATELLITE_OPERATIONS, MAX_SATELLITE_HOPS } from './satellite-protocol.ts';

const PROTOCOL = SATELLITE_PROTOCOL;
const REQUEST_TIMEOUT = 120_000;
const MAX_MESSAGE = SATELLITE_MAX_MESSAGE;

export interface SatelliteConnection {
  id: string; name: string; serviceId: string; serviceName: string; kind: 'http' | 'mcp';
  icon?: string; hasOpenapi: boolean; status: 'ok' | 'error' | 'unavailable'; route: string[];
}

interface Session {
  socket: WebSocket;
  satelliteId: string;
  connectedAt: number;
  lastHeartbeat: number;
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
    online: !!session && session.socket.readyState === WebSocket.OPEN,
    connectedAt: session?.connectedAt ?? null,
    lastSeenAt: r.last_seen_at ?? null,
    catalogVersion: r.catalog_version ?? null,
    connections: catalog(r).connections,
    userIds: all<{ user_id: string }>('SELECT user_id FROM satellite_users WHERE satellite_id = ? ORDER BY user_id', r.id).map((x) => x.user_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function catalog(r: any): { connections: SatelliteConnection[] } {
  try { const parsed = JSON.parse(r.catalog_json ?? '{}'); return { connections: Array.isArray(parsed.connections) ? parsed.connections : [] }; }
  catch { return { connections: [] }; }
}

/** Materialized per-user handles retain existing ids and saved calls, without provider secrets. */
export function syncSatelliteConnections(userId: string) {
  const satellites = all(`SELECT s.* FROM satellites s JOIN satellite_users su ON su.satellite_id = s.id
    JOIN users u ON u.id = su.user_id WHERE su.user_id = ? AND s.disabled = 0 AND u.disabled = 0`, userId);
  for (const satellite of satellites) for (const c of catalog(satellite).connections) {
    const existing = one('SELECT * FROM connections WHERE user_id = ? AND satellite_id = ? AND remote_connection_id = ?', userId, satellite.id, c.id);
    const t = now();
    if (existing) {
      if (existing.kind !== c.kind || existing.status !== c.status) connectionChanged(existing.id);
      run('UPDATE connections SET kind = ?, status = ?, config_enc = NULL, credentials_enc = NULL, account_id = NULL, account_label = NULL, account_avatar = NULL WHERE id = ?', c.kind, c.status, existing.id);
      continue;
    }
    const base = c.name.replace(/[^a-zA-Z0-9._@+-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'shared';
    let name = base;
    for (let n = 2; one('SELECT 1 FROM connections WHERE user_id = ? AND name = ?', userId, name); n++) name = `${base}-${n}`;
    run(`INSERT INTO connections (id, user_id, service_id, method_id, name, status, created_at, updated_at, satellite_id, remote_connection_id, kind)
      VALUES (?, ?, ?, 'shared', ?, ?, ?, ?, ?, ?, ?)`, randomId('c'), userId, remoteServiceId(satellite.id, c.serviceId), name, c.status, t, t, satellite.id, c.id, c.kind);
  }
}

export function satelliteConnection(userId: string, satelliteId: string, connectionId: string): SatelliteConnection {
  if (!userCanUseSatellite(userId, satelliteId)) throw new HttpError(403, 'You cannot use this satellite');
  const row = one('SELECT * FROM satellites WHERE id = ?', satelliteId);
  const c = row && catalog(row).connections.find(c => c.id === connectionId);
  if (!c) throw new HttpError(403, 'This connection is no longer shared by the satellite');
  return c;
}

export function listSatellites() {
  return all('SELECT * FROM satellites WHERE removed = 0 ORDER BY name COLLATE NOCASE').map(view);
}

export function getSatellite(id: string) {
  const r = one('SELECT * FROM satellites WHERE id = ?', id);
  if (!r || r.removed) throw notFound('Satellite not found');
  return view(r);
}

export function createSatellite(name: string, ownerUserId: string) {
  name = String(name ?? '').trim();
  if (!name || name.length > 100) throw badRequest('Give the satellite a name of at most 100 characters');
  if (!one('SELECT 1 FROM users WHERE id = ?', ownerUserId)) throw badRequest('Unknown owner');
  if (one('SELECT 1 FROM satellites WHERE name = ? AND removed = 0', name)) throw badRequest('A satellite already has that name');
  const id = randomId('sat');
  const token = `sws_${randomToken(32)}`;
  const t = now();
  run('INSERT INTO satellites (id, name, owner_user_id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, ownerUserId, sha256(token), t, t);
  run('INSERT INTO satellite_users (satellite_id, user_id, created_at) VALUES (?, ?, ?)', id, ownerUserId, t);
  return { satellite: getSatellite(id), token };
}

export function rotateSatelliteToken(id: string) {
  getSatellite(id);
  const token = `sws_${randomToken(32)}`;
  run('UPDATE satellites SET token_hash = ?, updated_at = ? WHERE id = ?', sha256(token), now(), id);
  closeSession(id, 4001, 'Credentials rotated');
  return { token };
}

export function updateSatellite(id: string, patch: { name?: string; disabled?: boolean; userIds?: string[] }) {
  const current = getSatellite(id);
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name || name.length > 100) throw badRequest('Give the satellite a name of at most 100 characters');
    if (one('SELECT 1 FROM satellites WHERE name = ? AND id != ?', name, id)) throw badRequest('A satellite already has that name');
    run('UPDATE satellites SET name = ?, updated_at = ? WHERE id = ?', name, now(), id);
  }
  if (patch.disabled !== undefined) {
    run('UPDATE satellites SET disabled = ?, updated_at = ? WHERE id = ?', patch.disabled ? 1 : 0, now(), id);
    if (patch.disabled) { connectionChanged(); }
    if (patch.disabled) closeSession(id, 4001, 'Satellite disabled');
  }
  if (patch.userIds !== undefined) {
    if (!Array.isArray(patch.userIds) || patch.userIds.some(id => typeof id !== 'string')) throw badRequest('userIds must be an array');
    const ids = [...new Set([...patch.userIds, current.ownerUserId])];
    connectionChanged();
    for (const userId of ids) if (!one('SELECT 1 FROM users WHERE id = ?', userId)) throw badRequest(`Unknown user "${userId}"`);
    run('DELETE FROM satellite_users WHERE satellite_id = ?', id);
    for (const userId of ids) run('INSERT INTO satellite_users (satellite_id, user_id, created_at) VALUES (?, ?, ?)', id, userId, now());
  }
  return getSatellite(id);
}

export function deleteSatellite(id: string) {
  getSatellite(id);
  closeSession(id, 4001, 'Satellite removed');
  connectionChanged();
  run('DELETE FROM satellite_users WHERE satellite_id = ?', id);
  run('UPDATE satellites SET disabled = 1, removed = 1, name = ?, catalog_json = NULL WHERE id = ?', `removed-${id}`, id);
  // Preserve imported handles referenced by saved calls; this tombstone cannot reconnect.
  run('UPDATE satellites SET token_hash = ? WHERE id = ?', sha256(randomToken(32)), id);
}

export function userCanUseSatellite(userId: string, satelliteId: string) {
  return !!one(
    `SELECT 1 FROM satellites s JOIN satellite_users su ON su.satellite_id = s.id
     WHERE s.id = ? AND su.user_id = ? AND s.disabled = 0`,
    satelliteId, userId,
  );
}

export const remoteServiceId = (satelliteId: string, serviceId: string) => `sat/${satelliteId}/${serviceId}`;

export function parseRemoteServiceId(value: string): { satelliteId: string; serviceId: string } | undefined {
  const m = value.match(/^sat\/(sat_[A-Za-z0-9_-]+)\/(.+)$/);
  return m ? { satelliteId: m[1], serviceId: m[2] } : undefined;
}

export function validateSatelliteCatalog(value: any): { instanceId: string; connections: SatelliteConnection[] } {
  if (!value || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 100 || value.instanceId === instanceId() || !Array.isArray(value.connections) || value.connections.length > 1000) throw new Error('Invalid satellite connection catalogue');
  const seen = new Set<string>();
  const connections = value.connections.map((c: any) => {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || seen.has(c.id)) throw new Error('Invalid or duplicate shared connection id');
    if (typeof c.name !== 'string' || !c.name.trim() || typeof c.serviceId !== 'string' || !c.serviceId || c.serviceId.length > 200 || typeof c.serviceName !== 'string' || !c.serviceName) throw new Error('Invalid shared connection');
    if (!['http', 'mcp'].includes(c.kind) || !['ok', 'error', 'unavailable'].includes(c.status)) throw new Error('Invalid shared connection kind or status');
    if (!Array.isArray(c.route) || !c.route.length || c.route.length > MAX_SATELLITE_HOPS || c.route.some((id: any) => typeof id !== 'string' || !id || id.length > 100) || new Set(c.route).size !== c.route.length || c.route.includes(instanceId()) || c.route.at(-1) !== value.instanceId) throw new Error('Satellite route contains a loop');
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
  for (const p of session.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new HttpError(503, `${reason}; the request outcome may be unknown`));
  }
  session.pending.clear();
  session.socket.close(code, reason.slice(0, 123));
}

function receive(session: Session, raw: Buffer | ArrayBuffer | Buffer[]) {
  let message: any;
  try {
    message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as any).toString('utf8'));
  } catch {
    session.socket.close(1007, 'Invalid JSON');
    return;
  }
  if (message?.protocol !== PROTOCOL || typeof message.type !== 'string') {
    session.socket.close(1008, 'Unsupported protocol');
    return;
  }
  session.lastHeartbeat = now();
  run('UPDATE satellites SET last_seen_at = ? WHERE id = ?', session.lastHeartbeat, session.satelliteId);
  if (message.type === 'heartbeat') return;
  if (message.type === 'catalog') {
    try {
      const value = validateSatelliteCatalog(message.catalog);
      const previous = one('SELECT * FROM satellites WHERE id = ?', session.satelliteId);
      if (JSON.stringify(catalog(previous)) !== JSON.stringify({ connections: value.connections })) {
        for (const row of all('SELECT id FROM connections WHERE satellite_id = ?', session.satelliteId)) connectionChanged(row.id);
      }
      run('UPDATE satellites SET catalog_json = ?, catalog_version = ?, updated_at = ? WHERE id = ?', JSON.stringify(value), String(message.version ?? '').slice(0, 100) || null, now(), session.satelliteId);
      session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'catalog.accepted', version: message.version ?? null }));
    } catch (e: any) {
      session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'catalog.rejected', error: e.message }));
    }
    return;
  }
  if (message.type === 'result' || message.type === 'error') {
    const pending = session.pending.get(String(message.requestId));
    if (!pending) return;
    session.pending.delete(String(message.requestId));
    clearTimeout(pending.timer);
    if (message.type === 'error') pending.reject(new HttpError(Number.isInteger(message.status) && message.status >= 400 && message.status <= 599 ? message.status : 502, String(message.error ?? 'Satellite request failed').slice(0, 2000)));
    else pending.resolve(message.result);
  }
}

export function attachSatelliteWebSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/satellites/connect') return;
    if (request.headers['x-switchboard-satellite-protocol'] !== String(PROTOCOL)) { socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUpgrade both Switchboards to satellite protocol 2'); socket.destroy(); return; }
    const header = request.headers.authorization;
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const row = token && one('SELECT * FROM satellites WHERE token_hash = ?', sha256(token));
    if (!row || row.disabled) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, row));
  });
  wss.on('connection', (socket: WebSocket, _request: unknown, row: any) => {
    closeSession(row.id, 4000, 'Replaced by a new connection');
    const session: Session = { socket, satelliteId: row.id, connectedAt: now(), lastHeartbeat: now(), pending: new Map() };
    sessions.set(row.id, session);
    run('UPDATE satellites SET last_seen_at = ? WHERE id = ?', now(), row.id);
    socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'welcome', instanceId: instanceId(), satelliteId: row.id, heartbeatSeconds: 20, maxMessageBytes: MAX_MESSAGE }));
    socket.on('message', (data) => receive(session, data as Buffer));
    socket.on('close', () => {
      if (sessions.get(row.id) === session) closeSession(row.id, 1000, 'Satellite disconnected');
    });
    socket.on('error', () => {});
  });
  const timer = setInterval(() => {
    const cutoff = now() - 70_000;
    for (const [id, session] of sessions) if (session.lastHeartbeat < cutoff) closeSession(id, 4000, 'Heartbeat expired');
  }, 20_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const id of [...sessions.keys()]) closeSession(id, 1001, 'Server stopping');
    wss.close();
  };
}

export async function requestSatellite<T>(satelliteId: string, userId: string, operation: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT, signal?: AbortSignal): Promise<T> {
  if (!SATELLITE_OPERATIONS.has(operation)) throw new HttpError(403, 'Upstreams may only execute explicitly shared connections');
  const remote = (payload as any)?.connection;
  if (typeof remote !== 'string') throw badRequest('A shared connection id is required');
  const descriptor = satelliteConnection(userId, satelliteId, remote);
  if (descriptor.status !== 'ok') throw new HttpError(503, 'The shared connection is unavailable on its satellite');
  if (signal?.aborted) throw new HttpError(499, 'Request cancelled; the outcome may be unknown');
  if (!userCanUseSatellite(userId, satelliteId)) throw new HttpError(403, 'You cannot use this satellite');
  const satellite = getSatellite(satelliteId);
  const session = sessions.get(satelliteId);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    const error = new HttpError(503, `${satellite.name} is offline${satellite.lastSeenAt ? ` (last seen ${new Date(satellite.lastSeenAt).toISOString()})` : ''}`) as HttpError & { code?: string };
    error.code = 'satellite_offline';
    throw error;
  }
  const requestId = randomId('sr');
  const handles = new Set(all<{ id: string }>('SELECT id FROM connections WHERE satellite_id = ? AND remote_connection_id = ?', satelliteId, remote).map(c => c.id));
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
      reject(new HttpError(499, 'Request cancelled; the upstream outcome may be unknown'));
    };
    const timer = setTimeout(() => {
      cancel();
      cleanup();
      reject(new HttpError(504, `Request to ${satellite.name} timed out; the outcome may be unknown`));
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
