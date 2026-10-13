import { peerConnection } from './peers.ts';
import type { Context } from 'hono';
import type { Env } from './auth.ts';
import { sha256 } from './crypto.ts';
import { one } from './db.ts';
import { getConnectionRow } from './connections.ts';
import { HttpError } from './http.ts';
import type { User } from './users.ts';
import { sharedConnection } from './peer-settings.ts';

export interface WebSocketAccess {
  user: User;
  principal: string;
  peerId?: string;
  check(connectionId: string): void;
}
export function websocketAccess(c: Context<Env>): WebSocketAccess {
  const user = c.get('user');
  const token = c.get('token');
  const sessionHash = !token && c.get('sessionToken') ? sha256(c.get('sessionToken')!) : undefined;
  const mcpEndpoint = c.req.path === '/mcp' || c.req.path === '/mcp/';
  const principal = token ? `token:${token.id}` : `session:${sessionHash}`;
  return { user, principal, check(id) {
    if (!one('SELECT 1 FROM users WHERE id = ? AND disabled = 0', user.id)) throw new HttpError(403, 'Access revoked');
    const connection = getConnectionRow(user.id, id);
    if (connection.peer_id) peerConnection(user.id, connection.peer_id, connection.remote_connection_id);
    if (token) {
      const row = one('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?', token.id, user.id);
      if (!row || (row.expires_at && row.expires_at <= Date.now()) || (row.audience === 'mcp' && !mcpEndpoint)) throw new HttpError(403, 'Access revoked or expired');
      if (row.connection_ids && !JSON.parse(row.connection_ids).includes(id)) throw new HttpError(403, 'This token cannot use that connection');
    } else if (!sessionHash || !one('SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?', sessionHash, user.id, Date.now())) throw new HttpError(403, 'Session expired');
  } };
}
export function peerWebsocketAccess(user: User, peerId: string, peerUserId: string, tokenId: string): WebSocketAccess {
  return { user, peerId, principal: JSON.stringify(['peer', peerId, peerUserId, tokenId]), check(id) {
    const row = sharedConnection(peerId, id);
    if (row.user_id !== user.id || !one('SELECT 1 FROM users WHERE id = ? AND disabled = 0', user.id)) throw new HttpError(403, 'Shared connection access revoked');
  } };
}
