import { plugins } from '../plugins/manager.ts';
import { Hono, type Context } from 'hono';
import { requireUser, requireFullAccess, type Env } from '../auth.ts';
import { credentialCandidates, credentialView, deleteCredential, getCredential, independentCredential, linkCredential, listCredentials, promoteCredential, revokeCredential, rotateCredential, sourceConnection } from '../credentials.ts';
import { getConnectionRow, loadConnection } from '../connections.ts';
import { record, callerFrom } from '../audit.ts';
import { run, now } from '../db.ts';
import { badRequest, HttpError } from '../http.ts';

async function readBody(c: Context<Env>): Promise<Record<string, any>> {
  const value = await c.req.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('A JSON object is required');
  return value;
}

export const credentialsApi = new Hono<Env>();
for (const path of ['/credentials', '/credentials/*', '/connections/:ref/credential', '/connections/:ref/credential/*']) credentialsApi.use(path, requireUser, requireFullAccess);
for (const path of ['/credentials', '/credentials/*', '/connections/:ref/credential', '/connections/:ref/credential/*']) credentialsApi.use(path, async (c, next) => {
  let status: number | undefined;
  try { await next(); } catch (error) { status = error instanceof HttpError ? error.status : 500; throw error; }
  finally { if (!['GET','HEAD'].includes(c.req.method)) record({ userId: c.get('user').id, caller: callerFrom(c, 'plugin'), method: 'CREDENTIAL', url: c.req.path, status: status ?? c.res.status }); }
});
credentialsApi.get('/credentials', c => c.json(listCredentials(c.get('user').id)));
credentialsApi.get('/credentials/:id', c => {
  const row = getCredential(c.get('user').id, c.req.param('id'));
  let fields: any[] = [];
  try { const { method } = sourceConnection(row); fields = method.fields?.filter(field => field.type === 'secret' || field.key === 'username') ?? []; } catch {}
  return c.json({ ...credentialView(row), fields });
});
credentialsApi.post('/credentials/candidates', async c => {
  const body = await readBody(c);
  if (body.connection) {
    const loaded = loadConnection(c.get('user').id, body.connection, true);
    return c.json(credentialCandidates(c.get('user'), loaded.conn, loaded.method));
  }
  const service = plugins.service(body.service);
  const method = service?.authMethods.find(method => method.id === body.method);
  if (!method) throw badRequest('Unknown authentication method');
  return c.json(credentialCandidates(c.get('user'), { id: '', name: '', serviceId: body.service, methodId: method.id, config: body.config ?? {}, credentials: null }, method));
});
credentialsApi.post('/credentials', async c => {
  const { connection, name } = await readBody(c);
  return c.json(await promoteCredential(c.get('user'), connection, name));
});
credentialsApi.patch('/credentials/:id', async c => {
  const row = getCredential(c.get('user').id, c.req.param('id'));
  const { name, version } = await readBody(c);
  if (row.version !== version) throw new HttpError(409, 'The credential changed; reload');
  if (typeof name === 'string' && listCredentials(c.get('user').id).some(credential => credential.name === name.trim() && credential.id !== row.id)) throw badRequest('A credential with that name already exists');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw badRequest('A name is required (maximum 100 characters)');
  if (run('UPDATE credentials SET name = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?', name.trim(), now(), row.id, version).changes !== 1) throw new HttpError(409, 'The credential changed; reload');
  return c.json(credentialView(getCredential(row.user_id, row.id)));
});
credentialsApi.post('/credentials/:id/rotate', async c => {
  const input = await readBody(c);
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)) throw badRequest('A version and replacement credential fields are required');
  return c.json(await rotateCredential(c.get('user'), c.req.param('id'), { version: input.version, config: input.config }));
});
credentialsApi.post('/credentials/:id/revoke', async c => c.json(await revokeCredential(c.get('user'), c.req.param('id'), (await readBody(c)).version)));
credentialsApi.delete('/credentials/:id', c => { deleteCredential(c.get('user'), c.req.param('id')); return c.json({ ok: true }); });
credentialsApi.post('/connections/:ref/credential', async c => {
  const body = await readBody(c);
  if ((typeof body.sourceConnection === 'string') === (typeof body.credentialId === 'string') || (body.sourceConnection !== undefined && typeof body.sourceConnection !== 'string') || (body.credentialId !== undefined && typeof body.credentialId !== 'string')) throw badRequest('Choose a credential ID or source connection');
  const source = body.sourceConnection ? await promoteCredential(c.get('user'), body.sourceConnection, body.name) : undefined;
  return c.json(await linkCredential(c.get('user'), c.req.param('ref'), source?.id ?? body.credentialId));
});
credentialsApi.post('/connections/:ref/credential/independent', async c => {
  await independentCredential(c.get('user'), c.req.param('ref'));
  return c.json({ ok: true });
});
