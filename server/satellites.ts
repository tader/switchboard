import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomId, randomToken, sha256 } from './crypto.ts';
import { all, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';

const PROTOCOL = 1;
const REQUEST_TIMEOUT = 120_000;
const MAX_MESSAGE = 2 * 1024 * 1024;

export interface SatelliteService {
  id: string;
  name: string;
  description?: string;
  pluginId: string;
  icon?: string;
  methods: {
    id: string;
    name: string;
    description?: string;
    fields?: unknown[];
    unavailable?: string;
    redirect?: boolean;
  }[];
  hasOpenapi?: boolean;
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
    services: catalog(r).services,
    userIds: all<{ user_id: string }>('SELECT user_id FROM satellite_users WHERE satellite_id = ? ORDER BY user_id', r.id).map((x) => x.user_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function catalog(r: any): { services: SatelliteService[] } {
  try {
    const parsed = r.catalog_json ? JSON.parse(r.catalog_json) : {};
    return { services: Array.isArray(parsed.services) ? parsed.services : [] };
  } catch {
    return { services: [] };
  }
}

export function listSatellites() {
  return all('SELECT * FROM satellites ORDER BY name COLLATE NOCASE').map(view);
}

export function getSatellite(id: string) {
  const r = one('SELECT * FROM satellites WHERE id = ?', id);
  if (!r) throw notFound('Satellite not found');
  return view(r);
}

export function createSatellite(name: string, ownerUserId: string) {
  name = String(name ?? '').trim();
  if (!name || name.length > 100) throw badRequest('Give the satellite a name of at most 100 characters');
  if (!one('SELECT 1 FROM users WHERE id = ?', ownerUserId)) throw badRequest('Unknown owner');
  if (one('SELECT 1 FROM satellites WHERE name = ?', name)) throw badRequest('A satellite already has that name');
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
    if (patch.disabled) closeSession(id, 4001, 'Satellite disabled');
  }
  if (patch.userIds !== undefined) {
    const ids = [...new Set([...patch.userIds.map(String), current.ownerUserId])];
    for (const userId of ids) if (!one('SELECT 1 FROM users WHERE id = ?', userId)) throw badRequest(`Unknown user "${userId}"`);
    run('DELETE FROM satellite_users WHERE satellite_id = ?', id);
    for (const userId of ids) run('INSERT INTO satellite_users (satellite_id, user_id, created_at) VALUES (?, ?, ?)', id, userId, now());
  }
  return getSatellite(id);
}

export function deleteSatellite(id: string) {
  getSatellite(id);
  closeSession(id, 4001, 'Satellite removed');
  run('DELETE FROM satellites WHERE id = ?', id);
}

export function userCanUseSatellite(userId: string, satelliteId: string) {
  return !!one(
    `SELECT 1 FROM satellites s JOIN satellite_users su ON su.satellite_id = s.id
     WHERE s.id = ? AND su.user_id = ? AND s.disabled = 0`,
    satelliteId, userId,
  );
}

export function servicesForUser(userId: string) {
  const rows = all(
    `SELECT s.* FROM satellites s JOIN satellite_users su ON su.satellite_id = s.id
     WHERE su.user_id = ? AND s.disabled = 0 ORDER BY s.name COLLATE NOCASE`,
    userId,
  );
  return rows.flatMap((r) => catalog(r).services.map((service) => ({ satellite: view(r), service })));
}

export function satelliteService(userId: string, satelliteId: string, serviceId: string) {
  if (!userCanUseSatellite(userId, satelliteId)) throw new HttpError(403, 'You cannot use this satellite');
  const r = one('SELECT * FROM satellites WHERE id = ?', satelliteId);
  if (!r) throw notFound('Satellite not found');
  const service = catalog(r).services.find((s) => s.id === serviceId);
  if (!service) throw badRequest(`Service "${serviceId}" is not advertised by ${r.name}`);
  return { satellite: view(r), service };
}

export const remoteServiceId = (satelliteId: string, serviceId: string) => `sat/${satelliteId}/${serviceId}`;

export function parseRemoteServiceId(value: string): { satelliteId: string; serviceId: string } | undefined {
  const m = value.match(/^sat\/(sat_[A-Za-z0-9_-]+)\/(.+)$/);
  return m ? { satelliteId: m[1], serviceId: m[2] } : undefined;
}

function validateCatalog(value: any): { services: SatelliteService[] } {
  if (!value || !Array.isArray(value.services) || value.services.length > 200) throw new Error('Invalid satellite catalogue');
  const seen = new Set<string>();
  const services = value.services.map((s: any) => {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(s.id) || seen.has(s.id)) throw new Error('Invalid or duplicate service id');
    if (typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.methods) || s.methods.length > 20) throw new Error(`Invalid service ${s.id}`);
    seen.add(s.id);
    return {
      id: s.id,
      name: s.name.slice(0, 100),
      description: typeof s.description === 'string' ? s.description.slice(0, 500) : undefined,
      pluginId: typeof s.pluginId === 'string' ? s.pluginId.slice(0, 100) : s.id,
      icon: typeof s.icon === 'string' && s.icon.length <= 100_000 ? s.icon : undefined,
      hasOpenapi: !!s.hasOpenapi,
      methods: s.methods.map((m: any) => {
        if (!m || typeof m.id !== 'string' || typeof m.name !== 'string') throw new Error(`Invalid method for ${s.id}`);
        return { id: m.id.slice(0, 100), name: m.name.slice(0, 100), description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined, fields: Array.isArray(m.fields) ? m.fields.slice(0, 50) : [], unavailable: typeof m.unavailable === 'string' ? m.unavailable.slice(0, 500) : undefined, redirect: !!m.redirect };
      }),
    };
  });
  return { services };
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
      const value = validateCatalog(message.catalog);
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
    if (message.type === 'error') pending.reject(new HttpError(Number(message.status) || 502, String(message.error ?? 'Satellite request failed')));
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
    socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'welcome', satelliteId: row.id, heartbeatSeconds: 20, maxMessageBytes: MAX_MESSAGE }));
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

export async function requestSatellite<T>(satelliteId: string, userId: string, operation: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
  if (!userCanUseSatellite(userId, satelliteId)) throw new HttpError(403, 'You cannot use this satellite');
  const satellite = getSatellite(satelliteId);
  const session = sessions.get(satelliteId);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    const error = new HttpError(503, `${satellite.name} is offline${satellite.lastSeenAt ? ` (last seen ${new Date(satellite.lastSeenAt).toISOString()})` : ''}`) as HttpError & { code?: string };
    error.code = 'satellite_offline';
    throw error;
  }
  const requestId = randomId('sr');
  const deadline = now() + Math.min(Math.max(timeoutMs, 1), REQUEST_TIMEOUT);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(requestId);
      session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'cancel', requestId }));
      reject(new HttpError(504, `Request to ${satellite.name} timed out; the outcome may be unknown`));
    }, deadline - now());
    session.pending.set(requestId, { resolve, reject, timer });
    session.socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'request', requestId, userId, operation, deadline, payload }));
  });
}
