import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-credentials-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_PUBLIC_URL = 'http://switchboard.example';
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
const { initDb, db, one, all, run } = await import('../server/db.ts');
const database = await import('../server/db.ts');
const { initKey, decrypt } = await import('../server/crypto.ts');
const { plugins } = await import('../server/plugins/manager.ts');
const { startConnect, completeRedirect, deleteConnection, loadConnection, withLock } = await import('../server/connections.ts');
const { createUser, createToken } = await import('../server/users.ts');
const { api } = await import('../server/routes/connections.ts');
const { credentialsApi } = await import('../server/routes/credentials.ts');
const { HttpError } = await import('../server/http.ts');
const { replaceCredential, getCredential } = await import('../server/credentials.ts');
const { onCredentialsChange } = await import('../server/connection-events.ts');
initKey(); initDb();
const user = createUser('owner','admin'); const other = createUser('other','user');
const owner = createToken(user.id,'owner',null);
const app = new Hono();
app.onError((e,c) => c.json({ error: e.message, code: (e as any).code }, e instanceof HttpError ? e.status as any : 500));
app.route('/api', credentialsApi); app.route('/api', api);
let origin = ''; let outage = ''; let rotations = 0; let badRefresh = false;
let heldRefresh: Promise<void> | undefined; let refreshStarted: (() => void) | undefined;
const requests: { path: string; authorization: string }[] = [];
const provider = http.createServer(async (req,res) => {
  const url = new URL(req.url!, 'http://x');
  let body = ''; for await (const chunk of req) body += chunk;
  const send = (status: number, data: unknown) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(data)); };
  if (url.pathname === '/oauth/token') {
    const values = new URLSearchParams(body);
    if (values.get('grant_type') === 'refresh_token') {
      refreshStarted?.(); if (heldRefresh) await heldRefresh;
      if (badRefresh) return send(400, { error:'invalid_grant' });
      rotations++; return send(200, { access_token: `oauth-refresh-${rotations}`, refresh_token: `rotated-${rotations}`, expires_in:3600 });
    }
    const code = values.get('code');
    return send(200,{access_token:`oauth-${code}`,refresh_token:'first-refresh',expires_in:0.01, scope:code === 'only-a' ? 'a' : 'a b'});
  }
  const authorization = req.headers.authorization ?? '';
  requests.push({path:url.pathname,authorization});
  if (url.pathname.startsWith(`/${outage}/`) && outage) return send(503,{});
  if (authorization === 'Bearer broken') return send(401,{});
  if (url.pathname.endsWith('/me')) return send(200,{ id: authorization.includes('wrong-account') ? 'other' : 'same-user', label:'Work account' });
  return send(200,{authorization,path:url.pathname});
});
before(async () => {
  fs.mkdirSync(path.join(dir,'plugins'),{recursive:true});
  fs.cpSync(path.join(import.meta.dirname,'fixtures/reusable-plugin'),path.join(dir,'plugins/reusable-test'),{recursive:true});
  await plugins.start();
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
after(async () => { await plugins.stop(); provider.close(); database.db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
async function request(route: string, body?: unknown, token = owner.secret, method?: string) {
  const res = await app.request(`/api${route}`,{method:method ?? (body === undefined ? 'GET':'POST'),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body === undefined ? undefined:JSON.stringify(body)});
  return { status:res.status, data:await res.json() as any };
}
async function connect(product: string, method = 'token', token = 'original') {
  const flow = await startConnect(user,{service:`reuse-${product}`,method,name:`${product}-${Math.random().toString(36).slice(2)}`,config:{baseUrl:origin,token}});
  if (flow.status === 'redirect') return completeRedirect(flow.flowId,{code:'both',state:flow.flowId},user);
  if (flow.status !== 'connected') throw new Error('Unexpected flow');
  return flow.connection;
}
async function promote(conn: any, name: string) { const result = await request('/credentials',{connection:conn.id,name}); assert.equal(result.status,200,JSON.stringify(result.data)); return result.data; }

test('repair a forgotten connection without retrieving a read-once token; rotate once and keep IDs', async () => {
  const a = await connect('a','token','updated-jira'); const b = await connect('b','token','stale-confluence');
  const source = await promote(a,'Work token');
  assert.equal(one('SELECT credentials_enc FROM connections WHERE id = ?',a.id).credentials_enc,null);
  assert.equal((await request(`/connections/${b.id}/credential`,{credentialId:source.id})).status,200);
  assert.equal(loadConnection(user.id,b.id).conn.credentials.token,'updated-jira');
  const rotated = await request(`/credentials/${source.id}/rotate`,{version:source.version,config:{token:'new-token'}});
  assert.equal(rotated.status,200,JSON.stringify(rotated.data));
  for (const connection of [a,b]) { assert.equal(loadConnection(user.id,connection.id).conn.credentials.token,'new-token'); assert.equal(one('SELECT credentials_enc FROM connections WHERE id = ?',connection.id).credentials_enc,null); }
  assert.equal(JSON.stringify((await request('/credentials')).data).includes('new-token'),false);
});
test('rotation activates atomically with an outage, rejects invalid credentials, and detects stale edits', async () => {
  const a = await connect('a'); const b = await connect('b'); const source = await promote(a,'Outage token');
  await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  const events: string[]=[]; const off=onCredentialsChange(id=>events.push(id)); outage='a';
  const rotated=await request(`/credentials/${source.id}/rotate`,{version:source.version,config:{token:'active-during-outage'}}); outage=''; off();
  assert.equal(rotated.status,200,JSON.stringify(rotated.data)); assert.ok(rotated.data.health.some((health:any)=>health.status==='error'));
  assert.ok(events.includes(a.id)&&events.includes(b.id));
  assert.equal((await request(`/credentials/${source.id}/rotate`,{version:source.version,config:{token:'older'}})).status,409);
  assert.equal((await request(`/credentials/${source.id}/rotate`,{version:rotated.data.credential.version,config:{token:'broken'}})).status,400);
  assert.equal(loadConnection(user.id,a.id).conn.credentials.token,'active-during-outage');
});
test('owners alone manage credentials and scoped callers cannot retrieve shared SDK tokens', async () => {
  const a=await connect('a');const source=await promote(a,'Private owner');
  const scoped=createToken(user.id,'scoped',[a.id]);const stranger=createToken(other.id,'other',null);
  assert.equal((await request('/credentials',undefined,scoped.secret)).status,403);
  assert.equal((await request(`/credentials/${source.id}`,undefined,stranger.secret)).status,404);
  assert.equal((await request(`/connections/${a.id}/token`,undefined,scoped.secret)).status,403);
  assert.equal((await request(`/connections/${a.id}/token`)).status,200);
  assert.equal((await request('/call',{connection:a.id,url:'/a/resource'},scoped.secret)).status,200);
  assert.equal((await request(`/connections/${a.id}/reconnect`,{config:{baseUrl:origin,token:'steal'}},scoped.secret)).status,403);
});
test('deletion preserves another connection; static independence copies only on the server', async () => {
  const a=await connect('a'); const b=await connect('b'); const source=await promote(a,'Survives deletion');
  await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  assert.equal((await request(`/credentials/${source.id}`,undefined,owner.secret,'DELETE')).status,409);
  await deleteConnection(user.id,a.id); assert.equal(loadConnection(user.id,b.id).conn.credentials.token,'original');
  assert.equal((await request(`/connections/${b.id}/credential/independent`,{})).status,200);
  assert.equal(one('SELECT credential_id FROM connections WHERE id = ?',b.id).credential_id,null);
  assert.equal(loadConnection(user.id,b.id).conn.credentials.token,'original');
  assert.equal((await request(`/credentials/${source.id}`,undefined,owner.secret,'DELETE')).status,200);
});
test('destination changes require a new approval and revocation disables all links', async () => {
  const a=await connect('a'); const source=await promote(a,'Pinned destination');
  const row=one('SELECT config_enc FROM connections WHERE id = ?',a.id); const original=row.config_enc;
  const { encrypt }=await import('../server/crypto.ts'); run('UPDATE connections SET config_enc = ? WHERE id = ?',encrypt({baseUrl:'http://other.example'}),a.id);
  assert.throws(()=>loadConnection(user.id,a.id),/relink|incompatible/);run('UPDATE connections SET config_enc = ? WHERE id = ?',original,a.id);
  assert.equal((await request(`/credentials/${source.id}/revoke`,{version:source.version})).status,200);
  assert.throws(()=>loadConnection(user.id,a.id),/reconnection/);
  assert.equal((await request(`/connections/${a.id}/credential/independent`,{})).status,400);
});
test('OAuth refresh is serialized across connections and request policies retain boundaries', async () => {
  const a=await connect('a','oauth');const b=await connect('b','oauth');const source=await promote(a,'Google-like account');
  await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  const expired=getCredential(user.id,source.id); replaceCredential(expired,{...decrypt(expired.credentials_enc),expiresAt:Date.now()-1});
  const before=rotations;
  const results=await Promise.all([request('/call',{connection:a.id,url:'/a/resource'}),request('/call',{connection:b.id,url:'/b/resource'})]);
  assert.ok(results.every(result=>result.status===200),JSON.stringify(results));assert.equal(rotations,before+1);
  assert.equal(loadConnection(user.id,a.id).conn.credentials.refreshToken,`rotated-${rotations}`);
  assert.equal((await request('/call',{connection:a.id,url:'/b/resource'})).status,403);
  assert.equal((await request('/call',{connection:a.id,url:'/a/resource',method:'POST'})).status,403);
  assert.equal((await request(`/connections/${a.id}/credential/independent`,{})).status,409);
});
test('OAuth additional consent preserves grant scopes and account identity', async () => {
  const flow=await startConnect(user,{service:'reuse-a',method:'oauth',name:'limited-oauth',config:{baseUrl:origin}});
  assert.equal(flow.status,'redirect');if(flow.status!=='redirect')return;
  const a=await completeRedirect(flow.flowId,{code:'only-a',state:flow.flowId},user);const source=await promote(a,'Limited grant');const b=await connect('b','oauth');
  const linked=await request(`/connections/${b.id}/credential`,{credentialId:source.id});assert.equal(linked.status,409);assert.equal(linked.data.code,'CREDENTIAL_CONSENT_REQUIRED');
  const consent=await startConnect(user,{service:'reuse-b',connection:b.id,credentialId:source.id,config:{baseUrl:origin}});assert.equal(consent.status,'redirect');if(consent.status!=='redirect')return;
  assert.ok(new URL(consent.url).searchParams.get('scope')!.split(' ').includes('a'));
  await completeRedirect(consent.flowId,{code:'both',state:consent.flowId},user);
  assert.equal(one('SELECT credential_id FROM connections WHERE id = ?',b.id).credential_id,source.id);
  assert.equal(loadConnection(user.id,a.id).conn.credentials.scope,'a b');
});
test('stale OAuth callbacks cannot overwrite a newer credential or connection configuration', async () => {
  const a=await connect('a','oauth');const source=await promote(a,'Stale callback');
  const reconnect=await startConnect(user,{service:'reuse-a',connection:a.id,config:{baseUrl:origin}});assert.equal(reconnect.status,'redirect');if(reconnect.status!=='redirect')return;
  const current=getCredential(user.id,source.id);replaceCredential(current,{...decrypt(current.credentials_enc),accessToken:'newer-token'});
  const before=one('SELECT config_enc FROM connections WHERE id = ?',a.id).config_enc;
  await assert.rejects(completeRedirect(reconnect.flowId,{code:'both',state:reconnect.flowId},user),/changed during sign-in/);
  assert.equal(loadConnection(user.id,a.id).conn.credentials.accessToken,'newer-token');assert.equal(one('SELECT config_enc FROM connections WHERE id = ?',a.id).config_enc,before);
});
test('new connections can reuse stored secrets and expired grants require reauthorization', async () => {
  const a=await connect('a');const source=await promote(a,'For new connections');
  const newConnection=await startConnect(user,{service:'reuse-b',method:'token',name:'new-b',credentialId:source.id,config:{baseUrl:origin}});
  assert.equal(newConnection.status,'connected');if(newConnection.status==='connected')assert.equal(loadConnection(user.id,newConnection.connection.id).conn.credentials.token,'original');
  const oauth=await connect('a','oauth');const grant=await promote(oauth,'Expired grant'); const expired=getCredential(user.id,grant.id); replaceCredential(expired,{...decrypt(expired.credentials_enc),expiresAt:Date.now()-1}); badRefresh=true;
  const result=await request('/call',{connection:oauth.id,url:'/a/resource'});badRefresh=false;
  assert.equal(result.status,502);assert.equal(getCredential(user.id,grant.id).status,'error');
});


test('one canonical opaque secret works across bearer and header authentication', async () => {
  const a=await connect('a'); const source=await promote(a,'Multi-protocol secret');
  const header=await startConnect(user,{service:'reuse-b',method:'header',name:'header-consumer',credentialId:source.id,config:{baseUrl:origin}});
  assert.equal(header.status,'connected'); if(header.status!=='connected') return;
  assert.equal(loadConnection(user.id,header.connection.id).conn.credentials.key,'original');
  const result=await request(`/credentials/${source.id}/rotate`,{version:source.version,config:{token:'rotated-opaque'}});
  assert.equal(result.status,200); assert.equal(loadConnection(user.id,header.connection.id).conn.credentials.key,'rotated-opaque');
});
test('OAuth lifecycle secrets are held only by the credential and issuer/client incompatibility is rejected', async () => {
  const flow=await startConnect(user,{service:'reuse-a',method:'oauth',name:'custom-client',config:{baseUrl:origin,clientId:'custom-client',clientSecret:'stored-only-on-source'}});
  if(flow.status!=='redirect')throw new Error('Expected redirect');const a=await completeRedirect(flow.flowId,{code:'both',state:flow.flowId},user);
  const source=await promote(a,'Custom client grant');
  assert.equal(decrypt(one('SELECT config_enc FROM connections WHERE id = ?',a.id).config_enc).clientSecret,undefined);
  assert.equal(decrypt(getCredential(user.id,source.id).config_enc).clientSecret,'stored-only-on-source');
  const shared=await startConnect(user,{service:'reuse-b',method:'oauth',name:'shared-custom-client',credentialId:source.id,config:{baseUrl:origin}});
  assert.equal(shared.status,'connected');if(shared.status==='connected') {
    assert.equal(loadConnection(user.id,shared.connection.id).conn.config.clientSecret,'stored-only-on-source');
    assert.equal(decrypt(one('SELECT config_enc FROM connections WHERE id = ?',shared.connection.id).config_enc).clientSecret,undefined);
  }
  await assert.rejects(startConnect(user,{service:'reuse-b',method:'oauth',name:'wrong-client',credentialId:source.id,config:{baseUrl:origin,clientId:'different-client'}}),/incompatible/);
});
test('reconnection with a different OAuth account or insufficient scopes preserves the shared grant', async () => {
  const a=await connect('a','oauth');const b=await connect('b','oauth');const source=await promote(a,'Protected consent');await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  const original=loadConnection(user.id,a.id).conn.credentials.accessToken;
  for(const code of ['wrong-account','only-a']) {
    const flow=await startConnect(user,{service:'reuse-a',connection:a.id,config:{baseUrl:origin}});if(flow.status!=='redirect')throw new Error('Expected redirect');
    await assert.rejects(completeRedirect(flow.flowId,{code,state:flow.flowId},user),/account|permissions/);
    assert.equal(loadConnection(user.id,a.id).conn.credentials.accessToken,original);
  }
});
test('OAuth independence authorizes a new private grant without changing the shared source', async () => {
  const a=await connect('a','oauth');const b=await connect('b','oauth');const source=await promote(a,'Independent consent');await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  const flow=await startConnect(user,{service:'reuse-b',connection:b.id,independent:true,config:{baseUrl:origin}});if(flow.status!=='redirect')throw new Error('Expected redirect');
  await completeRedirect(flow.flowId,{code:'independent',state:flow.flowId},user);
  assert.equal(one('SELECT credential_id FROM connections WHERE id = ?',b.id).credential_id,null);
  assert.ok(loadConnection(user.id,b.id).conn.credentials.accessToken.includes('independent'));
  assert.equal(one('SELECT credential_id FROM connections WHERE id = ?',a.id).credential_id,source.id);
  const scoped=createToken(user.id,'private-broader-grant',[b.id]);
  assert.equal((await request(`/connections/${b.id}/token`,undefined,scoped.secret)).status,403);
  assert.equal((await request('/call',{connection:b.id,url:'/a/resource'},scoped.secret)).status,403);
});
test('cookie management writes require the same origin and audit never retains replacement secrets', async () => {
  const { createSession }=await import('../server/users.ts');const cookie=`switchboard_session=${createSession(user.id)}`;
  const response=await app.request('/api/credentials',{method:'POST',headers:{cookie,origin:'https://other.example','content-type':'application/json'},body:JSON.stringify({name:'csrf'})});assert.equal(response.status,403);
  const logs=JSON.stringify(all('SELECT * FROM audit_log WHERE method = ?', 'CREDENTIAL'));
  assert.equal(logs.includes('active-during-outage'),false);assert.equal(logs.includes('new-token'),false);
});


test('revocation disables the source immediately and an in-flight refresh cannot reactivate it', async () => {
  const a=await connect('a','oauth');const source=await promote(a,'Revocation race');
  let row=getCredential(user.id,source.id);replaceCredential(row,{...decrypt(row.credentials_enc),expiresAt:Date.now()-1});row=getCredential(user.id,source.id);
  let release!:()=>void;heldRefresh=new Promise(resolve=>{release=resolve});
  const started=new Promise<void>(resolve=>{refreshStarted=resolve});
  const call=request('/call',{connection:a.id,url:'/a/resource'});await started;
  const revoked=request(`/credentials/${source.id}/revoke`,{version:row.version});
  for(let i=0;i<50&&getCredential(user.id,source.id).status!=='revoked';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(getCredential(user.id,source.id).status,'revoked');
  release();heldRefresh=undefined;refreshStarted=undefined;
  await revoked;const completed=await call;assert.notEqual(completed.status,200);
  assert.equal(getCredential(user.id,source.id).status,'revoked');
});
test('an unavailable original product is not a credential parent dependency', async () => {
  const a=await connect('a','oauth');const b=await connect('b','oauth');const source=await promote(a,'Provider fallback');await request(`/connections/${b.id}/credential`,{credentialId:source.id});
  const registration=plugins.services.get('reuse-a')!;plugins.services.delete('reuse-a');
  try {
    const current=getCredential(user.id,source.id);replaceCredential(current,{...decrypt(current.credentials_enc),expiresAt:Date.now()-1});
    assert.equal((await request('/call',{connection:b.id,url:'/b/resource'})).status,200);
    assert.equal((await request(`/credentials/${source.id}`)).data.status,'ok');
  } finally {plugins.services.set('reuse-a',registration);}
});


test('legacy sign-in methods keep working while setup offers their replacement', async () => {
  const { listServices } = await import('../server/connections.ts');
  const { execute } = await import('../server/proxy.ts');
  const existing = await connect('a', 'token', 'legacy-token');
  const service = plugins.service('reuse-a')!;
  const original = service.authMethods;
  const legacy = original.find(m => m.id === 'token')!;
  try {
    service.authMethods = [{ ...legacy, hidden: true }, { ...legacy, id: 'replacement', name: 'Shared authentication' }];
    assert.deepEqual(listServices(user.id).find(s => s.id === service.id)!.methods.map(m => m.id), ['replacement']);
    const result = await execute(user, existing.id, { method: 'GET', url: '/legacy-test' });
    assert.equal(result.response.status, 200);
    assert.equal((await result.response.json()).authorization, 'Bearer legacy-token');
    const added = await startConnect(user, { service: service.id, name: 'replacement-default', config: { baseUrl: origin, token: 'replacement-token' } });
    assert.equal(added.status, 'connected');
    if (added.status === 'connected') assert.equal(added.connection.methodId, 'replacement');
    const migrated = await startConnect(user, { service: service.id, connection: existing.id, method: 'replacement', config: { baseUrl: origin, token: 'migrated-token' } });
    assert.equal(migrated.status, 'connected');
    if (migrated.status === 'connected') {
      assert.equal(migrated.connection.id, existing.id);
      assert.equal(migrated.connection.methodId, 'replacement');
    }
  } finally { service.authMethods = original; }
});
