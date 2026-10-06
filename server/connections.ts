import { callbackUrl } from './config.ts';
import { decrypt, encrypt, randomId, randomToken } from './crypto.ts';
import { all, now, one, run } from './db.ts';
import { HttpError, badRequest, notFound } from './http.ts';
import type { AuthMethod, ConnectArgs, ConnectStep, Connected, Connection, Field, ServiceDefinition } from './plugins/api.ts';
import { plugins } from './plugins/manager.ts';
import type { User } from './users.ts';
import { getSatellite, parseRemoteServiceId, remoteServiceId, requestSatellite, satelliteService, servicesForUser } from './satellites.ts';

export interface ConnectionView {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  methodId: string;
  methodName: string;
  account: { id?: string; label: string; avatarUrl?: string } | null;
  /** Non-secret config values the user entered. */
  config: Record<string, any>;
  status: 'ok' | 'error' | 'unavailable';
  statusMessage: string | null;
  baseUrl: string | null;
  hasOpenapi: boolean;
  canIssueToken: boolean;
  /** Redirect URI used instead of Switchboard's own when signing in; suggested again on reconnect. */
  redirectUri: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  satellite: { id: string; name: string; online: boolean; lastSeenAt: number | null } | null;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._@+-]{0,99}$/;

function rowToConnection(r: any): Connection {
  return {
    id: r.id,
    name: r.name,
    serviceId: r.service_id,
    methodId: r.method_id,
    config: decrypt(r.config_enc) ?? {},
    credentials: decrypt(r.credentials_enc),
    account: r.account_label ? { id: r.account_id ?? undefined, label: r.account_label, avatarUrl: r.account_avatar ?? undefined } : undefined,
  };
}

export function findMethod(service: ServiceDefinition, methodId: string): AuthMethod | undefined {
  return service.authMethods.find((m) => m.id === methodId);
}

function publicConfig(fields: Field[] | undefined, configValues: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const f of fields ?? []) if (f.type !== 'secret' && configValues[f.key] !== undefined) out[f.key] = configValues[f.key];
  return out;
}

export function resolveBaseUrl(service: ServiceDefinition, conn: Connection): string | undefined {
  const b = typeof service.baseUrl === 'function' ? service.baseUrl(conn) : service.baseUrl;
  return b || undefined;
}

export function toView(r: any): ConnectionView {
  const conn = rowToConnection(r);
  if (r.satellite_id) {
    const parsed = parseRemoteServiceId(conn.serviceId);
    let sat: any;
    let remote: any;
    try {
      sat = getSatellite(r.satellite_id);
      remote = sat.services.find((s: any) => s.id === parsed?.serviceId);
    } catch {}
    const method = remote?.methods?.find((m: any) => m.id === conn.methodId);
    const offline = !sat?.online;
    return {
      id: conn.id, name: conn.name, serviceId: conn.serviceId, serviceName: remote?.name ?? parsed?.serviceId ?? conn.serviceId,
      methodId: conn.methodId, methodName: method?.name ?? conn.methodId, account: conn.account ?? null,
      config: conn.config, status: offline ? 'unavailable' : r.status,
      statusMessage: offline ? `${sat?.name ?? 'Satellite'} is offline${sat?.lastSeenAt ? ` (last seen ${new Date(sat.lastSeenAt).toISOString()})` : ''}` : r.status_message,
      baseUrl: null, hasOpenapi: !!remote?.hasOpenapi, canIssueToken: false, redirectUri: r.redirect_uri ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at,
      satellite: sat ? { id: sat.id, name: sat.name, online: sat.online, lastSeenAt: sat.lastSeenAt } : { id: r.satellite_id, name: r.satellite_id, online: false, lastSeenAt: null },
    };
  }
  const service = plugins.service(conn.serviceId);
  const method = service && findMethod(service, conn.methodId);
  let baseUrl: string | null = null;
  try {
    baseUrl = (service && resolveBaseUrl(service, conn)) ?? null;
  } catch {}
  const unavailable = !service ? 'The plugin providing this service is not active' : !method ? 'This sign-in method is no longer offered' : null;
  return {
    id: conn.id,
    name: conn.name,
    serviceId: conn.serviceId,
    serviceName: service?.name ?? conn.serviceId,
    methodId: conn.methodId,
    methodName: method?.name ?? conn.methodId,
    account: conn.account ?? null,
    config: publicConfig(method?.fields, conn.config),
    status: unavailable ? 'unavailable' : r.status,
    statusMessage: unavailable ?? r.status_message,
    baseUrl,
    hasOpenapi: !!service?.openapi,
    canIssueToken: !!method?.token,
    redirectUri: r.redirect_uri ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
    satellite: null,
  };
}

export function listConnections(userId: string, only?: string[] | null): ConnectionView[] {
  return all('SELECT * FROM connections WHERE user_id = ? ORDER BY service_id, name COLLATE NOCASE', userId)
    .filter((r) => !only || only.includes(r.id))
    .map(toView);
}

/** Looks a connection up by id or name. */
export function getConnectionRow(userId: string, ref: string): any {
  const r = one('SELECT * FROM connections WHERE user_id = ? AND (id = ? OR name = ?)', userId, ref, ref);
  if (!r) throw notFound(`Connection "${ref}" not found`);
  return r;
}

export function loadConnection(userId: string, ref: string) {
  const row = getConnectionRow(userId, ref);
  if (row.satellite_id) throw new HttpError(500, 'Satellite connections must be executed through the satellite transport');
  const conn = rowToConnection(row);
  const service = plugins.service(conn.serviceId);
  if (!service) throw new HttpError(503, `Service "${conn.serviceId}" is not available (its plugin is not active)`);
  const method = findMethod(service, conn.methodId);
  if (!method) throw new HttpError(503, `Sign-in method "${conn.methodId}" is no longer offered by ${service.name}`);
  return { row, conn, service, method };
}

export function renameConnection(userId: string, ref: string, name: string) {
  const row = getConnectionRow(userId, ref);
  name = name.trim();
  if (!NAME.test(name)) throw badRequest('Names may contain letters, digits, ".", "_", "@", "+" and "-"');
  if (one('SELECT 1 FROM connections WHERE user_id = ? AND name = ? AND id != ?', userId, name, row.id)) throw badRequest('You already have a connection with that name');
  run('UPDATE connections SET name = ?, updated_at = ? WHERE id = ?', name, now(), row.id);
  return toView(one('SELECT * FROM connections WHERE id = ?', row.id));
}

export async function deleteConnection(userId: string, ref: string) {
  const row = getConnectionRow(userId, ref);
  if (row.satellite_id) {
    await requestSatellite(row.satellite_id, userId, 'connection.delete', { connection: row.remote_connection_id });
    run('DELETE FROM connections WHERE id = ?', row.id);
    run('UPDATE saved_calls SET connection_id = NULL WHERE connection_id = ?', row.id);
    return;
  }
  const conn = rowToConnection(row);
  const service = plugins.service(conn.serviceId);
  const method = service && findMethod(service, conn.methodId);
  try {
    await method?.revoke?.(conn);
  } catch (e: any) {
    console.warn(`revoke failed for ${conn.id}: ${e.message}`);
  }
  run('DELETE FROM connections WHERE id = ?', row.id);
  run('UPDATE saved_calls SET connection_id = NULL WHERE connection_id = ?', row.id);
}

export function saveCredentials(id: string, credentials: unknown) {
  run(`UPDATE connections SET credentials_enc = ?, status = 'ok', status_message = NULL, updated_at = ? WHERE id = ?`, encrypt(credentials), now(), id);
}

export function markError(id: string, message: string) {
  run(`UPDATE connections SET status = 'error', status_message = ?, updated_at = ? WHERE id = ?`, message.slice(0, 500), now(), id);
}

export function touch(id: string) {
  run('UPDATE connections SET last_used_at = ? WHERE id = ?', now(), id);
}

// --- per-connection lock so concurrent requests do not refresh the same token twice ---

const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return p;
}

// --- connect flows ---

export interface ServiceView {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  docsUrl?: string;
  pluginId: string;
  methods: { id: string; name: string; description?: string; fields: Field[]; unavailable?: string; redirect: boolean }[];
  satellite?: { id: string; name: string; online: boolean };
}

export function listServices(userId?: string): ServiceView[] {
  const local = [...plugins.services.values()]
    .map(({ service: s, pluginId }) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      icon: s.icon,
      docsUrl: s.docsUrl,
      pluginId,
      methods: s.authMethods.map((m) => ({ id: m.id, name: m.name, description: m.description, fields: m.fields ?? [], unavailable: m.unavailable, redirect: !!m.callback })),
    }))
  const remote: ServiceView[] = userId ? servicesForUser(userId).map(({ satellite, service }) => ({
    id: remoteServiceId(satellite.id, service.id),
    name: service.name,
    description: service.description,
    icon: service.icon,
    pluginId: service.pluginId,
    methods: service.methods.map((m) => ({ id: m.id, name: m.name, description: m.description, fields: (m.fields ?? []) as Field[], unavailable: !satellite.online ? `${satellite.name} is offline` : m.unavailable, redirect: !!m.redirect })),
    satellite: { id: satellite.id, name: satellite.name, online: satellite.online },
  })) : [];
  return [...local, ...remote].sort((a, b) => a.name.localeCompare(b.name));
}

export type FlowResult =
  | { status: 'connected'; connection: ConnectionView }
  /** `manual`: the provider redirects to a URI other than Switchboard's; the user pastes the address it sent them to. */
  | { status: 'redirect'; flowId: string; url: string; manual?: boolean }
  | { status: 'device'; flowId: string; device: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn?: number; interval: number } };

function validateConfig(method: AuthMethod, input: Record<string, any>, previous?: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const f of method.fields ?? []) {
    let v = input[f.key];
    // Secrets left empty on reconnect keep their previous value.
    if ((v === undefined || v === '') && f.type === 'secret' && previous?.[f.key] !== undefined) v = previous[f.key];
    if (v === undefined || v === '') v = f.default;
    if (f.type === 'boolean') v = v === true || v === 'true';
    else if (v !== undefined && v !== null) v = String(v).trim();
    if (f.required && (v === undefined || v === '')) throw badRequest(`${f.label} is required`);
    if (f.type === 'select' && v && f.options && !f.options.some((o) => o.value === v)) throw badRequest(`Invalid value for ${f.label}`);
    if (f.type === 'url' && v) {
      try {
        new URL(v);
      } catch {
        throw badRequest(`${f.label} must be a URL`);
      }
    }
    if (v !== undefined && v !== '') out[f.key] = v;
  }
  return out;
}

export async function startConnect(
  user: User,
  input: { service: string; method?: string; config?: Record<string, any>; name?: string; connection?: string; redirectUri?: string },
): Promise<FlowResult> {
  const existingRow = input.connection ? getConnectionRow(user.id, input.connection) : undefined;
  const remoteParsed = existingRow?.satellite_id
    ? parseRemoteServiceId(existingRow.service_id)
    : parseRemoteServiceId(input.service);
  if (remoteParsed) return startRemoteConnect(user, input, existingRow, remoteParsed);
  let existing: Connection | undefined;
  if (input.connection) existing = rowToConnection(getConnectionRow(user.id, input.connection));
  const serviceId = existing?.serviceId ?? input.service;
  const service = plugins.service(serviceId);
  if (!service) throw badRequest(`Unknown service "${serviceId}"`);
  const methodId = input.method ?? existing?.methodId ?? service.authMethods.find((m) => !m.unavailable)?.id;
  const method = methodId ? findMethod(service, methodId) : undefined;
  if (!method) throw badRequest(`Unknown sign-in method "${methodId}"`);
  if (method.unavailable) throw badRequest(method.unavailable);
  const sameMethod = existing && existing.methodId === method.id;
  const cfg = validateConfig(method, input.config ?? {}, sameMethod ? existing!.config : undefined);
  if (input.name && !NAME.test(input.name.trim())) throw badRequest('Names may contain letters, digits, ".", "_", "@", "+" and "-"');
  // Checked now so a redirect or device flow does not fail at the very end.
  if (input.name && one('SELECT 1 FROM connections WHERE user_id = ? AND name = ? AND id != ?', user.id, input.name.trim(), existing?.id ?? '')) {
    throw badRequest('You already have a connection with that name');
  }

  const redirectUri = checkRedirectUri(input.redirectUri, method);

  const flowId = randomToken(24);
  const args: ConnectArgs = { config: cfg, callbackUrl: redirectUri ?? callbackUrl, state: flowId, connection: existing };
  const step = await callPlugin(() => method.connect(args));
  return handleStep(user, step, { flowId, service, method, cfg, name: input.name?.trim(), connectionId: existing?.id, redirectUri });
}

async function startRemoteConnect(
  user: User,
  input: { service: string; method?: string; config?: Record<string, any>; name?: string; connection?: string; redirectUri?: string },
  existingRow: any,
  remote: { satelliteId: string; serviceId: string },
): Promise<FlowResult> {
  const { service } = satelliteService(user.id, remote.satelliteId, remote.serviceId);
  const methodId = input.method ?? existingRow?.method_id ?? service.methods.find((m) => !m.unavailable)?.id;
  const method = service.methods.find((m) => m.id === methodId);
  if (!method) throw badRequest(`Unknown sign-in method "${methodId}"`);
  if (method.unavailable) throw badRequest(method.unavailable);
  if (input.name && !NAME.test(input.name.trim())) throw badRequest('Names may contain letters, digits, ".", "_", "@", "+" and "-"');
  if (input.name && one('SELECT 1 FROM connections WHERE user_id = ? AND name = ? AND id != ?', user.id, input.name.trim(), existingRow?.id ?? '')) throw badRequest('You already have a connection with that name');
  const result = await requestSatellite<any>(remote.satelliteId, user.id, 'connect.start', {
    service: remote.serviceId, method: methodId, config: input.config ?? {}, name: input.name,
    connection: existingRow?.remote_connection_id, ...(method.redirect ? { redirectUri: input.redirectUri ?? callbackUrl } : {}),
  });
  if (result.status === 'connected') return { status: 'connected', connection: storeRemoteConnection(user, existingRow, remote, result.connection) };
  // Keep the provider's state value: its callback arrives at central Switchboard and must resolve
  // the flow that the satellite created. Satellite flow ids are cryptographically random.
  const flowId = String(result.flowId);
  if (!flowId || one('SELECT 1 FROM connect_flows WHERE id = ?', flowId)) throw badRequest('The satellite returned an invalid sign-in flow');
  run(
    `INSERT INTO connect_flows (id, user_id, service_id, method_id, connection_id, name, config_enc, pending_enc, kind, expires_at, created_at, redirect_uri, satellite_id, remote_flow_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    flowId, user.id, remoteServiceId(remote.satelliteId, remote.serviceId), methodId, existingRow?.id ?? null, input.name?.trim() ?? null,
    encrypt({}), encrypt(null), result.status, now() + 15 * 60_000, now(), input.redirectUri ?? null, remote.satelliteId, result.flowId,
  );
  return result.status === 'redirect'
    ? { ...result, flowId, ...(input.redirectUri ? { manual: true } : { manual: false }) }
    : { ...result, flowId };
}

function storeRemoteConnection(user: User, existingRow: any, remote: { satelliteId: string; serviceId: string }, result: any): ConnectionView {
  const t = now();
  const id = existingRow?.id ?? randomId('c');
  const serviceKey = remoteServiceId(remote.satelliteId, remote.serviceId);
  const name = existingRow?.name ?? uniqueName(user.id, result.name || remote.serviceId);
  if (existingRow) {
    run(`UPDATE connections SET method_id = ?, name = ?, account_id = ?, account_label = ?, account_avatar = ?, config_enc = ?,
         credentials_enc = NULL, status = 'ok', status_message = NULL, updated_at = ?, remote_connection_id = ? WHERE id = ?`,
      result.methodId, result.name ?? name, result.account?.id ?? null, result.account?.label ?? null, result.account?.avatarUrl ?? null,
      encrypt(result.config ?? {}), t, result.id, id);
  } else {
    run(`INSERT INTO connections (id, user_id, service_id, method_id, name, account_id, account_label, account_avatar, config_enc, credentials_enc,
         status, created_at, updated_at, satellite_id, remote_connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ok', ?, ?, ?, ?)`,
      id, user.id, serviceKey, result.methodId, name, result.account?.id ?? null, result.account?.label ?? null, result.account?.avatarUrl ?? null,
      encrypt(result.config ?? {}), t, t, remote.satelliteId, result.id);
  }
  return toView(one('SELECT * FROM connections WHERE id = ?', id));
}

/**
 * Some providers only allow redirect URIs that cannot point at Switchboard (often localhost). Sign-in
 * then sends the browser there, and the user pastes that address back to complete it.
 */
function checkRedirectUri(value: string | undefined, method: AuthMethod): string | undefined {
  const v = value?.trim();
  if (!v || v === callbackUrl) return undefined;
  if (!method.callback) throw badRequest('This sign-in method does not use a redirect URI');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw badRequest('The redirect URI must be an absolute URL, e.g. http://localhost:8080/callback');
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest('The redirect URI must start with http:// or https://');
  if (u.hash) throw badRequest('The redirect URI cannot have a #fragment');
  return v;
}

interface FlowInfo {
  flowId: string;
  service: ServiceDefinition;
  method: AuthMethod;
  cfg: Record<string, any>;
  name?: string;
  connectionId?: string;
  redirectUri?: string;
}

function handleStep(user: User, step: ConnectStep, f: FlowInfo): FlowResult {
  if ('redirect' in step) {
    saveFlow(user, f, 'redirect', step.pending, 15 * 60);
    return { status: 'redirect', flowId: f.flowId, url: step.redirect, ...(f.redirectUri ? { manual: true } : {}) };
  }
  if ('device' in step) {
    const expiresIn = step.device.expiresIn ?? 900;
    saveFlow(user, f, 'device', step.pending, expiresIn);
    return { status: 'device', flowId: f.flowId, device: { ...step.device, interval: step.device.interval ?? 5 } };
  }
  return { status: 'connected', connection: storeConnection(user, f, step) };
}

function saveFlow(user: User, f: FlowInfo, kind: string, pending: unknown, ttlSecs: number) {
  run('DELETE FROM connect_flows WHERE expires_at < ?', now());
  run(
    `INSERT INTO connect_flows (id, user_id, service_id, method_id, connection_id, name, config_enc, pending_enc, kind, expires_at, created_at, redirect_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.flowId, user.id, f.service.id, f.method.id, f.connectionId ?? null, f.name ?? null, encrypt(f.cfg), encrypt(pending ?? null), kind, now() + ttlSecs * 1000, now(), f.redirectUri ?? null,
  );
}

function loadFlow(flowId: string, kind: string) {
  const r = one('SELECT * FROM connect_flows WHERE id = ? AND kind = ?', flowId, kind);
  if (!r || r.expires_at < now()) throw badRequest('This sign-in attempt has expired. Please try again.');
  const service = plugins.service(r.service_id);
  const method = service && findMethod(service, r.method_id);
  if (!service || !method) throw badRequest('The service is no longer available');
  return { r, service, method, cfg: decrypt(r.config_enc) ?? {}, pending: decrypt(r.pending_enc) };
}

function existingConn(userId: string, connectionId: string | null) {
  if (!connectionId) return undefined;
  const row = one('SELECT * FROM connections WHERE id = ? AND user_id = ?', connectionId, userId);
  return row ? rowToConnection(row) : undefined;
}

/** Completes a redirect flow. Returns the flow's user id so the caller can verify the session. */
export async function completeRedirect(flowId: string, params: Record<string, string>, user: User): Promise<ConnectionView> {
  const remoteFlow = one('SELECT * FROM connect_flows WHERE id = ? AND satellite_id IS NOT NULL', flowId);
  if (remoteFlow) return completeRemoteFlow(remoteFlow, user, 'connect.callback', { params });
  const { r, service, method, cfg, pending } = loadFlow(flowId, 'redirect');
  if (r.user_id !== user.id) throw badRequest('This sign-in was started by another user');
  run('DELETE FROM connect_flows WHERE id = ?', flowId);
  if (params.error) throw badRequest(params.error_description || params.error);
  if (!method.callback) throw badRequest('This method does not support redirects');
  const connection = existingConn(user.id, r.connection_id);
  // The token request must name the same redirect URI as the authorization request.
  const redirect = r.redirect_uri ?? callbackUrl;
  const result = await callPlugin(() => method.callback!({ config: cfg, callbackUrl: redirect, state: flowId, pending, params, connection }));
  return storeConnection(user, { flowId, service, method, cfg, name: r.name ?? undefined, connectionId: r.connection_id ?? undefined, redirectUri: r.redirect_uri ?? undefined }, result);
}

/**
 * Completes a redirect flow from what the user pasted: the address the provider sent them to, or
 * just the code. A pasted address must belong to this flow (its state is the flow id).
 */
export async function completeFromPaste(flowId: string, pasted: string, user: User): Promise<ConnectionView> {
  const remoteFlow = one('SELECT * FROM connect_flows WHERE id = ? AND satellite_id IS NOT NULL', flowId);
  if (remoteFlow) return completeRemoteFlow(remoteFlow, user, 'connect.complete', { url: String(pasted ?? '') });
  const text = String(pasted ?? '').trim();
  if (!text) throw badRequest('Paste the address you were sent to after signing in');
  let params: Record<string, string>;
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {}
  if (url) {
    // Some providers put the result in the #fragment instead of the query.
    params = Object.fromEntries([...new URLSearchParams(url.hash.slice(1)), ...url.searchParams]);
    if (!params.code && !params.error) throw badRequest('That address has no code. Copy the full address from the browser after signing in.');
    if (params.state && params.state !== flowId) throw badRequest('That address belongs to another sign-in. Start again, or paste the latest address.');
  } else if (/^[\w.~\-/+=%]+$/.test(text)) {
    params = { code: decodeURIComponent(text), state: flowId };
  } else {
    throw badRequest('Paste the full address you were sent to, or the code from it');
  }
  return completeRedirect(flowId, { ...params, state: flowId }, user);
}

export async function pollDevice(flowId: string, user: User): Promise<FlowResult | { status: 'pending'; interval?: number }> {
  const remoteFlow = one('SELECT * FROM connect_flows WHERE id = ? AND satellite_id IS NOT NULL', flowId);
  if (remoteFlow) {
    if (remoteFlow.user_id !== user.id) throw notFound();
    const result = await requestSatellite<any>(remoteFlow.satellite_id, user.id, 'connect.poll', { flowId: remoteFlow.remote_flow_id });
    if (result.status === 'pending') return result;
    run('DELETE FROM connect_flows WHERE id = ?', flowId);
    const parsed = parseRemoteServiceId(remoteFlow.service_id)!;
    const existing = remoteFlow.connection_id ? getConnectionRow(user.id, remoteFlow.connection_id) : undefined;
    return { status: 'connected', connection: storeRemoteConnection(user, existing, parsed, result.connection) };
  }
  const { r, service, method, cfg, pending } = loadFlow(flowId, 'device');
  if (r.user_id !== user.id) throw notFound();
  if (!method.poll) throw badRequest('This method does not support polling');
  const connection = existingConn(user.id, r.connection_id);
  let result;
  try {
    result = await callPlugin(() => method.poll!({ config: cfg, callbackUrl, state: flowId, pending, connection }));
  } catch (e) {
    run('DELETE FROM connect_flows WHERE id = ?', flowId);
    throw e;
  }
  if ('wait' in result) {
    if (result.pending !== undefined) run('UPDATE connect_flows SET pending_enc = ? WHERE id = ?', encrypt(result.pending), flowId);
    return { status: 'pending', interval: result.interval };
  }
  run('DELETE FROM connect_flows WHERE id = ?', flowId);
  const view = storeConnection(user, { flowId, service, method, cfg, name: r.name ?? undefined, connectionId: r.connection_id ?? undefined }, result);
  return { status: 'connected', connection: view };
}

export function cancelFlow(flowId: string, user: User) {
  const remoteFlow = one('SELECT * FROM connect_flows WHERE id = ? AND user_id = ? AND satellite_id IS NOT NULL', flowId, user.id);
  if (remoteFlow) void requestSatellite(remoteFlow.satellite_id, user.id, 'connect.cancel', { flowId: remoteFlow.remote_flow_id }).catch(() => {});
  run('DELETE FROM connect_flows WHERE id = ? AND user_id = ?', flowId, user.id);
}

async function completeRemoteFlow(row: any, user: User, operation: string, payload: Record<string, unknown>): Promise<ConnectionView> {
  if (row.user_id !== user.id) throw badRequest('This sign-in was started by another user');
  if (row.expires_at < now()) throw badRequest('This sign-in attempt has expired. Please try again.');
  const result = await requestSatellite<any>(row.satellite_id, user.id, operation, { flowId: row.remote_flow_id, ...payload });
  if (result.status !== 'connected' || !result.connection) throw badRequest('The satellite did not complete the connection');
  run('DELETE FROM connect_flows WHERE id = ?', row.id);
  const parsed = parseRemoteServiceId(row.service_id)!;
  const existing = row.connection_id ? getConnectionRow(user.id, row.connection_id) : undefined;
  return storeRemoteConnection(user, existing, parsed, result.connection);
}

function storeConnection(user: User, f: FlowInfo, result: Connected): ConnectionView {
  if (!result || result.credentials === undefined) throw badRequest('The plugin did not return credentials');
  const cfg = result.config ?? f.cfg;
  const account = result.account;
  let id = f.connectionId;
  // Signing in again to an account that is already connected the same way updates that connection,
  // unless the user named the new one: then they want a second connection (e.g. other scopes).
  if (!id && account?.id && !f.name) {
    id = one(
      'SELECT id FROM connections WHERE user_id = ? AND service_id = ? AND method_id = ? AND account_id = ?',
      user.id, f.service.id, f.method.id, account.id,
    )?.id;
  }
  const t = now();
  if (id) {
    run(
      `UPDATE connections SET method_id = ?, config_enc = ?, credentials_enc = ?, account_id = COALESCE(?, account_id),
         account_label = COALESCE(?, account_label), account_avatar = COALESCE(?, account_avatar),
         status = 'ok', status_message = NULL, updated_at = ?, redirect_uri = ? WHERE id = ?`,
      f.method.id, encrypt(cfg), encrypt(result.credentials), account?.id ?? null, account?.label ?? null, account?.avatarUrl ?? null, t, f.redirectUri ?? null, id,
    );
    if (f.name) renameConnection(user.id, id, f.name);
  } else {
    id = randomId('c');
    const name = uniqueName(user.id, f.name || defaultName(f.service, account?.label));
    run(
      `INSERT INTO connections (id, user_id, service_id, method_id, name, account_id, account_label, account_avatar, config_enc, credentials_enc, created_at, updated_at, redirect_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.id, f.service.id, f.method.id, name, account?.id ?? null, account?.label ?? null, account?.avatarUrl ?? null, encrypt(cfg), encrypt(result.credentials), t, t, f.redirectUri ?? null,
    );
  }
  return toView(one('SELECT * FROM connections WHERE id = ?', id));
}

function defaultName(service: ServiceDefinition, label?: string) {
  const who = label?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '');
  return who ? `${service.id}-${who}` : service.id;
}

function uniqueName(userId: string, base: string) {
  base = base.replace(/[^a-zA-Z0-9._@+-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'connection';
  let name = base;
  for (let i = 2; one('SELECT 1 FROM connections WHERE user_id = ? AND name = ?', userId, name); i++) name = `${base}-${i}`;
  return name;
}

/** Errors thrown by plugins become 400s with their message; hub errors pass through. */
async function callPlugin<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(e?.status && e.status >= 400 && e.status < 600 ? e.status : 400, e?.message ?? String(e));
  }
}
