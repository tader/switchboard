import { config } from './config.ts';
import { encrypt, decrypt, randomId } from './crypto.ts';
import { all, db, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import { connectionChanged } from './connection-events.ts';

export interface UpstreamStatus {
  state: 'connecting' | 'online' | 'offline' | 'disabled';
  connectedAt: number | null; lastSeenAt: number | null; lastError: string | null; nextRetryAt: number | null;
}
export const upstreamStatuses = new Map<string, UpstreamStatus>();
const listeners = new Set<() => void>();
export function onUpstreamsChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function upstreamsChanged() { for (const listener of listeners) listener(); }
export function configuredUpstreams(): any[] { return all('SELECT * FROM upstreams ORDER BY created_at, id'); }
export function hasConfiguredUpstreams() { return !!one('SELECT 1 FROM upstreams LIMIT 1'); }
export function listUpstreams() {
  return configuredUpstreams().map(r => ({ id: r.id, name: r.name, url: r.url, enabled: !!r.enabled, hasToken: true,
    ...({ state: r.enabled ? 'offline' : 'disabled', connectedAt: null, lastSeenAt: null, lastError: null, nextRetryAt: null } as UpstreamStatus),
    ...upstreamStatuses.get(r.id), sharedConnections: one('SELECT COUNT(*) AS n FROM connection_upstream_shares WHERE upstream_id = ?', r.id).n,
    createdAt: r.created_at, updatedAt: r.updated_at }));
}
function normalized(input: any, previous?: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Expected an upstream object');
  const name = input.name === undefined ? previous?.name : typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) throw badRequest('Give the upstream a name of at most 100 characters');
  let url: URL;
  try { url = new URL(input.url === undefined ? previous?.url : input.url); } catch { throw badRequest('Enter an absolute upstream URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw badRequest('Upstream URL must use HTTP or HTTPS without credentials, query or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw badRequest('Use the upstream origin URL without a path');
  const token = input.token === undefined || input.token === '' ? previous?.token_enc : typeof input.token === 'string' && input.token.trim() ? encrypt(input.token.trim()) : undefined;
  if (!token) throw badRequest('An upstream device token is required');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
  if (one('SELECT 1 FROM upstreams WHERE name = ? AND id != ?', name, previous?.id ?? '')) throw badRequest('An upstream already has that name');
  return { name, url: url.origin, token, enabled: input.enabled ?? (previous ? !!previous.enabled : true) };
}
export function createUpstream(input: unknown) {
  const v = normalized(input); const id = randomId('upstream'); const t = now();
  run('INSERT INTO upstreams (id, name, url, token_enc, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, v.name, v.url, v.token, +v.enabled, t, t);
  upstreamsChanged(); return listUpstreams().find(u => u.id === id)!;
}
export function updateUpstream(id: string, input: unknown) {
  const previous = one('SELECT * FROM upstreams WHERE id = ?', id); if (!previous) throw notFound('Upstream not found');
  const v = normalized(input, previous);
  run('UPDATE upstreams SET name = ?, url = ?, token_enc = ?, enabled = ?, updated_at = ? WHERE id = ?', v.name, v.url, v.token, +v.enabled, now(), id);
  upstreamsChanged(); return listUpstreams().find(u => u.id === id)!;
}
export function deleteUpstream(id: string) {
  if (!one('SELECT 1 FROM upstreams WHERE id = ?', id)) throw notFound('Upstream not found');
  run('DELETE FROM upstreams WHERE id = ?', id); upstreamsChanged();
}
export function upstreamToken(row: any): string { return decrypt(row.token_enc); }
export function connectionShares(userId: string, ref: string) {
  const row = ownedConnection(userId, ref);
  return { upstreamIds: all<{ upstream_id: string }>('SELECT upstream_id FROM connection_upstream_shares WHERE connection_id = ? ORDER BY upstream_id', row.id).map(r => r.upstream_id) };
}
function ownedConnection(userId: string, ref: string) {
  const row = one('SELECT * FROM connections WHERE user_id = ? AND (id = ? OR name = ?)', userId, ref, ref);
  if (!row) throw notFound('Connection not found'); return row;
}
export function setConnectionShares(userId: string, ref: string, input: unknown) {
  const row = ownedConnection(userId, ref); const ids = (input as any)?.upstreamIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || ids.length > 100) throw badRequest('upstreamIds must be an array of upstream ids');
  const unique = [...new Set<string>(ids)];
  for (const id of unique) if (!one('SELECT 1 FROM upstreams WHERE id = ?', id)) throw badRequest('Unknown upstream');
  db.exec('BEGIN');
  try {
    run('DELETE FROM connection_upstream_shares WHERE connection_id = ?', row.id);
    for (const id of unique) run('INSERT INTO connection_upstream_shares (upstream_id, connection_id) VALUES (?, ?)', id, row.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  connectionChanged(row.id); upstreamsChanged(); return connectionShares(userId, row.id);
}
export function sharedConnection(upstreamId: string, connectionId: string) {
  const row = one(`SELECT c.* FROM connections c JOIN connection_upstream_shares sh ON sh.connection_id = c.id
    JOIN upstreams up ON up.id = sh.upstream_id JOIN users u ON u.id = c.user_id
    WHERE sh.upstream_id = ? AND c.id = ? AND up.enabled = 1 AND u.disabled = 0 AND u.satellite_shadow = 0`, upstreamId, connectionId);
  if (!row) throw new HttpError(403, 'This connection is not shared with this upstream');
  return row;
}
/** Idempotent conversion: environment variables are only a bootstrap, never an implicit grant. */
export function initializeUpstreams() {
  if (!one('SELECT 1 FROM instance_settings WHERE key = ?', 'upstream-bootstrap')) {
    if (!!config.satelliteCentralUrl !== !!config.satelliteToken) throw new Error('SWITCHBOARD_SATELLITE_CENTRAL_URL and SWITCHBOARD_SATELLITE_TOKEN must be set together');
    if (config.satelliteCentralUrl && config.satelliteToken) createUpstream({ name: 'Upstream Switchboard', url: config.satelliteCentralUrl, token: config.satelliteToken });
    run('INSERT INTO instance_settings (key, value) VALUES (?, ?)', 'upstream-bootstrap', 'done');
  }
  const admin = one("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND satellite_shadow = 0 ORDER BY created_at, id LIMIT 1");
  if (!admin) return;
  for (const row of all('SELECT c.* FROM connections c JOIN users u ON u.id = c.user_id WHERE u.satellite_shadow = 1 ORDER BY c.created_at, c.id')) {
    let name = row.name;
    for (let n = 2; one('SELECT 1 FROM connections WHERE user_id = ? AND name = ? AND id != ?', admin.id, name, row.id); n++) name = `${row.name}-${n}`;
    run('UPDATE connections SET user_id = ?, name = ? WHERE id = ?', admin.id, name, row.id);
  }
  run('DELETE FROM connect_flows WHERE satellite_id IS NOT NULL');
}
