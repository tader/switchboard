import { startLocalManager } from './local-manager.ts';
import { ensureUpdateIdentity, lifecycle, updates, updaterApi, startUpdateChecks } from './updates/control.ts';
import { runningBuild } from './updates/releases.ts';
import { lockInstance } from './updates/instance-lock.ts';
import { stopBrowserProfiles, sweepBrowserProfiles } from './browser-profiles.ts';
import { startContractCollectors } from './contracts/service.ts';
import { credentialsApi } from './routes/credentials.ts';
import { attachWebSocketProxy } from './websocket-proxy.ts';
import { stopWebSockets } from './websocket-transport.ts';
import { stopWebSocketSubscriptions } from './websocket.ts';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { config } from './config.ts';
import { initKey } from './crypto.ts';
import { initDb } from './db.ts';
import { recoverHistoricalConnectionErrors, sweepConnectFlows } from './connections.ts';
import { HttpError } from './http.ts';
import { plugins } from './plugins/manager.ts';
import { account } from './routes/account.ts';
import { admin } from './routes/admin.ts';
import { api, oauth, proxy } from './routes/connections.ts';
import { authorizationServerMetadata, authorizeApi, protectedResourceMetadata, registerEndpoint, selfRevoke, tokenEndpoint } from './routes/provider.ts';
import { mcp } from './mcp.ts';
import { cors } from 'hono/cors';
import { openapiDocument } from './self-openapi.ts';
import { ensureAdmin } from './users.ts';
import { prune } from './audit.ts';
import type { Env } from './auth.ts';
import { attachPeerWebSockets, startPeerAgent } from './peers.ts';
import { initializePeers } from './peer-settings.ts';
import { stopProviderMcp } from './provider-mcp.ts';

if (process.send) process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
fs.mkdirSync(config.dataDir, { recursive: true });
const unlockInstance = lockInstance(config.dataDir);
ensureUpdateIdentity();
runningBuild();
initKey();
initDb();
startLocalManager();

const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...((err as any).code ? { code: (err as any).code } : {}), ...((err as any).plan ? { plan: (err as any).plan } : {}) }, err.status as any);
  if (err instanceof SyntaxError && /JSON/.test(err.message)) return c.json({ error: 'Invalid JSON body' }, 400);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

// Nothing of Switchboard may be framed by other sites (the consent page would be clickjackable).
app.use('*', async (c, next) => {
  await next();
  c.header('x-frame-options', 'DENY');
  c.header('content-security-policy', "frame-ancestors 'none'");
  c.header('referrer-policy', 'same-origin');
});

app.use('*', async (c, next) => {
  const statusRead = c.req.method === 'GET' && ['/api/admin/updates', '/api/me'].includes(c.req.path);
  if (!statusRead && !['/healthz', '/readyz'].includes(c.req.path) && !c.req.path.startsWith('/api/updater/') && lifecycle.state !== 'open') { c.header('retry-after', '5'); return c.json({ error: 'Switchboard is restarting. Reconnect when ready; requests are not replayed.' }, 503); }
  await next();
});
app.route('/api/updater', updaterApi);
app.route('/api/admin/updates', updates);
app.get('/readyz', c => c.json({ ready: lifecycle.state === 'open' }, lifecycle.state === 'open' ? 200 : 503));
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/api/openapi.json', (c) => c.json(openapiDocument()));
app.route('/api/oauth/authorize', authorizeApi);

// OAuth discovery for MCP clients. Public and without credentials, so browser-based clients may read them.
const publicCors = cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'mcp-protocol-version'], maxAge: 86400 });
app.use('/.well-known/*', publicCors);
app.use('/oauth/token', publicCors);
app.use('/oauth/register', publicCors);
app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata()));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata()));
app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()));
app.route('/oauth/token', tokenEndpoint);
app.route('/oauth/register', registerEndpoint);
app.route('/mcp', mcp);
app.route('/api/me/token', selfRevoke);
app.route('/api', account);
app.route('/api/admin', admin);
app.route('/api', credentialsApi);
app.route('/api', api);
app.route('/proxy', proxy);
app.route('/oauth', oauth);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Web app
const index = path.join(config.webDir, 'index.html');
app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), config.webDir) || '.' , onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }));
app.use('*', serveStatic({ root: path.relative(process.cwd(), config.webDir) || '.' }));
app.get('*', (c) => {
  if (!fs.existsSync(index)) return c.text('The web app is not built. Run `npm run build` in web/.', 404);
  c.header('cache-control', 'no-cache');
  return c.html(fs.readFileSync(index, 'utf8'));
});

let stopPeerAgent = () => {};
let stopContracts: (() => unknown) | undefined;
let stopUpdateChecks = () => {};
let stopWebSocketProxy = () => {};
let stopPeerWebSockets = () => {};
const timers: NodeJS.Timeout[] = [];
let opening: Promise<void> | undefined;
lifecycle.open = async () => {
  if (lifecycle.state === 'open') return;
  if (opening) return opening;
  if (!['starting', 'staged'].includes(lifecycle.state)) throw new HttpError(409, 'Server is draining');
  // Opening is irreversible: plugin initialization can perform external writes.
  lifecycle.state = 'opening';
  opening = (async () => {
    recoverHistoricalConnectionErrors();
    const setupUrl = ensureAdmin();
    startLocalManager(setupUrl);
    initializePeers();
    await plugins.start();
    stopPeerAgent = startPeerAgent();
    stopContracts = config.sharedContracts ? startContractCollectors() : undefined;
    await sweepConnectFlows(); await sweepBrowserProfiles();
    timers.push(setInterval(() => { void sweepConnectFlows().then(() => sweepBrowserProfiles()).catch(() => {}); }, 30_000));
    prune(); timers.push(setInterval(prune, 6 * 3600_000));
    for (const timer of timers) timer.unref();
    stopUpdateChecks = startUpdateChecks();
    stopWebSocketProxy = attachWebSocketProxy(server as import('node:http').Server);
    stopPeerWebSockets = attachPeerWebSockets(server as import('node:http').Server);
    if (setupUrl && !process.send) console.log(`\nNo administrator can sign in yet. Set a password for "${config.adminUsername}" (valid 24 hours):\n${setupUrl}\n`);
    await listening;
    lifecycle.state = 'open';
    console.log(`Switchboard listening on ${config.host}:${config.port} (${config.publicUrl})`);
  })();
  return opening;
};

let markListening!: () => void;
const listening = new Promise<void>(resolve => { markListening = resolve; });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  markListening();
  if (lifecycle.state === 'staged') console.log('Switchboard staged; awaiting updater activation');
});
// Track HTTP lifetimes; long-lived streams are closed after the finite-request drain.
const requests = new Set<import('node:http').ServerResponse>();
server.on('request', (_req, res) => { requests.add(res); res.once('close', () => requests.delete(res)); });
let draining: Promise<void> | undefined;
lifecycle.drain = async () => {
  if (draining) return draining;
  lifecycle.state = 'draining';
  draining = (async () => {
    for (const timer of timers) clearInterval(timer);
    stopUpdateChecks(); stopPeerAgent(); await stopContracts?.();
    // Keep extension resources alive until finite calls have completed or the drain expires.
    // Arbitrary extension-owned producers have no separate pause contract.
    const deadline = Date.now() + 30_000;
    while ([...requests].some(r => !String(r.getHeader('content-type') ?? '').includes('text/event-stream') && !r.req.url?.startsWith('/api/updater/')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    stopWebSocketSubscriptions(); stopWebSockets(); stopProviderMcp();
    stopWebSocketProxy(); stopPeerWebSockets();
    await plugins.stop();
    await stopBrowserProfiles();
    for (const res of requests) if (!res.req.url?.startsWith('/api/updater/')) res.destroy();
  })();
  return draining;
};
if (lifecycle.state === 'starting') await lifecycle.open();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    try {
      await lifecycle.drain();
      server.close();
      unlockInstance();
      process.exit(0);
    } catch {
      // Retain the lease and gated process: an incomplete cleanup is not a safe snapshot boundary.
      console.error('Shutdown incomplete. The instance remains gated; owner recovery is required.');
    }
  });
}
