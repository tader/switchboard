import type { PluginSetup, WebSocketChannel, Connection, WebSocketSession } from '../../../server/plugins/api.ts';

export const setup: PluginSetup = () => ({ services: [{
  id: 'websocket-test', name: 'WebSocket test', baseUrl: conn => conn.config.endpoint,
  authMethods: ['header', 'message'].map(id => ({
    id, name: id, fields: [{ key: 'endpoint', label: 'Endpoint', type: 'url' }, { key: 'token', label: 'Token', type: 'secret' }],
    connect: ({ config }) => ({ credentials: { token: config.token }, config: { endpoint: config.endpoint } }),
    authorize(req, conn, { force }) {
      const token = force ? 'upstream-secret' : conn.credentials.token;
      if (id === 'header') req.headers.set('authorization', `Bearer ${token}`);
      if (force) return { credentials: { token } };
    },
    ...(id === 'message' ? { async authenticateWebSocket(channel: WebSocketChannel, conn: Connection, opts: { signal: AbortSignal }) {
      const greeting = JSON.parse(String(await channel.receive(opts.signal)));
      if (greeting.type !== 'auth_required') throw new Error('Expected greeting');
      await channel.send(JSON.stringify({ type: 'auth', access_token: conn.credentials.token }));
      const response = JSON.parse(String(await channel.receive(opts.signal)));
      if (response.type !== 'auth_ok') { const error: any = new Error('Authentication rejected'); error.code = 'WEBSOCKET_AUTH_REJECTED'; throw error; }
    } } : {}),
  })),
  websocket: {
    proxy: true,
    endpoint: conn => `${conn.config.endpoint}/socket/${conn.methodId}`,
    operations: [
      { id: 'echo/value', rest: { method: 'GET', path: '/echo' }, title: 'Echo', mode: 'command', inputSchema: { type: 'object', properties: { value: { type: 'string' }, access_token: { type: 'string' } }, required: ['value'], additionalProperties: false }, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, readOnlyHint: true },
      { id: 'wait', title: 'Wait', mode: 'command', inputSchema: { type: 'object' } },
      { id: 'bad', rest: { method: 'PUT', path: '/bad' }, title: 'Invalid result', mode: 'command', inputSchema: { type: 'object' }, outputSchema: { type: 'string' } },
      { id: 'watch', title: 'Watch', mode: 'subscription', inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 2000 }, payload: { type: 'string' } } }, eventSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
    ],
    createSession({ channel, signal }): WebSocketSession {
      let counter = 0;
      const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
      const events = new Map<number, (event: unknown) => void>();
      const exchange = (type: string, args: Record<string, unknown>, currentSignal: AbortSignal, emit?: (event: unknown) => void) => {
        const id = ++counter;
        if (emit) events.set(id, emit);
        const result = new Promise<any>((resolve, reject) => {
          const abort = () => { pending.delete(id); events.delete(id); reject(new Error('Cancelled')); };
          if (currentSignal.aborted) { abort(); return; }
          currentSignal.addEventListener('abort', abort, { once: true });
          const clean = () => currentSignal.removeEventListener('abort', abort);
          pending.set(id, { resolve(value) { clean(); resolve(value); }, reject(error) { clean(); reject(error); } });
          channel.send(JSON.stringify({ id, type, ...args })).catch(error => { pending.delete(id); clean(); reject(error); });
        });
        return { id, result };
      };
      const receive = async () => {
        try {
          while (!signal.aborted) {
            const msg = JSON.parse(String(await channel.receive(signal)));
            if (msg.type === 'event') events.get(msg.id)?.(msg.event);
            else { const call = pending.get(msg.id); pending.delete(msg.id); call?.resolve(msg.result); }
          }
        } catch { for (const call of pending.values()) call.reject(new Error('Disconnected')); pending.clear(); }
      };
      void receive();
      return {
        call: (id, args, operationSignal) => exchange(id, args, operationSignal).result,
        async subscribe(id, args, emit, operationSignal) {
          const request = exchange(id, args, operationSignal, emit);
          await request.result;
          return { async stop() { events.delete(request.id); await exchange('stop', { subscription: request.id }, signal).result; } };
        },
      };
    },
  },
}] });
