import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { config } from './config.ts';
import { initKey } from './crypto.ts';
import { initDb } from './db.ts';
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
import { attachSatelliteWebSockets } from './satellites.ts';
import { startSatelliteAgent } from './satellite-agent.ts';
import { stopUpstreamMcp } from './upstream-mcp.ts';

fs.mkdirSync(config.dataDir, { recursive: true });
initKey();
initDb();

const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...((err as any).code ? { code: (err as any).code } : {}) }, err.status as any);
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

await plugins.start();
const stopSatelliteAgent = startSatelliteAgent();
prune();
setInterval(prune, 6 * 3600_000).unref();

const setupUrl = ensureAdmin();
if (setupUrl) {
  console.log(`\nNo administrator can sign in yet. Set a password for "${config.adminUsername}" (valid 24 hours):\n${setupUrl}\n`);
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(`Switchboard listening on ${config.host}:${config.port} (${config.publicUrl})`);
});
const stopSatelliteWebSockets = attachSatelliteWebSockets(server as import('node:http').Server);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopUpstreamMcp();
    stopSatelliteWebSockets();
    stopSatelliteAgent();
    server.close();
    await plugins.stop().catch(() => {});
    process.exit(0);
  });
}
