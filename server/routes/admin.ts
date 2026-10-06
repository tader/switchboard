import { Hono } from 'hono';
import { type Env, requireAdmin, requireUser } from '../auth.ts';
import { badRequest } from '../http.ts';
import { checkUpdates, install, parseRepo, uninstall, update } from '../plugins/github.ts';
import { type PluginRecord, pluginIcon, plugins } from '../plugins/manager.ts';
import { type Role, createInvite, createUser, deleteUser, getUser, listUsers, pendingInvites, updateUser } from '../users.ts';
import { createSatellite, deleteSatellite, getSatellite, listSatellites, rotateSatelliteToken, updateSatellite } from '../satellites.ts';
import { satelliteAgentStatus } from '../satellite-agent.ts';

export const admin = new Hono<Env>();
admin.use('*', requireUser, requireAdmin);

const view = (p: PluginRecord) => ({
  id: p.id,
  name: p.manifest.name,
  version: p.manifest.version,
  description: p.manifest.description,
  dependencies: p.manifest.dependencies ?? [],
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

admin.get('/plugins/:id', (c) => {
  const p = plugins.get(c.req.param('id'));
  return c.json({ ...view(p), logs: p.logs.slice(-100) });
});

admin.post('/plugins/install', async (c) => {
  const { repo, ref, path } = await c.req.json<{ repo: string; ref?: string; path?: string }>();
  if (!repo) throw badRequest('repo is required');
  const ids = await install(parseRepo(repo, ref, path));
  return c.json(ids.map((id) => view(plugins.get(id))));
});

admin.post('/plugins/check-updates', async (c) => c.json(await checkUpdates()));

admin.post('/plugins/:id/update', async (c) => {
  const r = await update(c.req.param('id'));
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

// --- satellites ---

admin.get('/satellites', (c) => c.json(listSatellites()));
admin.get('/satellite-upstream', (c) => c.json(satelliteAgentStatus()));

admin.get('/satellites/:id', (c) => c.json(getSatellite(c.req.param('id'))));

admin.post('/satellites', async (c) => {
  const b = await c.req.json<{ name: string; ownerUserId?: string }>();
  return c.json(createSatellite(b.name, b.ownerUserId ?? c.get('user').id), 201);
});

admin.patch('/satellites/:id', async (c) => {
  const b = await c.req.json<{ name?: string; disabled?: boolean; userIds?: string[] }>();
  return c.json(updateSatellite(c.req.param('id'), b));
});

admin.post('/satellites/:id/rotate-token', (c) => c.json(rotateSatelliteToken(c.req.param('id'))));

admin.delete('/satellites/:id', (c) => {
  deleteSatellite(c.req.param('id'));
  return c.json({ ok: true });
});

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
