import { config } from './config.ts';
import { listServices, startConnect, completeFromPaste, completeRedirect, pollDevice, cancelFlow, deleteConnection, renameConnection, loadConnection } from './connections.ts';
import { plugins } from './plugins/manager.ts';
import { execute, type CallInput } from './proxy.ts';
import { describe } from './openapi.ts';
import { ensureSatelliteUser } from './users.ts';
import WebSocket from 'ws';
import { all, run } from './db.ts';

const PROTOCOL = 1;

export interface SatelliteAgentStatus {
  configured: boolean;
  centralUrl: string | null;
  state: 'not-configured' | 'connecting' | 'online' | 'offline';
  connectedAt: number | null;
  lastSeenAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
}

const agentStatus: SatelliteAgentStatus = {
  configured: false,
  centralUrl: null,
  state: 'not-configured',
  connectedAt: null,
  lastSeenAt: null,
  lastError: null,
  nextRetryAt: null,
};

export function satelliteAgentStatus(): SatelliteAgentStatus {
  return { ...agentStatus };
}

function socketUrl(base: string) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/satellites/connect';
  u.search = '';
  return u.toString();
}

function catalogue() {
  return {
    services: listServices().map((s) => ({
      ...s,
      methods: s.methods,
      hasOpenapi: !!plugins.service(s.id)?.openapi,
    })),
  };
}

function decodeInput(raw: any): CallInput {
  return {
    method: String(raw?.method ?? 'GET'),
    url: String(raw?.url ?? ''),
    pathParams: raw?.pathParams,
    query: raw?.query,
    headers: raw?.headers,
    body: raw?.body == null ? null : raw.bodyEncoding === 'base64' ? Buffer.from(String(raw.body), 'base64') : String(raw.body),
  };
}

async function handle(userId: string, operation: string, payload: any) {
  const user = ensureSatelliteUser(userId);
  switch (operation) {
    case 'connect.start':
      return startConnect(user, payload);
    case 'connect.complete':
      return { status: 'connected', connection: await completeFromPaste(String(payload.flowId), String(payload.url), user) };
    case 'connect.callback':
      return { status: 'connected', connection: await completeRedirect(String(payload.flowId), payload.params ?? {}, user) };
    case 'connect.poll':
      return pollDevice(String(payload.flowId), user);
    case 'connect.cancel':
      cancelFlow(String(payload.flowId), user);
      return { ok: true };
    case 'connection.rename':
      return renameConnection(user.id, String(payload.connection), String(payload.name));
    case 'connection.delete':
      await deleteConnection(user.id, String(payload.connection));
      return { ok: true };
    case 'user.delete':
      for (const row of all<{ id: string }>('SELECT id FROM connections WHERE user_id = ?', user.id)) await deleteConnection(user.id, row.id);
      run('DELETE FROM users WHERE id = ? AND satellite_shadow = 1', user.id);
      return { ok: true };
    case 'call': {
      const ex = await execute(user, String(payload.connection), decodeInput(payload.input));
      const body = Buffer.from(await ex.response.arrayBuffer());
      return {
        status: ex.response.status,
        statusText: ex.response.statusText,
        headers: [...ex.response.headers.entries()],
        body: body.toString('base64'),
        url: ex.url.toString(),
        durationMs: ex.durationMs,
        sent: { ...ex.sent, body: ex.sent.body == null ? undefined : Buffer.from(ex.sent.body as any).toString('base64'), bodyEncoding: ex.sent.body == null ? undefined : 'base64' },
      };
    }
    case 'openapi': {
      const { conn, service } = loadConnection(user.id, String(payload.connection));
      return describe(service, conn, !!payload.refresh);
    }
    default:
      throw Object.assign(new Error(`Unsupported satellite operation "${operation}"`), { status: 400 });
  }
}

export function startSatelliteAgent() {
  const central = config.satelliteCentralUrl;
  const token = config.satelliteToken;
  if (!central && !token) return () => {};
  if (!central || !token) throw new Error('SWITCHBOARD_SATELLITE_CENTRAL_URL and SWITCHBOARD_SATELLITE_TOKEN must be set together');
  Object.assign(agentStatus, { configured: true, centralUrl: central, state: 'connecting', connectedAt: null, lastError: null, nextRetryAt: null });
  let stopped = false;
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let catalogTimer: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryMs = 1_000;
  let sentCatalog = '';

  const connect = () => {
    if (stopped) return;
    agentStatus.state = 'connecting';
    agentStatus.nextRetryAt = null;
    socket = new WebSocket(socketUrl(central), { headers: { authorization: `Bearer ${token}` } });
    socket.addEventListener('open', () => {
      retryMs = 1_000;
      Object.assign(agentStatus, { state: 'online', connectedAt: Date.now(), lastSeenAt: Date.now(), lastError: null, nextRetryAt: null });
      const publishCatalog = () => {
        const catalog = catalogue();
        const serialized = JSON.stringify(catalog);
        if (serialized === sentCatalog || socket?.readyState !== WebSocket.OPEN) return;
        sentCatalog = serialized;
        socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'catalog', version: String(Date.now()), catalog }));
      };
      publishCatalog();
      catalogTimer = setInterval(publishCatalog, 2_000);
      heartbeat = setInterval(() => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'heartbeat' }));
        agentStatus.lastSeenAt = Date.now();
      }, 20_000);
    });
    socket.addEventListener('message', async (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        socket?.close(1007, 'Invalid JSON');
        return;
      }
      if (message.protocol !== PROTOCOL || message.type !== 'request') return;
      try {
        if (Date.now() > Number(message.deadline)) throw Object.assign(new Error('Request deadline expired'), { status: 504 });
        const result = await handle(String(message.userId), String(message.operation), message.payload);
        socket?.send(JSON.stringify({ protocol: PROTOCOL, type: 'result', requestId: message.requestId, result }));
      } catch (e: any) {
        socket?.send(JSON.stringify({ protocol: PROTOCOL, type: 'error', requestId: message.requestId, status: e?.status ?? 502, error: e?.message ?? String(e) }));
      }
    });
    socket.addEventListener('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (catalogTimer) clearInterval(catalogTimer);
      sentCatalog = '';
      if (!stopped) {
        const delay = retryMs + Math.floor(Math.random() * Math.min(retryMs, 5_000));
        Object.assign(agentStatus, { state: 'offline', connectedAt: null, nextRetryAt: Date.now() + delay });
        retry = setTimeout(connect, delay);
        retryMs = Math.min(retryMs * 2, 60_000);
      }
    });
    socket.addEventListener('error', (event: any) => { agentStatus.lastError = event?.error?.message ?? event?.message ?? 'WebSocket connection failed'; });
  };
  connect();
  return () => {
    stopped = true;
    Object.assign(agentStatus, { state: 'offline', connectedAt: null, nextRetryAt: null });
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    if (catalogTimer) clearInterval(catalogTimer);
    socket?.close(1000, 'Stopping');
  };
}
