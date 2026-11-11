import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swb-profiles-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_PUBLIC_URL = 'http://localhost';
const { initDb, run, one, all } = await import('../server/db.ts');
const { initKey, encrypt } = await import('../server/crypto.ts');
const { createUser, createToken } = await import('../server/users.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const core = await import('../server/browser-profiles.ts');
const flows = await import('../server/connections.ts');
const { api } = await import('../server/routes/connections.ts');
const { HttpError } = await import('../server/http.ts');
import type { AuthMethod, AuthenticationProfile } from '../server/plugins/api.ts';
initKey(); initDb();
const user = createUser('owner', 'admin'), other = createUser('other', 'user');
let attempt = 0;
const pending = new Map<string, AuthenticationProfile>();
const method: AuthMethod = {
  id: 'browser', name: 'Browser', browserProfile: { legacyPath: c => `profiles/${c.credentials.profile}/browser` },
  connect(args) { if (args.config.fail) throw new Error('fixture failure'); pending.set(args.state, args.browserProfile!); return { device: { browser: true, instructions: 'Fixture', interval: 1 }, pending: {} }; },
  async poll() { return { credentials: { profile: `operation-${++attempt}`, coreProfile: true }, account: { id: 'same-account', label: 'Fixture' } }; },
  authorize() {},
  async revoke(c) { assert.ok(c.browserProfileId); throw new Error('synthetic revocation failure'); },
  fields: [{ key: 'fail', type: 'boolean', label: 'Fail' }],
};
plugins.services.set('fixture-profiles', { pluginId: 'fixture-profiles', service: { id: 'fixture-profiles', name: 'Fixture', authMethods: [method] } });
core.browserProfileOwner('fixture-profiles', 'fixture-profiles');
const app = new Hono(); app.onError((e,c) => c.json({ error: e.message }, e instanceof HttpError ? e.status as any : 500)); app.route('/api', api);
async function start(input: any = {}, actor = user) {
  const flow = await flows.startConnect(actor, { service: 'fixture-profiles', ...input });
  assert.equal(flow.status, 'device'); if (flow.status !== 'device') throw Error('flow'); return flow;
}
async function finish(flow: any, actor = user) { const result = await flows.pollDevice(flow.flowId, actor); assert.equal(result.status, 'connected'); if (result.status !== 'connected') throw Error('result'); return result.connection; }
after(async () => { await core.stopBrowserProfiles(); await fs.rm(dir, { recursive: true, force: true }); });

test('new profiles never deduplicate matching accounts, explicit reuse and reconnect retain identity', async () => {
  const first = await finish(await start()); const second = await finish(await start());
  assert.notEqual(first.id, second.id); assert.notEqual(first.browserProfile!.id, second.browserProfile!.id);
  const shared = await finish(await start({ browserProfileId: first.browserProfile!.id, browserProfileName: 'Work' }));
  assert.notEqual(shared.id, first.id); assert.equal(shared.browserProfile!.id, first.browserProfile!.id);
  assert.equal(shared.browserProfile!.name, 'Work'); assert.equal(shared.browserProfile!.connections.length, 2);
  await assert.rejects(start({ connection: first.id, browserProfileId: second.browserProfile!.id }), /original/);
  const reconnected = await finish(await start({ connection: first.id }));
  assert.equal(reconnected.id, first.id); assert.equal(reconnected.browserProfile!.id, first.browserProfile!.id);
  assert.equal(all('SELECT * FROM connections').length, 3);
  const data = path.join(dir, 'browser-profiles', first.browserProfile!.id);
  await fs.mkdir(data, { recursive: true }); await fs.writeFile(path.join(data, 'cookie-fixture'), 'synthetic');
  await flows.deleteConnection(user.id, first.id); assert.equal(await fs.readFile(path.join(data, 'cookie-fixture'), 'utf8'), 'synthetic');
  await flows.deleteConnection(user.id, shared.id); await assert.rejects(fs.access(data));
  assert.equal(one('SELECT 1 FROM browser_profiles WHERE id = ?', first.browserProfile!.id), undefined);
  await flows.deleteConnection(user.id, second.id);
});

test('profile endpoints reject restricted tokens and cross-user selection; metadata is safe', async () => {
  const connection = await finish(await start());
  await assert.rejects(start({ browserProfileId: connection.browserProfile!.id }, other), /not found/);
  const token = createToken(user.id, 'restricted', [connection.id]);
  for (const [url, method] of [['/browser-profiles', 'GET'], [`/browser-profiles/${connection.browserProfile!.id}`, 'PATCH']] as const) {
    const response = await app.request('/api' + url, { method, headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' }, ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'stolen' }) } : {}) });
    assert.equal(response.status, 403);
  }
  const full = createToken(user.id, 'full', null);
  const response = await app.request('/api/browser-profiles', { headers: { authorization: `Bearer ${full.secret}` } });
  const text = await response.text(); assert.equal(response.status, 200);
  assert.ok(!/legacy_path|cookie|credentials|dataDir|\/Users|browser-profiles\//.test(text));
  await assert.rejects(Promise.resolve().then(() => core.renameBrowserProfile(other.id, connection.browserProfile!.id, 'stolen')), /not found/);
  await flows.deleteConnection(user.id, connection.id);
});

test('cancelled/failed sign-ins remove unused profiles and cannot later commit', async () => {
  const flow = await start(); const id = pending.get(flow.flowId)!.id;
  await flows.cancelFlow(flow.flowId, other); assert.ok(one('SELECT 1 FROM browser_profiles WHERE id = ?', id));
  await flows.cancelFlow(flow.flowId, user); assert.equal(one('SELECT 1 FROM browser_profiles WHERE id = ?', id), undefined);
  await assert.rejects(finish(flow), /expired/);
  await assert.rejects(start({ config: { fail: true } }), /fixture failure/);
  assert.equal(all('SELECT * FROM browser_profiles').length, 0);
});

test('deleted reconnect target cannot be silently recreated', async () => {
  const connection = await finish(await start()); const flow = await start({ connection: connection.id });
  await flows.deleteConnection(user.id, connection.id);
  await assert.rejects(finish(flow), /expired/);
  assert.equal(all('SELECT * FROM browser_profiles').length, 0);
});

function oldConnection(id: string, legacyId: string) {
  run('INSERT INTO connections(id,user_id,name,service_id,method_id,config_enc,credentials_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, user.id, id, 'fixture-profiles', 'browser', encrypt({}), encrypt({ profile: legacyId }), Date.now(), Date.now());
  return one('SELECT * FROM connections WHERE id = ?', id);
}
test('legacy registration preserves sign-ins; first reuse is a recovery-safe independent copy', async () => {
  const old = oldConnection('legacy-one', 'old-one'), old2 = oldConnection('legacy-two', 'old-two');
  const source = path.join(dir, 'plugin-data/fixture-profiles/profiles/old-one/browser');
  await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'Cookies'), 'synthetic-sign-in');
  await fs.symlink('/synthetic-lock', path.join(source, 'SingletonLock'));
  const id = core.registerBrowserProfile(old, method, 'fixture-profiles')!;
  const id2 = core.registerBrowserProfile(old2, method, 'fixture-profiles')!;
  assert.notEqual(id, id2); assert.equal(core.registerBrowserProfile(old, method, 'fixture-profiles'), id);
  assert.equal(one('SELECT managed FROM browser_profiles WHERE id = ?', id).managed, 0);
  const flow = await start({ browserProfileId: id });
  await core.migrateBrowserProfile(user.id, id);
  const copy = path.join(dir, 'browser-profiles', id);
  assert.equal(await fs.readFile(path.join(copy, 'Cookies'), 'utf8'), 'synthetic-sign-in');
  assert.equal(await fs.readFile(path.join(source, 'Cookies'), 'utf8'), 'synthetic-sign-in');
  await assert.rejects(fs.access(path.join(copy, 'SingletonLock')));
  await flows.cancelFlow(flow.flowId, user); assert.ok(one('SELECT 1 FROM browser_profiles WHERE id = ?', id));
  const missingSourceFlow = await start({ browserProfileId: id2 }); await assert.rejects(core.migrateBrowserProfile(user.id, id2)); await flows.cancelFlow(missingSourceFlow.flowId, user);
  assert.equal(one('SELECT managed FROM browser_profiles WHERE id = ?', id2).managed, 0);
  assert.ok(one('SELECT 1 FROM connections WHERE id = ?', old2.id));
  await flows.deleteConnection(user.id, old.id); await flows.deleteConnection(user.id, old2.id);
});

test('restricted connection views do not reveal profile usage; a deletion veto preserves references', async () => {
  const connection = await finish(await start());
  assert.equal(flows.listConnections(user.id, [connection.id])[0].browserProfile, undefined);
  method.beforeDelete = () => { throw new Error('active workflow'); };
  try { await assert.rejects(flows.deleteConnection(user.id, connection.id), /active workflow/); assert.ok(one('SELECT 1 FROM connections WHERE id = ?', connection.id)); }
  finally { delete method.beforeDelete; }
  await flows.deleteConnection(user.id, connection.id);
});

test('user removal cleans pending authentication, profiles and disk data', async () => {
  const connection = await finish(await start({}, other), other); const flow = await start({}, other);
  const directory = path.join(dir, 'browser-profiles', connection.browserProfile!.id); await fs.mkdir(directory, {recursive:true}); await fs.writeFile(path.join(directory,'synthetic'),'fixture');
  const { deleteUser } = await import('../server/users.ts'); await deleteUser(other.id);
  await assert.rejects(fs.access(directory)); assert.equal(all('SELECT * FROM browser_profiles WHERE user_id = ?', other.id).length, 0);
  await assert.rejects(finish(flow, other), /expired/);
});

test('failed partial migration retains usable source and retry recovers without combining copies', async () => {
  const row = oldConnection('legacy-failure', 'old-failure');
  const source = path.join(dir, 'plugin-data/fixture-profiles/profiles/old-failure/browser'); await fs.mkdir(source,{recursive:true}); await fs.writeFile(path.join(source,'Cookies'),'original-synthetic');
  await fs.symlink('/synthetic-external-data',path.join(source,'unsafe-link'));
  const id = core.registerBrowserProfile(row,method,'fixture-profiles')!;
  await assert.rejects(core.migrateBrowserProfile(user.id,id), /symbolic link/);
  assert.equal(await fs.readFile(path.join(source,'Cookies'),'utf8'),'original-synthetic'); assert.equal(one('SELECT managed FROM browser_profiles WHERE id = ?',id).managed,0);
  await assert.rejects(fs.access(path.join(dir,'browser-profiles',id+'.copying')));
  await fs.rm(path.join(source,'unsafe-link')); await core.migrateBrowserProfile(user.id,id);
  // Rehearse interruption between atomic rename and metadata commit: retry must use
  // the completed target, never merge newer/different source contents into it.
  run('UPDATE browser_profiles SET managed = 0 WHERE id = ?',id); await fs.writeFile(path.join(source,'Cookies'),'different-source-synthetic');
  await core.migrateBrowserProfile(user.id,id); assert.equal(await fs.readFile(path.join(dir,'browser-profiles',id,'Cookies'),'utf8'),'original-synthetic');
  await flows.deleteConnection(user.id,row.id);
});

test('expired flow sweeper cancels plugin resources and collects unused profiles', async () => {
  const flow = await start(), profile = pending.get(flow.flowId)!.id; let cancelled = false;
  method.cancel = () => { cancelled = true; };
  run('UPDATE connect_flows SET expires_at = 0 WHERE id = ?',flow.flowId);
  try { await flows.sweepConnectFlows(); assert.equal(cancelled,true); assert.equal(one('SELECT 1 FROM connect_flows WHERE id = ?',flow.flowId),undefined); assert.equal(one('SELECT 1 FROM browser_profiles WHERE id = ?',profile),undefined); }
  finally { delete method.cancel; }
});
