import { onPeerDisconnected } from './peer-events.ts';
import { WebSocket } from 'ws';
import type { WebSocketChannel, WebSocketSession, ServiceDefinition, Connection } from './plugins/api.ts';
import { loadConnection, resolveBaseUrl, saveCredentials, withLock } from './connections.ts';
import { allowedHosts, hostAllowed } from './proxy.ts';
import { onConnectionChange, onCredentialsChange } from './connection-events.ts';
import { onAccessChange } from './access-events.ts';
import type { WebSocketAccess } from './websocket-access.ts';
import { HttpError, badRequest } from './http.ts';
import { randomId, sha256 } from './crypto.ts';
import { WS_LIMITS } from './websocket-schema.ts';

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new HttpError(signal.reason?.name === 'TimeoutError' ? 504 : 499, 'WebSocket operation cancelled or timed out; the upstream outcome may be unknown')); };
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

class Channel implements WebSocketChannel {
  socket: WebSocket;
  closed: Promise<void>;
  private end!: () => void;
  private queue: (string | Uint8Array)[] = [];
  private bytes = 0;
  private ended = false;
  private waiting?: { resolve(value: string | Uint8Array): void; reject(error: Error): void };
  constructor(url: URL, headers: Headers) {
    this.closed = new Promise(resolve => { this.end = resolve; });
    this.socket = new WebSocket(url, { headers: Object.fromEntries(headers), followRedirects: false, perMessageDeflate: false, maxPayload: WS_LIMITS.message, handshakeTimeout: WS_LIMITS.openMs });
    this.socket.on('message', (data, binary) => {
      const value = binary ? new Uint8Array(data as Buffer) : data.toString();
      if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve(value); return; }
      this.bytes += Buffer.byteLength(value);
      if (this.bytes > WS_LIMITS.message || this.queue.length >= WS_LIMITS.events) { this.close(); return; }
      this.queue.push(value);
    });
    this.socket.on('close', () => this.finish());
    this.socket.on('error', () => this.finish());
  }
  private finish() {
    if (this.ended) return;
    this.ended = true; this.queue = []; this.bytes = 0;
    this.waiting?.reject(new HttpError(502, 'Upstream WebSocket disconnected')); this.waiting = undefined;
    this.end();
  }
  close() { this.finish(); this.socket.terminate(); }
  async send(data: string | Uint8Array) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw new HttpError(502, 'Upstream WebSocket is closed');
    if (Buffer.byteLength(data) > WS_LIMITS.message || this.socket.bufferedAmount > WS_LIMITS.message) throw new HttpError(413, 'WebSocket send buffer exceeded the limit');
    await new Promise<void>((resolve, reject) => this.socket.send(data, error => error ? reject(new HttpError(502, 'WebSocket send failed')) : resolve()));
  }
  async receive(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.ended) throw new HttpError(502, 'Upstream WebSocket disconnected');
    if (this.waiting) throw new Error('WebSocket channel requires a single receive consumer');
    const value = this.queue.shift();
    if (value !== undefined) { this.bytes -= Buffer.byteLength(value); return value; }
    return new Promise<string | Uint8Array>((resolve, reject) => {
      const abort = () => { this.waiting = undefined; reject(new HttpError(499, 'WebSocket receive cancelled')); };
      const clean = () => signal?.removeEventListener('abort', abort);
      this.waiting = { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async open(signal: AbortSignal) {
    await abortable(new Promise<void>((resolve, reject) => {
      const clean = () => { this.socket.off('open', opened); this.socket.off('error', error); this.socket.off('unexpected-response', rejected); };
      const opened = () => { clean(); resolve(); };
      const error = () => { clean(); reject(new HttpError(502, 'Could not open upstream WebSocket')); };
      const rejected = (_req: unknown, response: import('node:http').IncomingMessage) => {
        clean(); response.destroy(); const e: any = new HttpError(502, 'Upstream WebSocket upgrade rejected');
        if (response.statusCode === 401) e.code = 'WEBSOCKET_AUTH_REJECTED';
        reject(e);
      };
      this.socket.once('open', opened); this.socket.once('error', error); this.socket.once('unexpected-response', rejected);
    }), signal);
  }
}

export interface ManagedWebSocket {
  connectionId: string;
  access: WebSocketAccess;
  adapter: WebSocketSession;
  channel?: WebSocketChannel;
  controller: AbortController;
  endpoint: string;
  fingerprint: string;
  service: ServiceDefinition;
  holds: number;
  lastUsed: number;
  close(reason: string): void;
  reason?: string;
}
const pool = new Map<string, ManagedWebSocket>();
const opening = new Map<string, { access: WebSocketAccess; connectionId: string; controller: AbortController; promise: Promise<ManagedWebSocket> }>();
function endpoint(service: ServiceDefinition, conn: Connection): URL {
  const capability = service.websocket!;
  const raw = typeof capability.endpoint === 'function' ? capability.endpoint(conn) : capability.endpoint;
  const base = resolveBaseUrl(service, conn);
  const url = new URL(raw, base);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  validateEndpoint(url, service, conn);
  return url;
}
function validateEndpoint(url: URL, service: ServiceDefinition, conn: Connection) {
  const base = resolveBaseUrl(service, conn);
  if (url.username || url.password || url.hash || !['ws:', 'wss:'].includes(url.protocol)) throw badRequest('Invalid WebSocket endpoint');
  if (url.protocol === 'ws:' && (!base || new URL(base).protocol !== 'http:')) throw badRequest('Only secure WebSocket endpoints are allowed');
  if (!hostAllowed(url.host, allowedHosts(service, conn))) throw badRequest('WebSocket endpoint is not an allowed credential host');
}
const fingerprint = (conn: Connection) => sha256(JSON.stringify([conn.methodId, conn.config, conn.credentials]));
function enforceQuota(access: WebSocketAccess) {
  const entries = [...pool.values(), ...opening.values()];
  if (entries.length >= WS_LIMITS.instance || entries.filter(s => s.access.user.id === access.user.id).length >= WS_LIMITS.user || entries.filter(s => s.access.user.id === access.user.id && s.access.principal === access.principal).length >= WS_LIMITS.principal) throw new HttpError(429, 'WebSocket socket quota reached');
}
export async function acquireWebSocket(access: WebSocketAccess, id: string, signal: AbortSignal, raw = false): Promise<ManagedWebSocket> {
  access.check(id);
  const { service, conn } = loadConnection(access.user.id, id);
  if (!service.websocket) throw badRequest('This connection has no WebSocket operations');
  if (raw && !service.websocket.proxy) throw badRequest('This plugin does not support a WebSocket proxy');
  const target = endpoint(service, conn);
  const key = JSON.stringify([access.user.id, access.principal, id, raw ? randomId('wsproxy') : null]);
  let existing = pool.get(key);
  if (existing && (existing.service !== service || existing.fingerprint !== fingerprint(conn) || existing.endpoint !== target.href)) { existing.close('Connection or credentials changed'); existing = undefined; }
  if (existing) { existing.lastUsed = Date.now(); return existing; }
  const pending = opening.get(key);
  if (pending) return abortable(pending.promise, signal);
  enforceQuota(access);
  const controller = new AbortController();
  const openSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(WS_LIMITS.openMs)]);
  const promise = (async () => {
    let channel: Channel | undefined;
    let adapter: WebSocketSession | undefined;
    try {
      await withLock(id, async () => {
        for (const force of [false, true]) {
          access.check(id); openSignal.throwIfAborted();
          const fresh = loadConnection(access.user.id, id);
          if (fresh.service !== service) throw new HttpError(409, 'Plugin changed during WebSocket authentication');
          const req = { method: 'GET', url: endpoint(service, fresh.conn), headers: new Headers() };
          req.url.protocol = req.url.protocol === 'wss:' ? 'https:' : 'http:';
          const authorized = await abortable(Promise.resolve(fresh.method.authorize(req, fresh.conn, { force, signal: openSignal })), openSignal);
          if (authorized?.credentials !== undefined) saveCredentials(id, authorized.credentials);
          if (!['http:', 'https:'].includes(req.url.protocol)) throw badRequest('Plugin changed the WebSocket endpoint protocol');
          req.url.protocol = req.url.protocol === 'https:' ? 'wss:' : 'ws:';
          validateEndpoint(req.url, service, fresh.conn);
          channel = new Channel(req.url, req.headers);
          try {
            await channel.open(openSignal);
            const current = loadConnection(access.user.id, id).conn;
            const authenticated = fresh.method.authenticateWebSocket ? await abortable(fresh.method.authenticateWebSocket(channel, current, { force, signal: openSignal }), openSignal) : undefined;
            if (authenticated?.credentials !== undefined) saveCredentials(id, authenticated.credentials);
            break;
          } catch (error: any) {
            channel.close();
            if (!force && error.code === 'WEBSOCKET_AUTH_REJECTED') continue;
            throw new HttpError(error.status === 499 || error.status === 504 ? error.status : 502, 'Upstream WebSocket authentication failed');
          }
        }
      });
      openSignal.throwIfAborted(); access.check(id);
      const current = loadConnection(access.user.id, id).conn;
      const creation = Promise.resolve(raw ? { call: async () => { throw badRequest('Raw relay has no operation adapter'); } } : service.websocket!.createSession({ channel: channel!, connection: current, signal: controller.signal }));
      creation.then(value => { if (controller.signal.aborted) Promise.resolve().then(() => value.dispose?.()).catch(() => {}); }).catch(() => {});
      adapter = await abortable(creation, openSignal);
      openSignal.throwIfAborted(); access.check(id);
      if (!adapter || typeof adapter.call !== 'function') throw new Error('WebSocket session must implement call');
      const session: ManagedWebSocket = { connectionId: id, access, adapter, channel: raw ? channel : undefined, controller, service, endpoint: target.href,
        fingerprint: fingerprint(current), holds: 0, lastUsed: Date.now(), close(reason) {
          if (controller.signal.aborted) return;
          session.reason = reason;
          pool.delete(key); controller.abort(); channel!.close();
          Promise.resolve().then(() => adapter?.dispose?.()).catch(() => {});
          clearInterval(heartbeat);
        } };
      let alive = true;
      const heartbeat = setInterval(() => { if (!alive) session.close('WebSocket heartbeat expired'); else { alive = false; channel!.socket.ping(); } }, 30_000); heartbeat.unref();
      channel!.socket.on('pong', () => { alive = true; });
      channel!.closed.then(() => session.close('Upstream WebSocket disconnected'));
      if (channel!.socket.readyState !== WebSocket.OPEN || controller.signal.aborted) { session.close('WebSocket disconnected during session creation'); throw new HttpError(502, 'Upstream WebSocket disconnected'); }
      pool.set(key, session);
      return session;
    } catch (error) {
      controller.abort(); channel?.close(); Promise.resolve().then(() => adapter?.dispose?.()).catch(() => {});
      throw error;
    } finally { opening.delete(key); }
  })();
  opening.set(key, { access, connectionId: id, controller, promise });
  return promise;
}
function invalidate(id: string | undefined, reason: string) {
  for (const session of pool.values()) if (!id || session.connectionId === id) session.close(reason);
  for (const pending of opening.values()) if (!id || pending.connectionId === id) pending.controller.abort();
}
onConnectionChange(id => invalidate(id, 'Connection or plugin changed'));
// An opening session persists its own refreshed credentials before joining the pool.
onCredentialsChange(id => { for (const session of pool.values()) if (session.connectionId === id) session.close('Credentials changed'); });
function sweep() {
  for (const session of pool.values()) {
    try { session.access.check(session.connectionId); } catch { session.close('Access revoked or expired'); continue; }
    if (!session.holds && session.lastUsed + WS_LIMITS.idleMs <= Date.now()) session.close('Idle WebSocket closed');
  }
  for (const pending of opening.values()) { try { pending.access.check(pending.connectionId); } catch { pending.controller.abort(); } }
}
onAccessChange(sweep);
setInterval(sweep, WS_LIMITS.sweepMs).unref();
export function stopWebSockets() { invalidate(undefined, 'Switchboard stopping'); }

onPeerDisconnected(id => {
  for (const session of pool.values()) if (session.access.peerId === id) session.close('Peer disconnected');
  for (const pending of opening.values()) if (pending.access.peerId === id) pending.controller.abort();
});
