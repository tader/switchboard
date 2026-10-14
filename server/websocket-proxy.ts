import { callerFrom, record, type Caller } from './audit.ts';
import type { Server, IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import { requireUser, type Env } from './auth.ts';
import { config } from './config.ts';
import { getConnectionRow } from './connections.ts';
import { websocketAccess, type WebSocketAccess } from './websocket-access.ts';
import { acquireWebSocket, type ManagedWebSocket } from './websocket-transport.ts';
import { WS_LIMITS } from './websocket-schema.ts';
import { HttpError } from './http.ts';

async function authorize(request: IncomingMessage): Promise<{ access: WebSocketAccess; id: string; caller: Caller }> {
  let result: { access: WebSocketAccess; id: string; caller: Caller } | undefined;
  const app = new Hono<Env>();
  app.onError((error, c) => c.json({ error: 'WebSocket proxy authorization failed' }, error instanceof HttpError ? error.status as any : 500));
  app.get('/api/connections/:ref/websocket/proxy', requireUser, c => {
    // A cookie upgrade can execute writes, even though its HTTP method is GET.
    if (!c.get('token') && c.req.header('origin') !== new URL(config.publicUrl).origin) throw new HttpError(403, 'Cross-site WebSocket blocked');
    const access = websocketAccess(c);
    const row = getConnectionRow(access.user.id, c.req.param('ref'));
    access.check(row.id);
    if (row.peer_id) throw new HttpError(400, 'Raw WebSocket proxy requires a local connection');
    result = { access, id: row.id, caller: callerFrom(c, 'proxy') };
    return c.json({ ok: true });
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  const response = await app.request(new Request(new URL(request.url!, config.publicUrl), { headers }));
  if (!response.ok || !result) throw new HttpError(response.status, 'WebSocket proxy authorization failed');
  return result;
}

export function attachWebSocketProxy(server: Server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_LIMITS.message });
  const pending = new Set<AbortController>();
  // Use a dedicated listener so peer upgrades keep their existing handler.
  const handler = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (!/^\/api\/connections\/[^/]+\/websocket\/proxy$/.test(new URL(request.url ?? '/', config.publicUrl).pathname)) return;
    if (request.headers['sec-websocket-version'] !== '13' || !/^[+/0-9A-Za-z]{22}==$/.test(String(request.headers['sec-websocket-key'] ?? ''))) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const controller = new AbortController(); pending.add(controller);
    const cancel = () => controller.abort(); socket.once('close', cancel);
    void (async () => {
      let session: ManagedWebSocket | undefined;
      try {
        const { access, id, caller } = await authorize(request);
        session = await acquireWebSocket(access, id, controller.signal, true);
        if (controller.signal.aborted) throw new Error('Upgrade cancelled');
        wss.handleUpgrade(request, socket, head, ws => {
          pending.delete(controller); socket.off('close', cancel);
          const upstream = session!; upstream.holds++;
          const started = Date.now();
          let received = 0; let sent = 0;
          const close = () => {
            if (controller.signal.aborted) return;
            controller.abort(); upstream.close('WebSocket proxy disconnected'); ws.terminate();
            record({ userId: access.user.id, caller, connection: { id, name: id, serviceId: upstream.service.id }, method: 'WS', status: 101, durationMs: Date.now() - started, requestSize: sent, responseSize: received, wsOperation: 'proxy', wsOutcome: 'success' });
          };
          upstream.controller.signal.addEventListener('abort', close, { once: true });
          ws.on('close', close); ws.on('error', close);
          let queuedBytes = 0;
          let chain = Promise.resolve();
          ws.on('message', (data, binary) => {
            const value = binary ? new Uint8Array(data as Buffer) : data.toString();
            queuedBytes += Buffer.byteLength(value);
            if (queuedBytes > WS_LIMITS.message) { close(); return; }
            chain = chain.then(async () => {
              access.check(id);
              await upstream.channel!.send(value);
              sent += Buffer.byteLength(value);
              queuedBytes -= Buffer.byteLength(value);
            }).catch(close);
          });
          void (async () => {
            try {
              while (!controller.signal.aborted) {
                const value = await upstream.channel!.receive(controller.signal);
                access.check(id);
                received += Buffer.byteLength(value);
                if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > WS_LIMITS.message) throw new Error('Client disconnected or too slow');
                await new Promise<void>((resolve, reject) => ws.send(value, error => error ? reject(error) : resolve()));
              }
            } catch { close(); }
          })();
        });
      } catch (error) {
        session?.close('Proxy upgrade failed');
        const status = error instanceof HttpError ? error.status : 502;
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} WebSocket proxy rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } finally { pending.delete(controller); socket.off('close', cancel); }
    })();
  };
  server.on('upgrade', handler);
  return () => { server.off('upgrade', handler); for (const controller of pending) controller.abort(); for (const ws of wss.clients) ws.terminate(); wss.close(); };
}
