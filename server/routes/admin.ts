import { Hono, type Context } from 'hono';
import { type Env, requireAdmin, requireUser } from '../auth.ts';
import { badRequest } from '../http.ts';
import { applyPlan, checkUpdates, install, parseRepo, previewInstall, previewUpdates, uninstall, update, updateOptions, type GithubContext } from '../plugins/github.ts';
import { communityCatalog } from '../plugins/catalog.ts';
import { connectionOption } from '../plugins/github-access.ts';
import { callerFrom } from '../audit.ts';
import { type PluginRecord, pluginIcon, plugins } from '../plugins/manager.ts';
import { type Role, createInvite, createUser, deleteUser, getUser, listUsers, pendingInvites, updateUser } from '../users.ts';
import { createPeer, deletePeer, getPeer, listPeers, rotatePeerToken, updatePeer } from '../peers.ts';
import { createPeerLink, hasConfiguredPeers } from '../peer-settings.ts';

export const admin = new Hono<Env>();
admin.use('*', requireUser, requireAdmin);

const view = (p: PluginRecord) => ({
  id: p.id,
  name: p.manifest.name,
  version: p.manifest.version,
  description: p.manifest.description,
  dependencies: p.manifest.dependencies ?? [],
  dependencyVersions: p.manifest.dependencyVersions ?? {},
  dependents: [...plugins.plugins.values()].filter((o) => o.manifest.dependencies?.includes(p.id)).map((o) => o.id),
  origin: p.origin,
  overridesBuiltin: p.overridesBuiltin,
  source: p.source,
  enabled: p.enabled,
  status: p.status,
  error: p.error,
  hasSettings: !!p.manifest.settings?.length,
  services: p.services.map((s) => ({ id: s.id, name: s.name, methods: s.authMethods.map((m) => ({ id: m.id, name: m.name, unavailable: m.unavailable })) })),
  icon: pluginIcon(p),
  loadedAt: p.loadedAt,
});

admin.get('/plugins', (c) => c.json([...plugins.plugins.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map(view)));

const githubContext = (c: Context<Env>, githubConnectionId?: unknown): GithubContext => ({ user: c.get('user'), caller: callerFrom(c, 'plugin'), githubConnectionId: connectionOption(githubConnectionId) });

async function pluginRequest(c: Context<Env>): Promise<Record<string, any>> {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  return body;
}

// Static GET routes must precede /plugins/:id.
admin.get('/plugins/community', async (c) => {
  c.header('cache-control', 'no-store');
  return c.json(await communityCatalog());
});

admin.post('/plugins/install/plan', async (c) => {
  const { repo, ref, path, githubConnectionId, expectedId } = await pluginRequest(c);
  return c.json(await previewInstall(parseRepo(repo, ref, path), githubContext(c, githubConnectionId), expectedId));
});

admin.post('/plugins/update/plan', async (c) => {
  const { updates } = await pluginRequest(c);
  return c.json(await previewUpdates(updates, githubContext(c)));
});

admin.post('/plugins/apply', async (c) => {
  const { planId } = await pluginRequest(c);
  const result = await applyPlan(planId, githubContext(c));
  return c.json({ ...result, plugins: result.ids.map((id) => view(plugins.get(id))) });
});

admin.get('/plugins/:id', (c) => {
  const p = plugins.get(c.req.param('id'));
  return c.json({ ...view(p), logs: p.logs.slice(-100) });
});

admin.post('/plugins/install', async (c) => {
  const { repo, ref, path, githubConnectionId } = await pluginRequest(c);
  if (!repo) throw badRequest('repo is required');
  const ids = await install(parseRepo(repo, ref, path), githubContext(c, githubConnectionId));
  return c.json(ids.map((id) => view(plugins.get(id))));
});

admin.post('/plugins/check-updates', async (c) => c.json(await checkUpdates(githubContext(c))));

admin.post('/plugins/:id/update', async (c) => {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim()) {
    try { body = JSON.parse(raw); } catch { throw badRequest('Invalid JSON'); }
  }
  const r = await update(c.req.param('id'), updateOptions(body), githubContext(c));
  return c.json({ ...r, plugin: view(plugins.get(r.id)) });
});

admin.post('/plugins/:id/reload', async (c) => {
  const id = c.req.param('id');
  plugins.get(id);
  await plugins.reload([id]);
  return c.json(view(plugins.get(id)));
});

admin.patch('/plugins/:id', async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  await plugins.setEnabled(c.req.param('id'), !!enabled);
  return c.json(view(plugins.get(c.req.param('id'))));
});

admin.get('/plugins/:id/settings', (c) => c.json(plugins.settingsForAdmin(c.req.param('id'))));

admin.put('/plugins/:id/settings', async (c) => {
  await plugins.saveSettings(c.req.param('id'), await c.req.json());
  return c.json(view(plugins.get(c.req.param('id'))));
});

admin.delete('/plugins/:id', async (c) => {
  await uninstall(c.req.param('id'));
  return c.json({ ok: true });
});

// --- peers ---
async function peerMutation<T>(operation: () => T): Promise<T> {
  const before = hasConfiguredPeers(); const result = operation();
  if (before !== hasConfiguredPeers()) await plugins.reload([...plugins.plugins.keys()]);
  return result;
}
admin.get('/peers', c => c.json(listPeers()));
admin.get('/peers/:id', c => c.json(getPeer(c.req.param('id'))));
admin.post('/peers', async c => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a peer object');
  const owner = body.ownerUserId ?? c.get('user').id;
  if (body.direction !== undefined && !['incoming', 'outgoing'].includes(body.direction)) throw badRequest('Unknown peer direction');
  return c.json(await peerMutation(() => body.direction === 'outgoing'
    ? { peer: getPeer(createPeerLink(body, owner)) }
    : createPeer(body.name, owner)), 201);
});
admin.patch('/peers/:id', async c => { const body = await c.req.json(); return c.json(await peerMutation(() => updatePeer(c.req.param('id'), body))); });
admin.post('/peers/:id/rotate-token', c => c.json(rotatePeerToken(c.req.param('id'))));
admin.delete('/peers/:id', async c => { await peerMutation(() => deletePeer(c.req.param('id'))); return c.json({ ok: true }); });

// --- users ---

admin.get('/users', (c) => {
  const invites = pendingInvites();
  return c.json(listUsers().map((u) => ({ ...u, inviteExpiresAt: invites.get(u.id) ?? null })));
});

const role = (r: unknown): Role | undefined => (r === undefined ? undefined : r === 'admin' || r === 'user' ? r : (() => { throw badRequest('role must be admin or user'); })());

admin.post('/users', async (c) => {
  const b = await c.req.json<{ username: string; role?: Role; validHours?: number }>();
  const user = createUser(b.username ?? '', role(b.role) ?? 'user');
  return c.json({ user, invite: createInvite(user.id, b.validHours ?? 72) }, 201);
});

admin.patch('/users/:id', async (c) => {
  const b = await c.req.json<{ role?: Role; disabled?: boolean; username?: string }>();
  if (c.req.param('id') === c.get('user').id && (b.disabled || b.role === 'user')) throw badRequest('You cannot demote or disable yourself');
  return c.json(updateUser(c.req.param('id'), { role: role(b.role), disabled: b.disabled, username: b.username }));
});

admin.post('/users/:id/invite', async (c) => {
  const b = await c.req.json<{ validHours?: number }>().catch(() => ({}) as { validHours?: number });
  if (!getUser(c.req.param('id'))) throw badRequest('Unknown user');
  return c.json(createInvite(c.req.param('id'), b.validHours ?? 72));
});

admin.delete('/users/:id', async (c) => {
  if (c.req.param('id') === c.get('user').id) throw badRequest('You cannot delete yourself');
  await deleteUser(c.req.param('id'));
  return c.json({ ok: true });
});
