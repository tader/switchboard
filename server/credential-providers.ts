import { AsyncLocalStorage } from 'node:async_hooks';
import { all } from './db.ts';
import { getConnectionRow, loadConnection, markError, saveCredentials, trackConnectionHealth, withLock } from './connections.ts';
import { peerConnection, requestPeer, syncPeerConnections } from './peers.ts';
import { record } from './audit.ts';
import { HttpError, badRequest } from './http.ts';
import type { AuthMethod, Connection, CredentialBundle } from './plugins/api.ts';

const context = new AsyncLocalStorage<{ userId: string; method: AuthMethod; config: Record<string, any> }>();
export function credentialCall<T>(userId: string, method: AuthMethod, config: Record<string, any>, fn: () => T): T {
  return context.run({ userId, method, config }, fn);
}

export function sourceDescriptor(userId: string, ref: string, format: string) {
  if (typeof ref !== 'string' || !ref) throw badRequest('An authentication source is required');
  const row = getConnectionRow(userId, ref);
  if (row.peer_id) {
    const descriptor = peerConnection(userId, row.peer_id, row.remote_connection_id);
    if (descriptor.route.length !== 1 || descriptor.credentialProvider?.format !== format) throw new HttpError(403, 'Authentication is no longer shared by this peer');
  } else {
    const loaded = loadConnection(userId, row.id, true);
    if (loaded.method.credentialProvider?.format !== format) throw new HttpError(403, 'The authentication source is unavailable or incompatible');
  }
  return row;
}

export function credentialProviders(userId: string, format: string) {
  if (!/^[a-zA-Z0-9/._-]{1,100}$/.test(format)) throw badRequest('Invalid authentication format');
  syncPeerConnections(userId);
  return all('SELECT * FROM connections WHERE user_id = ? ORDER BY name', userId).flatMap(row => {
    try {
      sourceDescriptor(userId, row.id, format);
      return [{ id: row.id, name: row.name, format, peer: row.peer_id ?? null, status: row.status }];
    } catch { return []; }
  });
}

export async function provideCredentials(userId: string, connectionId: string, format: string, forceAuthentication = false, signal?: AbortSignal): Promise<CredentialBundle> {
  const row = sourceDescriptor(userId, connectionId, format);
  if (row.peer_id) throw new HttpError(403, 'Authentication providers cannot be forwarded through another peer');
  return withLock(row.id, async () => {
    const { conn, method } = loadConnection(userId, row.id);
    const provider = method.credentialProvider;
    if (!provider || provider.format !== format) throw new HttpError(403, 'Incompatible authentication source');
    const started = Date.now();
    const recovered = trackConnectionHealth(row.id);
    try {
      const result = await credentialCall(userId, method, conn.config, () => provider.provide(conn, { forceAuthentication, signal, persistCredentials: value => { saveCredentials(row.id, value); } }));
      if (!result.account?.id || (conn.account?.id && result.account.id !== conn.account.id)) throw new HttpError(403, 'The authentication source changed accounts');
      if (result.credentials !== undefined) saveCredentials(row.id, result.credentials);
      const value = { format, bundle: result.bundle, account: result.account };
      if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new HttpError(502, 'Authentication bundle exceeded the size limit');
      recovered();
      record({ userId, connection: { id: row.id, name: conn.name, serviceId: conn.serviceId }, caller: { source: 'plugin', tokenId: null, tokenName: null, ip: null, userAgent: null }, method: 'CREDENTIAL', url: 'Provided authentication credentials', status: 200, durationMs: Date.now() - started });
      return value;
    } catch (error: any) {
      if (error?.code === 'signin_required') markError(row.id, 'Sign in to this authentication connection on its device');
      record({ userId, connection: { id: row.id, name: conn.name, serviceId: conn.serviceId }, caller: { source: 'plugin', tokenId: null, tokenName: null, ip: null, userAgent: null }, method: 'CREDENTIAL', url: 'Authentication source requires attention', status: 503, durationMs: Date.now() - started });
      throw new HttpError(503, error?.code === 'signin_required' ? 'Sign in to the authentication source on its device' : 'The authentication source could not supply credentials');
    }
  });
}

/** This function has no HTTP/token endpoint. Only a declared consumer in a user-scoped plugin call can use it. */
export async function obtainCredentials(ref: string, opts: { format: string; forceAuthentication?: boolean; signal?: AbortSignal }): Promise<CredentialBundle> {
  const current = context.getStore();
  const consumer = current?.method.credentialConsumer;
  if (!current || !consumer || consumer.format !== opts.format || current.config[consumer.field] !== ref) throw new HttpError(403, 'No compatible authentication source is bound to this operation');
  const row = sourceDescriptor(current.userId, ref, opts.format);
  if (!row.peer_id) return provideCredentials(current.userId, row.id, opts.format, opts.forceAuthentication, opts.signal);
  return requestPeer(row.peer_id, current.userId, 'credentials', { connection: row.remote_connection_id, format: opts.format, forceAuthentication: opts.forceAuthentication === true }, 120_000, opts.signal);
}

export function credentialMethod(userId: string, method: AuthMethod): AuthMethod {
  if (!method.credentialConsumer) return method;
  const wrap = <T>(conn: Connection, fn: () => T): T => {
    const consumer = method.credentialConsumer!;
    // A disconnected peer retains its last catalogue. An observed unshare blocks cached credentials too.
    sourceDescriptor(userId, conn.config[consumer.field], consumer.format);
    return credentialCall(userId, method, conn.config, fn);
  };
  return { ...method,
    authorize: (req, conn, opts) => wrap(conn, () => method.authorize(req, conn, { ...opts, persistCredentials: opts.persistCredentials ?? (value => { saveCredentials(conn.id, value); }) })),
    token: method.token && ((conn, opts) => wrap(conn, () => method.token!(conn, { ...opts, persistCredentials: opts.persistCredentials ?? (value => { saveCredentials(conn.id, value); }) }))),
  };
}
