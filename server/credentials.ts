import { all, db, now, one, run } from './db.ts';
import { decrypt, encrypt, randomId } from './crypto.ts';
import { connectionChanged, credentialsChanged } from './connection-events.ts';
import { plugins } from './plugins/manager.ts';
import { allowedHosts } from './proxy.ts';
import { getConnectionRow, loadConnection, resolveBaseUrl, saveCredentials, withLock } from './connections.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import type { AuthMethod, Connection } from './plugins/api.ts';
import type { User } from './users.ts';

export function getCredential(userId: string, id: string) {
  if (typeof id !== 'string' || !id.trim()) throw badRequest('A credential ID is required');
  const row = one('SELECT * FROM credentials WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw notFound('Credential not found');
  return row;
}
export function credentialView(row: any) {
  let status = row.status; let statusMessage = row.status_message;
  try { sourceConnection(row); } catch { status = 'unavailable'; statusMessage = 'Credential provider is unavailable'; }
  return { id: row.id, name: row.name, kind: row.kind, status, statusMessage, version: row.version,
    account: row.account_label ? { id: row.account_id, label: row.account_label } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    connections: all('SELECT id, name, service_id AS serviceId, status, status_message AS statusMessage FROM connections WHERE credential_id = ? AND user_id = ? ORDER BY name', row.id, row.user_id) };
}
export const listCredentials = (userId: string) => all('SELECT * FROM credentials WHERE user_id = ? ORDER BY name', userId).map(credentialView);
export function sourceConnection(row: any): { conn: Connection; method: AuthMethod } {
  const service = plugins.service(row.service_id);
  const method = service?.authMethods.find(m => m.id === row.method_id);
  if (!method?.reusable || method.reusable.format !== row.format || method.reusable.kind !== row.kind || method.reusable.context(decrypt(row.config_enc)) !== decrypt(row.context_enc)) {
    for (const target of all('SELECT * FROM connections WHERE credential_id = ? AND user_id = ?', row.id, row.user_id)) {
      const alternative = plugins.service(target.service_id)?.authMethods.find(method => method.id === target.method_id);
      if (!alternative?.reusable || alternative.reusable.format !== row.format || alternative.reusable.kind !== row.kind) continue;
      const config = { ...Object.fromEntries(JSON.parse(row.config_keys).map((key: string) => [key, decrypt(row.config_enc)[key]])), ...decrypt(target.config_enc) };
      if (alternative.reusable.context(config) !== decrypt(row.context_enc)) continue;
      return { conn: { id: row.id, name: row.name, serviceId: target.service_id, methodId: target.method_id, config, credentials: importCredential(alternative, decrypt(row.credentials_enc)), account: row.account_label ? { id: row.account_id, label: row.account_label } : undefined }, method: alternative };
    }
    throw new HttpError(503, 'The credential provider is not available');
  }
  return { conn: { id: row.id, name: row.name, serviceId: row.service_id, methodId: row.method_id, config: decrypt(row.config_enc), credentials: importCredential(method, decrypt(row.credentials_enc)), account: row.account_label ? { id: row.account_id, label: row.account_label } : undefined }, method };
}
export const exportCredential = (method: AuthMethod, credentials: any) => method.reusable?.exportCredentials?.(credentials) ?? credentials;
export const importCredential = (method: AuthMethod, credentials: any) => method.reusable?.importCredentials?.(credentials) ?? credentials;
function reusable(method: AuthMethod) {
  const contract = method.reusable;
  if (!contract || !contract.validate || (contract.kind === 'oauth' && (!contract.allowRequest || !contract.grantedScopes || !contract.applyToken))) throw badRequest('This authentication method does not support safe credential reuse');
  return contract;
}
export function covers(method: AuthMethod, creds: any, config: Record<string, any>) {
  const reuse = reusable(method);
  const required = reuse.requiredScopes?.(config) ?? [];
  const granted = reuse.grantedScopes?.(creds) ?? [];
  return reuse.coversScopes ? reuse.coversScopes(granted, required) : required.every(scope => granted.includes(scope));
}
export function privateConfig(config: Record<string, any>, keys: string[]) { return Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key))); }
export function binding(conn: Connection, method: AuthMethod) {
  const service = plugins.service(conn.serviceId)!;
  return { context: reusable(method).context(conn.config), baseUrl: resolveBaseUrl(service, conn), hosts: [...allowedHosts(service, conn)].sort(), scopes: method.reusable?.requiredScopes?.(conn.config) ?? [] };
}
export function candidateConfig(source: any, config: Record<string, any>) {
  const lifecycle = decrypt(source.config_enc);
  const effective = { ...config };
  for (const key of JSON.parse(source.config_keys)) if (effective[key] === undefined || effective[key] === '') effective[key] = lifecycle[key];
  return effective;
}
export function ensureReusableTransport(conn: Connection, method: AuthMethod) {
  const service = plugins.service(conn.serviceId);
  if (method.reusable?.kind === 'oauth' && (service?.kind === 'mcp' || service?.websocket)) throw badRequest('OAuth reuse for protocol operations requires a dedicated permission policy; use a private authorization');
}
export function assertCompatible(source: any, conn: Connection, method: AuthMethod) {
  const reuse = reusable(method);
  ensureReusableTransport(conn, method);
  if (source.kind === 'oauth' && source.account_id && conn.account?.id && conn.account.id !== source.account_id) throw badRequest('The connection belongs to another OAuth account');
  if (source.format !== reuse.format || source.kind !== reuse.kind || decrypt(source.context_enc) !== reuse.context(conn.config)) throw badRequest('These credentials belong to an incompatible authority, client, or authentication format');
}
export function assertBinding(row: any, conn: Connection, method: AuthMethod) {
  if (!row.credential_id) return;
  const source = getCredential(row.user_id, row.credential_id);
  if (source.status !== 'ok') throw new HttpError(503, 'The shared credential needs reconnection');
  assertCompatible(source, conn, method);
  if (JSON.stringify(decrypt(row.credential_binding_enc)) !== JSON.stringify(binding(conn, method))) throw new HttpError(409, 'Credential destination or permissions changed; explicitly relink the connection');
  if (!covers(method, conn.credentials, conn.config)) throw new HttpError(403, 'The shared credential lacks the connection permissions');
}
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function notifyCredential(id: string, interrupt = true) {
  for (const row of all('SELECT id FROM connections WHERE credential_id = ?', id)) { credentialsChanged(row.id); if (interrupt) connectionChanged(row.id); }
}
export function replaceCredential(row: any, credentials: any, config?: Record<string, any>, account?: Connection['account'], interrupt = false) {
  const result = run("UPDATE credentials SET credentials_enc = ?, config_enc = ?, status = 'ok', status_message = NULL, version = version + 1, updated_at = ?, account_id = COALESCE(?, account_id), account_label = COALESCE(?, account_label), account_avatar = COALESCE(?, account_avatar) WHERE id = ? AND version = ?", encrypt(credentials), config ? encrypt(config) : row.config_enc, now(), account?.id ?? null, account?.label ?? null, account?.avatarUrl ?? null, row.id, row.version);
  if (!result.changes) throw new HttpError(409, 'The credential changed; reload before retrying');
  if (interrupt) run("UPDATE connections SET status = 'ok', status_message = NULL WHERE credential_id = ?", row.id);
  notifyCredential(row.id, interrupt);
}
export async function promoteCredential(user: User, ref: string, name: string) {
  if (typeof ref !== 'string' || !ref.trim()) throw badRequest('A source connection is required');
  return withLock(getConnectionRow(user.id, ref).id, async () => {
    const { row, conn, method } = loadConnection(user.id, ref, true);
    if (row.credential_id) return credentialView(getCredential(user.id, row.credential_id));
    const reuse = reusable(method);
    ensureReusableTransport(conn, method);
    if (typeof name !== 'string') throw badRequest('A credential name is required');
    const label = name.trim();
    if (!label || label.length > 100) throw badRequest('A credential name is required (maximum 100 characters)');
    if (one('SELECT 1 FROM credentials WHERE user_id = ? AND name = ?', user.id, label)) throw badRequest('A credential with that name already exists');
    if (reuse.kind === 'oauth' && method.token) {
      const fresh = await method.token(conn, {}).catch(() => { throw badRequest('Reconnect before reusing this OAuth credential'); });
      if (fresh.credentials !== undefined) { saveCredentials(row.id, fresh.credentials); conn.credentials = fresh.credentials; Object.assign(row, getConnectionRow(user.id, row.id)); }
    }
    if (!covers(method, conn.credentials, conn.config)) throw badRequest('Reconnect first to establish the granted OAuth permissions');
    try {
      const account = await reuse.validate!(conn);
      if (reuse.kind === 'oauth' && (!account?.id || (conn.account?.id && conn.account.id !== account.id))) throw new Error('Account mismatch');
      conn.account = account ?? conn.account;
    } catch { throw badRequest('The current credential could not be validated'); }
    const current = getConnectionRow(user.id, row.id);
    if (current.credential_id || current.credentials_enc !== row.credentials_enc || current.config_enc !== row.config_enc) throw new HttpError(409, 'The connection changed during validation; reload');
    const id = randomId('cred');
    transaction(() => {
      run('INSERT INTO credentials(id, user_id, name, service_id, method_id, format, kind, context_enc, config_keys, config_enc, credentials_enc, account_id, account_label, account_avatar, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, user.id, label, conn.serviceId, conn.methodId, reuse.format, reuse.kind, encrypt(reuse.context(conn.config)), JSON.stringify(reuse.configKeys ?? []), encrypt(conn.config), encrypt(exportCredential(method, conn.credentials)), conn.account?.id ?? null, conn.account?.label ?? null, conn.account?.avatarUrl ?? null, now(), now());
      run('UPDATE connections SET credential_id = ?, credential_binding_enc = ?, credentials_enc = NULL, config_enc = ?, account_id = COALESCE(?, account_id), account_label = COALESCE(?, account_label), account_avatar = COALESCE(?, account_avatar) WHERE id = ?', id, encrypt(binding(conn, method)), encrypt(privateConfig(conn.config, reuse.configKeys ?? [])), conn.account?.id ?? null, conn.account?.label ?? null, conn.account?.avatarUrl ?? null, row.id);
    });
    notifyCredential(id);
    return credentialView(getCredential(user.id, id));
  });
}
export async function linkCredential(user: User, ref: string, id: string) {
  const targetRow = getConnectionRow(user.id, ref); getCredential(user.id, id);
  if (targetRow.credential_id === id) return credentialView(getCredential(user.id, id));
  if (targetRow.credential_id) throw badRequest('Make this connection independent before changing its credential');
  return withLock(targetRow.id, () => withLock(id, async () => {
    const { row, conn, method } = loadConnection(user.id, ref, true);
    if (row.credential_id) throw new HttpError(409, 'The connection was linked elsewhere; reload');
    const source = getCredential(user.id, id);
    if (source.status !== 'ok') throw badRequest('Reconnect the credential before linking it');
    conn.config = candidateConfig(source, conn.config);
    assertCompatible(source, conn, method);
    if (!covers(method, importCredential(method, decrypt(source.credentials_enc)), conn.config)) throw Object.assign(new HttpError(409, 'Additional OAuth consent is required'), { code: 'CREDENTIAL_CONSENT_REQUIRED' });
    const candidate = { ...conn, credentials: importCredential(method, decrypt(source.credentials_enc)) };
    let account: Connection['account'];
    try { account = await reusable(method).validate!(candidate); } catch { throw badRequest('The shared credential could not authenticate to this connection'); }
    if (source.kind === 'oauth' && !account?.id) throw badRequest('The provider account could not be verified');
    const current = getCredential(user.id, source.id);
    if (current.version !== source.version || current.status !== 'ok') throw new HttpError(409, 'The credential changed during validation; reload');
    if (source.kind === 'oauth' && source.account_id && account?.id && source.account_id !== account.id) throw badRequest('The provider account does not match the shared credential');
    getConnectionRow(user.id, ref);
    run("UPDATE connections SET credential_id = ?, credential_binding_enc = ?, credentials_enc = NULL, status = 'ok', status_message = NULL, account_id = COALESCE(?, account_id), account_label = COALESCE(?, account_label), account_avatar = COALESCE(?, account_avatar), config_enc = ?, updated_at = ? WHERE id = ?", id, encrypt(binding(candidate, method)), account?.id ?? null, account?.label ?? null, account?.avatarUrl ?? null, encrypt(privateConfig(conn.config, JSON.parse(source.config_keys))), now(), row.id);
    connectionChanged(row.id); credentialsChanged(row.id);
    return credentialView(getCredential(user.id, id));
  }));
}
export async function credentialHealth(user: User, id: string) {
  const result: { id: string; name: string; status: string }[] = [];
  for (const row of all('SELECT id, name FROM connections WHERE credential_id = ? AND user_id = ?', id, user.id)) {
    let status = 'ok';
    try { const { conn, method } = loadConnection(user.id, row.id); await reusable(method).validate!(conn); } catch { status = 'error'; }
    run('UPDATE connections SET status = ?, status_message = ? WHERE id = ?', status, status === 'ok' ? null : 'Credential validation failed or service is unreachable', row.id);
    result.push({ ...row, status });
  }
  return result;
}
export async function rotateCredential(user: User, id: string, input: { version: number; config: Record<string, any> }) {
  return withLock(id, async () => {
    const source = getCredential(user.id, id);
    if (source.version !== input.version) throw new HttpError(409, 'The credential changed; reload before retrying');
    if (source.kind !== 'static') throw badRequest('OAuth credentials must be reconnected through the provider');
    const { conn, method } = sourceConnection(source);
    if (!method.reusable?.prepare) throw badRequest('This provider requires reconnection instead of direct rotation');
    let credentials: any;
    try { credentials = method.reusable.prepare(input.config, conn.credentials); } catch { throw badRequest('Replacement secret is required'); }
    const step = { credentials, config: conn.config, account: conn.account };
    let validated = false;
    const candidate = { ...conn, credentials: step.credentials, config: step.config ?? conn.config };
    for (const target of all('SELECT id FROM connections WHERE credential_id = ?', id)) {
      try { const loaded = loadConnection(user.id, target.id, true); const account = await reusable(loaded.method).validate!({ ...loaded.conn, credentials: importCredential(loaded.method, exportCredential(method, step.credentials)) }); if (loaded.conn.account?.id && account?.id && loaded.conn.account.id !== account.id) continue; validated = true; break; } catch {}
    }
    if (!validated) throw badRequest('The replacement could not be validated on a linked service; the current credential was kept');
    if (source.account_id && step.account?.id && source.account_id !== step.account.id) throw badRequest('The replacement belongs to another provider account');
    replaceCredential(source, exportCredential(method, candidate.credentials), candidate.config, step.account, true);
    const health = await credentialHealth(user, id);
    return { credential: credentialView(getCredential(user.id, id)), health };
  });
}
export async function independentCredential(user: User, ref: string) {
  const row = getConnectionRow(user.id, ref);
  if (!row.credential_id) return;
  return withLock(row.credential_id, async () => {
    const source = getCredential(user.id, row.credential_id);
    if (source.status !== 'ok') throw badRequest('Reconnect the credential before making a connection independent');
    if (source.kind === 'oauth') throw Object.assign(new HttpError(409, 'OAuth independence requires a fresh provider authorization'), { code: 'CREDENTIAL_REAUTHORIZE_REQUIRED' });
    const { conn } = loadConnection(user.id, ref, true);
    run('UPDATE connections SET credential_id = NULL, credential_binding_enc = NULL, credentials_enc = ?, config_enc = ?, updated_at = ? WHERE id = ?', encrypt(conn.credentials), encrypt(conn.config), now(), row.id);
    connectionChanged(row.id); credentialsChanged(row.id);
  });
}
export async function revokeCredential(user: User, id: string, version: number) {
  const row = getCredential(user.id, id);
  if (row.version !== version) throw new HttpError(409, 'The credential changed; reload before retrying');
  if (!run("UPDATE credentials SET status = 'revoked', status_message = 'Credential revoked', version = version + 1, updated_at = ? WHERE id = ? AND version = ?", now(), id, version).changes) throw new HttpError(409, 'The credential changed; reload');
  // Disable immediately, including while a provider refresh is still in flight.
  // Its eventual result cannot pass the version check and reactivate this source.
  notifyCredential(id);
  return withLock(id, async () => {
    try { const { conn, method } = sourceConnection(row); if (!method.revoke) return { providerRevocation: 'unsupported', credential: credentialView(getCredential(user.id, id)) }; await method.revoke(conn); }
    catch { return { providerRevocation: 'failed', credential: credentialView(getCredential(user.id, id)) }; }
    return { providerRevocation: 'requested', credential: credentialView(getCredential(user.id, id)) };
  });
}
export function deleteCredential(user: User, id: string) {
  getCredential(user.id, id);
  if (one('SELECT 1 FROM connections WHERE credential_id = ?', id)) throw new HttpError(409, 'Unlink or delete the connected services first');
  run('DELETE FROM credentials WHERE id = ? AND user_id = ?', id, user.id);
}
export function credentialCandidates(user: User, conn: Connection, method: AuthMethod) {
  reusable(method);
  const candidates: any[] = [];
  for (const source of all('SELECT * FROM credentials WHERE user_id = ?', user.id)) {
    try { const candidate = { ...conn, config: candidateConfig(source, conn.config) }; assertCompatible(source, candidate, method); candidates.push({ id: source.id, name: source.name, kind: 'credential', needsConsent: !covers(method, importCredential(method, decrypt(source.credentials_enc)), candidate.config), status: source.status }); } catch {}
  }
  for (const row of all('SELECT id, name FROM connections WHERE user_id = ? AND credential_id IS NULL AND peer_id IS NULL AND id != ?', user.id, conn.id)) {
    try { const loaded = loadConnection(user.id, row.id); const reuse = reusable(loaded.method); if (reuse.format === method.reusable!.format && reuse.context(loaded.conn.config) === method.reusable!.context(conn.config)) candidates.push({ id: row.id, name: row.name, kind: 'connection', needsConsent: !covers(method, loaded.conn.credentials, conn.config), status: loaded.row.status }); } catch {}
  }
  return candidates;
}
