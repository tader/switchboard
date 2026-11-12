import { run } from './db.ts';
import { terminalAuthenticationError } from './auth-errors.ts';
/** Terminal structured failures only. Transient failures preserve the previous state. */
export function authenticationFailed(id: string, error: unknown) {
  if (terminalAuthenticationError(error)) run('INSERT OR REPLACE INTO connection_attention(connection_id,updated_at) VALUES(?,?)', id, Date.now());
}
export function authenticationRecovered(id: string) { run('DELETE FROM connection_attention WHERE connection_id = ?', id); }
