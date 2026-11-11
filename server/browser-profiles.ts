import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { all, one, run, now } from './db.ts';
import { decrypt } from './crypto.ts';
import { badRequest, notFound } from './http.ts';
import { BrowserProfileLock } from './browser-profile-lock.ts';
import { CDP, findBrowser } from './authentication-browser.ts';
import type { AuthenticationProfile, AuthMethod, Connection } from './plugins/api.ts';

const lock = new BrowserProfileLock();
const active = new Map<string, { id: string; pluginId: string; parent?: AbortSignal; controller: AbortController; done: Promise<unknown> }>();
const reservations = new Map<string, { id: string; userId: string; pluginId: string; controller: AbortController; expires: number; migrate?: boolean }>();
const root = () => path.join(config.dataDir, 'browser-profiles');
const directory = (id: string) => path.join(root(), id);
const profile = (userId: string, id: string) => {
  const row = one('SELECT * FROM browser_profiles WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw notFound('Browser profile not found');
  return row;
};
function legacyDirectory(row: any) {
  const base = path.join(config.dataDir, 'plugin-data', row.legacy_plugin);
  const resolved = path.resolve(base, row.legacy_path);
  if (!resolved.startsWith(base + path.sep)) throw badRequest('Invalid legacy browser profile');
  return resolved;
}

// Corrupt/duplicated legacy references must not launch two processes on one disk
// directory. Keep metadata independent but conservatively serialize its provenance.
function lockKey(id: string): string {
  const row = one('SELECT * FROM browser_profiles WHERE id = ?', id);
  return row?.legacy_path ? 'legacy:' + legacyDirectory(row) : id;
}

/** Register each old connection independently; never infer shared identity from accounts. */
export function registerBrowserProfile(row: any, method: AuthMethod, pluginId: string): string | undefined {
  if (row.peer_id || !method.browserProfile) return undefined;
  if (row.browser_profile_id) return row.browser_profile_id;
  const connection: Connection = { id: row.id, name: row.name, serviceId: row.service_id, methodId: row.method_id, config: decrypt(row.config_enc) ?? {}, credentials: decrypt(row.credentials_enc) };
  const legacy = method.browserProfile.legacyPath?.(connection);
  if (!legacy) return undefined;
  const id = randomUUID();
  legacyDirectory({ legacy_plugin: pluginId, legacy_path: legacy });
  run('INSERT INTO browser_profiles(id,user_id,legacy_plugin,legacy_path,managed,browser_path,browser_family,created_at) VALUES(?,?,?,?,0,?,?,?)', id, row.user_id, pluginId, legacy, method.browserProfile.browserPath ?? null, method.browserProfile.browserFamily ?? null, now());
  run('UPDATE connections SET browser_profile_id = ? WHERE id = ? AND browser_profile_id IS NULL', id, row.id);
  row.browser_profile_id = id;
  return id;
}
export function registerServiceProfiles(serviceId: string, method: AuthMethod, pluginId: string) {
  for (const row of all('SELECT * FROM connections WHERE service_id = ? AND method_id = ? AND peer_id IS NULL', serviceId, method.id)) {
    try { registerBrowserProfile(row, method, pluginId); }
    catch { run("UPDATE connections SET status = 'error', status_message = 'Browser profile could not be registered; reconnect this connection' WHERE id = ?", row.id); }
  }
}
export function browserProfileView(userId: string, id: string) {
  const row = profile(userId, id);
  return { id: row.id as string, name: row.name as string | null, connections: all('SELECT id,name,service_id AS serviceId FROM connections WHERE user_id = ? AND browser_profile_id = ? ORDER BY created_at', userId, id) as {id:string;name:string;serviceId:string}[] };
}
export function listBrowserProfiles(userId: string) {
  return all('SELECT id FROM browser_profiles WHERE user_id = ? AND EXISTS(SELECT 1 FROM connections WHERE browser_profile_id = browser_profiles.id) ORDER BY created_at', userId).map(row => browserProfileView(userId, row.id));
}
export function renameBrowserProfile(userId: string, id: string, name: unknown) {
  profile(userId, id);
  if (typeof name !== 'string' || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw badRequest('Profile names must be at most 100 characters');
  run('UPDATE browser_profiles SET name = ? WHERE id = ?', name.trim() || null, id);
  return browserProfileView(userId, id);
}

// A completed copy is committed by atomic rename before metadata changes. The source
// is retained as an upgrade backup until the last reference disappears. Never merge.
export async function migrateBrowserProfile(userId: string, id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const row = profile(userId, id);
  if (row.managed) return;
  const source = legacyDirectory(row), target = directory(id), temp = target + '.copying';
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  try {
    await fs.access(target);
  } catch {
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { mode: 0o700 });
    try {
      // Chrome lock files reference a dead process and cannot be copied as symlinks.
      await fs.cp(source, temp, { recursive: true, force: false, filter: async file => {
        signal?.throwIfAborted();
        if (/^Singleton/.test(path.basename(file))) return false;
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Browser profile contains an unsupported symbolic link');
        return true;
      } });
      signal?.throwIfAborted();
      await fs.chmod(temp, 0o700);
      await fs.rename(temp, target);
    } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
  }
  run('UPDATE browser_profiles SET managed = 1 WHERE id = ?', id);
}

export async function reserveBrowserProfile(userId: string, pluginId: string, flowId: string, existingId?: string, selectedId?: string, name?: unknown): Promise<AuthenticationProfile> {
  if (existingId && selectedId && existingId !== selectedId) throw badRequest('Reconnect must keep its original browser profile');
  let id = existingId ?? selectedId;
  if (id) profile(userId, id);
  else { id = randomUUID(); run('INSERT INTO browser_profiles(id,user_id,created_at) VALUES(?,?,?)', id, userId, now()); }
  const reservation = { id, userId, pluginId, controller: new AbortController(), expires: now() + 900_000, migrate: !!selectedId && !existingId };
  reservations.set(flowId, reservation);
  try {
    if (name !== undefined) renameBrowserProfile(userId, id, name);
    return lease(userId, id, pluginId, reservation.controller.signal, reservation.migrate);
  } catch (error) { await releaseBrowserFlow(flowId); throw error; }
}
export function browserFlowDeadline(flowId: string, expires: number) { const r = reservations.get(flowId); if (r) r.expires = Math.min(r.expires, expires); }
export function flowBrowserProfile(flowId: string): AuthenticationProfile | undefined {
  const r = reservations.get(flowId);
  return r && lease(r.userId, r.id, r.pluginId, r.controller.signal, r.migrate);
}
export function commitBrowserProfile(flowId: string, connectionId: string) {
  const r = reservations.get(flowId);
  if (!r) throw badRequest('Browser sign-in expired; start again');
  r.controller.signal.throwIfAborted();
  const row = one('SELECT user_id,browser_profile_id FROM connections WHERE id = ?', connectionId);
  if (!row || row.user_id !== r.userId || (row.browser_profile_id && row.browser_profile_id !== r.id)) throw badRequest('The connection browser profile changed');
  run('UPDATE connections SET browser_profile_id = ? WHERE id = ?', r.id, connectionId);
}
export async function releaseBrowserFlow(flowId: string) {
  const r = reservations.get(flowId); if (!r) return;
  reservations.delete(flowId); r.controller.abort();
  await Promise.allSettled([...active.values()].filter(a => a.parent === r.controller.signal).map(a => a.done));
  await collectBrowserProfile(r.id);
}
export async function collectBrowserProfile(id: string) {
  if (one('SELECT 1 FROM connections WHERE browser_profile_id = ?', id) || [...reservations.values()].some(r => r.id === id)) return;
  await lock.run(lockKey(id), undefined, async () => {
    if (one('SELECT 1 FROM connections WHERE browser_profile_id = ?', id) || [...reservations.values()].some(r => r.id === id)) return;
    const row = one('SELECT * FROM browser_profiles WHERE id = ?', id); if (!row) return;
    await fs.rm(directory(id), { recursive: true, force: true });
    await fs.rm(directory(id) + '.copying', { recursive: true, force: true });
    if (row.legacy_path && !one('SELECT 1 FROM browser_profiles WHERE id != ? AND legacy_plugin = ? AND legacy_path = ?', id, row.legacy_plugin, row.legacy_path)) await fs.rm(legacyDirectory(row), { recursive: true, force: true });
    run('DELETE FROM browser_profiles WHERE id = ?', id);
  });
}
export function pluginBrowserProfiles(pluginId: string) {
  return { forConnection(connection: Connection) {
    const row = one('SELECT * FROM connections WHERE id = ? AND peer_id IS NULL', connection.id);
    if (!row || !row.browser_profile_id || !one('SELECT 1 FROM browser_profiles WHERE id = ? AND user_id = ?', row.browser_profile_id, row.user_id)) throw badRequest('No local browser profile for this connection');
    // Runtime plugin context is trusted, but a stale/forged Connection cannot select another plugin.
    if (!pluginOwns(pluginId, row.service_id)) throw badRequest('Browser profile belongs to another plugin connection');
    return lease(row.user_id, row.browser_profile_id, pluginId);
  } };
}
const owners = new Map<string, string>();
export const browserProfileOwner = (serviceId: string, pluginId: string) => { owners.set(serviceId, pluginId); };
const pluginOwns = (pluginId: string, serviceId: string) => owners.get(serviceId) === pluginId;
function lease(userId: string, id: string, pluginId: string, parent?: AbortSignal, migrate = false): AuthenticationProfile {
  return { id, run(options, operation) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(Math.max(options.timeoutMs ?? 360_000, 1), 900_000)), ...(options.signal ? [options.signal] : []), ...(parent ? [parent] : [])]);
    const done = lock.run(lockKey(id), signal, async () => {
      signal.throwIfAborted();
      if (migrate) await migrateBrowserProfile(userId, id, signal);
      signal.throwIfAborted();
      const row = profile(userId, id);
      const dir = row.managed ? directory(id) : legacyDirectory(row);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700);
      // Profiles must keep their original browser/OS cookie encryption context.
      // A reusing plugin’s executable preference must not silently switch it.
      const executable = await findBrowser(row.browser_path ?? (row.legacy_plugin ? undefined : options.browserPath), row.browser_family);
      if (!row.browser_path) run('UPDATE browser_profiles SET browser_path = ? WHERE id = ?', executable, id);
      const browser = new CDP(executable, dir, { headless: options.headless });
      const abort = () => { void browser.close(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        // Race plugin I/O too: a plugin that ignores cancellation cannot retain the lease.
        const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return await Promise.race([operation(browser, signal), aborted, browser.exit.then(() => { throw new Error('Authentication browser closed'); })]);
      } finally { signal.removeEventListener('abort', abort); await browser.close(); }
    });
    // Track queued operations as well as the running browser for hot reload and shutdown.
    const key = randomUUID(); active.set(key, { id, pluginId, parent, controller, done });
    done.finally(() => active.delete(key)).catch(() => {});
    return done;
  } };
}
export async function stopBrowserProfiles(pluginId?: string) {
  for (const [id, r] of reservations) if (!pluginId || r.pluginId === pluginId) { r.controller.abort(); reservations.delete(id); }
  const operations = [...active.values()].filter(r => !pluginId || r.pluginId === pluginId);
  for (const r of operations) r.controller.abort();
  await Promise.allSettled(operations.map(r => r.done));
}
export async function sweepBrowserProfiles() {
  for (const [id, r] of reservations) if (r.expires < now()) await releaseBrowserFlow(id);
  for (const row of all('SELECT id FROM browser_profiles')) await collectBrowserProfile(row.id);
}
