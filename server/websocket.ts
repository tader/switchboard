import { onPeerDisconnected } from './peer-events.ts';
import type { WebSocketOperation } from './plugins/api.ts';
import { getConnectionRow, loadConnection, touch, trackConnectionHealth } from './connections.ts';
import { requestPeer, peerConnection } from './peers.ts';
import { peerRoute } from './peer-protocol.ts';
import { onConnectionChange } from './connection-events.ts';
import { onAccessChange } from './access-events.ts';
import { onPeersChanged } from './peer-settings.ts';
import { record, redactBody, type Caller } from './audit.ts';
import type { WebSocketAccess } from './websocket-access.ts';
import { acquireWebSocket, abortable, type ManagedWebSocket } from './websocket-transport.ts';
import { WS_LIMITS, jsonSize, validateWebSocketValue } from './websocket-schema.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import { randomId, sha256 } from './crypto.ts';

export type WebSocketAction = 'operations' | 'operation' | 'call' | 'subscriptions' | 'subscribe' | 'read' | 'unsubscribe';
export interface WebSocketInput {
  action: WebSocketAction;
  operationId?: string;
  arguments?: Record<string, unknown>;
  subscriptionId?: string;
  query?: string;
  offset?: number;
  cursor?: number;
  limit?: number;
  waitMs?: number;
}
interface Event { sequence: number; time: number; value: unknown; size: number }
interface Subscription {
  id: string; connectionId: string; access: WebSocketAccess; operationId: string;
  status: 'active' | 'stopped' | 'interrupted' | 'expired'; reason?: string;
  expiresAt: number; events: Event[]; bytes: number; sequence: number; droppedThrough: number;
  controller: AbortController; stop?: () => void | Promise<void>; session?: ManagedWebSocket;
  wakes: Set<() => void>; caller?: Caller;
}
const subscriptions = new Map<string, Subscription>();
const own = (s: Subscription, access: WebSocketAccess) => s.access.user.id === access.user.id && s.access.principal === access.principal;
const view = (s: Subscription) => ({ id: s.id, connectionId: s.connectionId, operationId: s.operationId, status: s.status, reason: s.reason, expiresAt: s.expiresAt });
function audit(access: WebSocketAccess, row: any, input: WebSocketInput, caller: Caller | undefined, started: number, status: number, responseSize?: number, reason?: string, lifecycle?: string) {
  if (!caller) return;
  return record({ userId: access.user.id, caller, connection: { id: row.id, name: row.name, serviceId: row.service_id },
    method: 'WS', status, durationMs: Date.now() - started, requestSize: Buffer.byteLength(JSON.stringify(input)), responseSize, wsOperation: lifecycle ?? input.action,
    wsTarget: input.operationId ?? input.subscriptionId, wsOutcome: status < 400 ? 'success' : status === 499 ? 'cancelled' : 'error',
    requestBody: redactBody(JSON.stringify(input), 'application/json'), error: status >= 400 ? reason ?? 'WebSocket operation failed' : undefined });
}
function terminal(s: Subscription, status: Subscription['status'], reason?: string) {
  if (s.status !== 'active') return;
  s.status = status; s.reason = reason; s.expiresAt = Date.now() + WS_LIMITS.leaseMs;
  s.controller.abort();
  if (s.session) { s.session.holds--; s.session.lastUsed = Date.now(); }
  if (s.stop) abortable(Promise.resolve().then(() => s.stop!()), AbortSignal.timeout(WS_LIMITS.cleanupMs)).catch(() => { s.session?.close('Could not stop upstream subscription'); });
  else s.session?.close('Subscription stopped without an upstream stop operation');
  for (const wake of s.wakes) wake();
  try {
    if (status === 'stopped') return;
    const row = getConnectionRow(s.access.user.id, s.connectionId);
    audit(s.access, row, { action: 'unsubscribe', subscriptionId: s.id, operationId: s.operationId }, s.caller, Date.now(), status === 'interrupted' ? 502 : 200, undefined, reason, status);
  } catch {}
}
function sweep() {
  for (const s of subscriptions.values()) {
    try { s.access.check(s.connectionId); } catch { terminal(s, 'interrupted', 'Access revoked or expired'); subscriptions.delete(s.id); continue; }
    if (s.expiresAt <= Date.now()) {
      if (s.status === 'active') terminal(s, 'expired', 'Subscription lease expired');
      else subscriptions.delete(s.id);
    }
  }
}
onAccessChange(sweep);
onPeersChanged(sweep);
onConnectionChange(id => { for (const s of subscriptions.values()) if (!id || id === s.connectionId) terminal(s, 'interrupted', 'Connection or plugin changed'); });
setInterval(sweep, WS_LIMITS.sweepMs).unref();
export function stopWebSocketSubscriptions() { for (const s of subscriptions.values()) terminal(s, 'interrupted', 'Switchboard stopping'); subscriptions.clear(); }
function getSubscription(access: WebSocketAccess, id: string, subscriptionId: unknown) {
  if (typeof subscriptionId !== 'string') throw badRequest('subscriptionId is required');
  const s = subscriptions.get(subscriptionId);
  if (!s || s.connectionId !== id || !own(s, access)) throw notFound('Subscription not found; start a new subscription if Switchboard restarted');
  access.check(id);
  if (s.expiresAt <= Date.now()) {
    if (s.status === 'active') terminal(s, 'expired', 'Subscription lease expired');
    else { subscriptions.delete(s.id); throw notFound('Subscription retention expired'); }
  }
  return s;
}
function allocate(access: WebSocketAccess, id: string, operationId: string, caller?: Caller) {
  sweep();
  const entries = [...subscriptions.values()];
  if (entries.length >= WS_LIMITS.instance || entries.filter(s => s.access.user.id === access.user.id).length >= WS_LIMITS.user || entries.filter(s => own(s, access)).length >= WS_LIMITS.principal) throw new HttpError(429, 'WebSocket subscription quota reached (retained handles also count)');
  const s: Subscription = { id: randomId('wss'), connectionId: id, access, operationId, status: 'active', expiresAt: Date.now() + WS_LIMITS.leaseMs,
    events: [], bytes: 0, sequence: 0, droppedThrough: 0, controller: new AbortController(), wakes: new Set(), caller };
  subscriptions.set(s.id, s); return s;
}
function append(s: Subscription, value: unknown, op?: WebSocketOperation) {
  if (s.status !== 'active') return;
  try {
    s.access.check(s.connectionId);
    if (op) validateWebSocketValue(op, 'event', value);
    const size = jsonSize(value, WS_LIMITS.event) + 128;
    // Freeze a JSON snapshot: a plugin may reuse or mutate its event objects.
    s.events.push({ sequence: ++s.sequence, time: Date.now(), value: JSON.parse(JSON.stringify(value)), size }); s.bytes += size;
    while (s.events.length > WS_LIMITS.events || s.bytes > WS_LIMITS.buffer) { const removed = s.events.shift()!; s.bytes -= removed.size; s.droppedThrough = removed.sequence; }
    for (const wake of s.wakes) wake();
  } catch { terminal(s, 'interrupted', 'Invalid event or access revoked'); }
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw badRequest(`Invalid ${name}`);
  return value;
}
async function read(s: Subscription, input: WebSocketInput, signal: AbortSignal) {
  const cursor = integer(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
  const limit = integer(input.limit, 100, 1, 500, 'limit');
  const waitMs = integer(input.waitMs, 0, 0, 25_000, 'waitMs');
  if (cursor > s.sequence) throw badRequest('Cursor is ahead of this subscription');
  if (s.status === 'active') s.expiresAt = Date.now() + WS_LIMITS.leaseMs;
  if (s.status === 'active' && cursor >= s.sequence && waitMs) {
    if (s.wakes.size) throw new HttpError(409, 'An event read is already waiting for this subscription');
    await abortable(new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); s.wakes.delete(wake); signal.removeEventListener('abort', wake); resolve(); };
      const timer = setTimeout(wake, waitMs);
      s.wakes.add(wake); signal.addEventListener('abort', wake, { once: true });
    }), signal);
  }
  s.access.check(s.connectionId);
  let size = 0;
  const events: { sequence: number; time: number; value: unknown }[] = [];
  for (const event of s.events) {
    if (event.sequence <= cursor) continue;
    if (events.length >= limit || size + event.size > WS_LIMITS.page) break;
    size += event.size; events.push({ sequence: event.sequence, time: event.time, value: event.value });
  }
  return { ...view(s), events, nextCursor: events.at(-1)?.sequence ?? Math.max(cursor, s.droppedThrough),
    ...(cursor < s.droppedThrough ? { gap: { from: cursor + 1, to: s.droppedThrough } } : {}) };
}
function localOperation(access: WebSocketAccess, id: string, operationId: unknown) {
  const { service } = loadConnection(access.user.id, id);
  const op = service.websocket?.operations.find(op => op.id === operationId);
  if (!op) throw notFound('WebSocket operation not found');
  return op;
}
async function remote(access: WebSocketAccess, row: any, input: WebSocketInput, signal: AbortSignal, caller?: Caller) {
  if (!peerConnection(access.user.id, row.peer_id, row.remote_connection_id).hasWebSocket) throw badRequest('This peer connection does not support WebSocket operations');
  const inheritedPath = peerRoute.getStore()?.path;
  const send = (request: WebSocketInput, currentSignal?: AbortSignal, cleanup = false) => {
    // A revoked local caller may still release its previously owned remote handle.
    if (!cleanup || request.action !== 'unsubscribe') access.check(row.id);
    // Fresh deadlines for every poll; retain only the route path from creation.
    const invoke = () => requestPeer<any>(row.peer_id, access.user.id, 'websocket', { connection: row.remote_connection_id, input: request,
      caller: { ...caller, tokenId: sha256(access.principal) } }, 60_000, currentSignal);
    return inheritedPath ? peerRoute.run({ path: inheritedPath, deadline: Date.now() + 60_000 }, invoke) : invoke();
  };
  if (input.action !== 'subscribe') return send(input, signal);
  if (typeof input.operationId !== 'string') throw badRequest('operationId is required');
  const s = allocate(access, row.id, input.operationId, caller);
  let handle: any;
  try {
    handle = await send(input, signal);
    s.stop = () => send({ action: 'unsubscribe', subscriptionId: handle.id }, AbortSignal.timeout(WS_LIMITS.cleanupMs), true).then(() => {});
    if (signal.aborted || s.controller.signal.aborted) throw new HttpError(499, 'Subscription creation cancelled');
    const poll = async () => {
      let cursor = 0;
      try {
        while (s.status === 'active') {
          const page = await send({ action: 'read', subscriptionId: handle.id, cursor, waitMs: 25_000 }, s.controller.signal);
          if (page.gap) { const missing = Math.max(0, page.gap.to - cursor); s.sequence += missing; s.droppedThrough = s.sequence; }
          for (const event of page.events) append(s, event.value);
          cursor = page.nextCursor;
          if (page.status !== 'active') { terminal(s, 'interrupted', page.reason ?? 'Upstream peer subscription stopped'); break; }
        }
      } catch { terminal(s, 'interrupted', 'Peer subscription disconnected'); }
    };
    void poll(); return view(s);
  } catch (error) {
    if (handle?.id) void send({ action: 'unsubscribe', subscriptionId: handle.id }, AbortSignal.timeout(WS_LIMITS.cleanupMs), true).catch(() => {});
    terminal(s, 'interrupted', 'Peer subscription creation failed'); subscriptions.delete(s.id); throw error;
  }
}

export async function executeWebSocket(access: WebSocketAccess, ref: string, input: WebSocketInput, signal?: AbortSignal, caller?: Caller): Promise<any> {
  const row = getConnectionRow(access.user.id, ref);
  access.check(row.id);
  if (!input || !['operations', 'operation', 'call', 'subscriptions', 'subscribe', 'read', 'unsubscribe'].includes(input.action)) throw badRequest('Unknown WebSocket action');
  jsonSize(input, WS_LIMITS.arguments);
  const started = Date.now();
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(WS_LIMITS.commandMs)]) : AbortSignal.timeout(WS_LIMITS.commandMs);
  try {
    await abortable(Promise.resolve(), operationSignal);
    let result: any;
    if (input.action === 'subscriptions') {
      sweep(); result = { subscriptions: [...subscriptions.values()].filter(s => s.connectionId === row.id && own(s, access)).map(view) };
    } else if (input.action === 'read' || input.action === 'unsubscribe') {
      const s = getSubscription(access, row.id, input.subscriptionId);
      if (input.action === 'read') result = await read(s, input, operationSignal);
      else { terminal(s, 'stopped'); result = view(s); }
    } else if (row.peer_id) {
      result = await remote(access, row, input, operationSignal, caller);
    } else if (input.action === 'operations') {
      const { service } = loadConnection(access.user.id, row.id);
      if (!service.websocket) throw badRequest('This connection has no WebSocket operations');
      if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096)) throw badRequest('Invalid operation query');
      const words = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const operations = service.websocket.operations.filter(op => words.every(word => `${op.id} ${op.title} ${op.description ?? ''}`.toLowerCase().includes(word)));
      const offset = integer(input.offset, 0, 0, 1000, 'offset'); const limit = integer(input.limit, 20, 1, 100, 'limit');
      result = { proxy: service.websocket.proxy === true, operations: operations.slice(offset, offset + limit), ...(offset + limit < operations.length ? { nextOffset: offset + limit } : {}) };
    } else if (input.action === 'operation') result = { operation: localOperation(access, row.id, input.operationId) };
    else {
      const op = localOperation(access, row.id, input.operationId);
      const args = input.arguments ?? {};
      validateWebSocketValue(op, 'input', args);
      if ((input.action === 'call') !== (op.mode === 'command')) throw badRequest('Operation mode does not match this action');
      const recovered = trackConnectionHealth(row.id);
      const session = await acquireWebSocket(access, row.id, operationSignal);
      if (session.holds >= 32) throw new HttpError(429, 'Too many concurrent operations on this WebSocket session');
      session.holds++; session.lastUsed = Date.now();
      if (input.action === 'call') {
        try {
          const value = await abortable(Promise.resolve(session.adapter.call(op.id, args, AbortSignal.any([operationSignal, session.controller.signal]))), AbortSignal.any([operationSignal, session.controller.signal]));
          access.check(row.id); validateWebSocketValue(op, 'output', value);
          result = { result: value, durationMs: Date.now() - started };
        } catch (error) {
          session.close(operationSignal.aborted ? 'Command cancelled or timed out; outcome may be unknown' : 'WebSocket command failed');
          throw error;
        } finally { session.holds--; session.lastUsed = Date.now(); }
      } else {
        let s: Subscription | undefined;
        try {
          if (!session.adapter.subscribe) throw badRequest('Plugin does not implement subscriptions');
          s = allocate(access, row.id, op.id, caller); s.session = session;
          const sub = s;
          const disconnected = () => terminal(sub, 'interrupted', session.reason ?? 'Upstream WebSocket disconnected');
          if (session.controller.signal.aborted) disconnected();
          session.controller.signal.addEventListener('abort', disconnected, { once: true });
          sub.controller.signal.addEventListener('abort', () => session.controller.signal.removeEventListener('abort', disconnected), { once: true });
          const creation = session.adapter.subscribe(op.id, args, event => append(sub, event, op), sub.controller.signal);
          // A plugin completing after cancellation must still release its upstream subscription.
          creation.then(value => { if (sub.status !== 'active') Promise.resolve().then(() => value.stop?.()).catch(() => session.close('Subscription cleanup failed')); }).catch(() => {});
          const upstream = await abortable(creation, AbortSignal.any([operationSignal, sub.controller.signal]));
          sub.stop = upstream.stop;
          access.check(row.id); result = view(sub);
        } catch (error) {
          if (s) { terminal(s, 'interrupted', 'Subscription creation failed'); subscriptions.delete(s.id); }
          else session.holds--;
          throw error;
        }
      }
      touch(row.id);
      recovered();
    }
    const size = jsonSize(result, WS_LIMITS.message);
    const auditId = audit(access, row, input, caller, started, 200, size);
    return auditId ? { ...result, auditId } : result;
  } catch (error: any) {
    audit(access, row, input, caller, started, error.status ?? 502);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'WebSocket plugin operation failed');
  }
}

onPeerDisconnected(id => { for (const s of subscriptions.values()) if (s.access.peerId === id) terminal(s, 'interrupted', 'Peer disconnected'); });
