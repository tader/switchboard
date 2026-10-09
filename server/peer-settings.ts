import * as peerAccess from './peers.ts';
import { config } from './config.ts';
import { encrypt, decrypt, randomId } from './crypto.ts';
import { all, db, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import { connectionChanged } from './connection-events.ts';

export interface PeerStatus {
  state: 'connecting' | 'online' | 'offline' | 'disabled';
  connectedAt: number | null; lastSeenAt: number | null; lastError: string | null; nextRetryAt: number | null;
}
export const peerStatuses = new Map<string, PeerStatus>();
const listeners = new Set<() => void>();
export function onPeersChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function peersChanged() { for (const listener of listeners) listener(); }
export function configuredPeerLinks(): any[] { return all("SELECT * FROM peers WHERE removed = 0 AND direction = 'outgoing' ORDER BY created_at, id"); }
export function hasConfiguredPeers() { return !!one('SELECT 1 FROM peers WHERE removed = 0 LIMIT 1'); }
export function createPeerLink(input: any, ownerUserId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Expected a peer object');
  const name = validPeerName(input.name);
  const url = validPeerUrl(input.url);
  if (typeof input.token !== 'string' || !input.token.trim()) throw badRequest('A peer device token is required');
  if (!one('SELECT 1 FROM users WHERE id = ? AND disabled = 0', ownerUserId)) throw badRequest('Unknown owner');
  const id = randomId('peer'); const t = now();
  run(`INSERT INTO peers (id, name, owner_user_id, token_hash, direction, url, token_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'outgoing', ?, ?, ?, ?)`, id, name, ownerUserId, 'outgoing-' + id, url, encrypt(input.token.trim()), t, t);
  run('INSERT INTO peer_users(peer_id, user_id, created_at) VALUES (?, ?, ?)', id, ownerUserId, t);
  peersChanged(); return id;
}
export function validPeerName(raw: unknown, id = '') {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 100) throw badRequest('Give the peer a name of at most 100 characters');
  if (one('SELECT 1 FROM peers WHERE name = ? AND id != ?', name, id)) throw badRequest('A peer already has that name');
  return name;
}
export function validPeerUrl(raw: unknown) {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw badRequest('Enter an absolute peer URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw badRequest('Use an HTTP or HTTPS origin without a path, credentials, query or fragment');
  return url.origin;
}
export function peerToken(row: any): string { return decrypt(row.token_enc); }
export function connectionShares(userId: string, ref: string) {
  const row = ownedConnection(userId, ref);
  return { peerIds: all<{ peer_id: string }>('SELECT peer_id FROM connection_peer_shares WHERE connection_id = ? ORDER BY peer_id', row.id).map(r => r.peer_id) };
}
function ownedConnection(userId: string, ref: string) {
  const row = one('SELECT * FROM connections WHERE user_id = ? AND (id = ? OR name = ?)', userId, ref, ref);
  if (!row) throw notFound('Connection not found'); return row;
}
export function setConnectionShares(userId: string, ref: string, input: unknown) {
  const row = ownedConnection(userId, ref); const ids = (input as any)?.peerIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || ids.length > 100) throw badRequest('peerIds must be an array of peer ids');
  const unique = [...new Set<string>(ids)];
  for (const id of unique) {
    const peer = one('SELECT * FROM peers WHERE id = ? AND removed = 0', id);
    if (!peer) throw badRequest('Unknown peer');
    if (row.peer_id && !one('SELECT 1 FROM connection_peer_shares WHERE peer_id = ? AND connection_id = ?', id, row.id)) {
      const { peerConnection } = peerAccess;
      const source = peerConnection(userId, row.peer_id, row.remote_connection_id);
      if (row.peer_id === id || (peer.remote_instance_id && source.route.includes(peer.remote_instance_id))) throw badRequest('Sharing would create a peer cycle');
    }
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM connection_peer_shares WHERE connection_id = ?', row.id);
    for (const id of unique) run('INSERT INTO connection_peer_shares (peer_id, connection_id) VALUES (?, ?)', id, row.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  connectionChanged(row.id); peersChanged(); return connectionShares(userId, row.id);
}
export function sharedConnection(peerId: string, connectionId: string) {
  const row = one(`SELECT c.* FROM connections c JOIN connection_peer_shares sh ON sh.connection_id = c.id
    JOIN peers up ON up.id = sh.peer_id JOIN users u ON u.id = c.user_id
    WHERE sh.peer_id = ? AND c.id = ? AND up.disabled = 0 AND up.removed = 0 AND u.disabled = 0 AND u.peer_shadow = 0`, peerId, connectionId);
  if (!row) throw new HttpError(403, 'This connection is not shared with this peer');
  return row;
}
/** Idempotent conversion: environment variables are only a bootstrap, never an implicit grant. */
export function initializePeers() {
  if (!one('SELECT 1 FROM instance_settings WHERE key = ?', 'peer-bootstrap')) {
    if (!!config.peerUrl !== !!config.peerToken) throw new Error('SWITCHBOARD_PEER_URL and SWITCHBOARD_PEER_TOKEN must be set together');
    if (config.peerUrl && config.peerToken) createPeerLink({ name: 'Peer Switchboard', url: config.peerUrl, token: config.peerToken }, one("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at, id LIMIT 1").id);
    run('INSERT INTO instance_settings (key, value) VALUES (?, ?)', 'peer-bootstrap', 'done');
  }
  const admin = one("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND peer_shadow = 0 ORDER BY created_at, id LIMIT 1");
  if (!admin) return;
  for (const row of all('SELECT c.* FROM connections c JOIN users u ON u.id = c.user_id WHERE u.peer_shadow = 1 ORDER BY c.created_at, c.id')) {
    let name = row.name;
    for (let n = 2; one('SELECT 1 FROM connections WHERE user_id = ? AND name = ? AND id != ?', admin.id, name, row.id); n++) name = `${row.name}-${n}`;
    run('UPDATE connections SET user_id = ?, name = ? WHERE id = ?', admin.id, name, row.id);
  }
  run('DELETE FROM connect_flows WHERE peer_id IS NOT NULL');
}

export function setConnectionPeerShare(userId: string, ref: string, peerId: string, shared: unknown) {
  if (!one('SELECT 1 FROM peers WHERE id = ? AND removed = 0', peerId)) throw badRequest('Unknown peer');
  if (typeof shared !== 'boolean') throw badRequest('shared must be a boolean');
  const row = ownedConnection(userId, ref);
  const ids = connectionShares(userId, row.id).peerIds;
  return setConnectionShares(userId, row.id, { peerIds: shared ? [...new Set([...ids, peerId])] : ids.filter(id => id !== peerId) });
}
export function sharingMatrix(userId: string) {
  const shares = all<{ connection_id: string; peer_id: string }>(`SELECT sh.connection_id, sh.peer_id FROM connection_peer_shares sh
    JOIN connections c ON c.id = sh.connection_id JOIN peers p ON p.id = sh.peer_id WHERE c.user_id = ? AND p.removed = 0`, userId);
  const peers = all('SELECT id, remote_instance_id FROM peers WHERE removed = 0');
  const blocked: { connection_id: string; peer_id: string }[] = [];
  for (const c of all('SELECT id, peer_id, remote_connection_id FROM connections WHERE user_id = ? AND peer_id IS NOT NULL', userId)) {
    let route: string[] | null = null;
    try { route = peerAccess.peerConnection(userId, c.peer_id, c.remote_connection_id).route; } catch {}
    for (const p of peers) if (!route || p.id === c.peer_id || (p.remote_instance_id && route.includes(p.remote_instance_id))) blocked.push({ connection_id: c.id, peer_id: p.id });
  }
  return { shares, blocked };
}
