import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-credential-peer-'));
const processes:ChildProcess[]=[];
let rejectCurrent=false;
const upstream=http.createServer((req,res)=>{if(rejectCurrent&&req.headers.authorization==='Bearer fixture-access-secret'){res.writeHead(401);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({authorization:req.headers.authorization}));});
after(async()=>{for(const child of processes)child.kill();upstream.close();await new Promise(resolve=>setTimeout(resolve,150));fs.rmSync(scratch,{recursive:true,force:true});});
async function waitFor(fn: () => any | Promise<any>, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for credential peer');
}
async function launch(name: string, port: number) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/credential-provider'), path.join(dir, 'plugins/credential-provider-test'), { recursive: true });
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env,
    SWITCHBOARD_PORT: String(port), SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_DATA_DIR: dir, SWITCHBOARD_WATCH_PLUGINS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child); child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
  await waitFor(() => output.includes('Switchboard listening'));
  let cookie = '';
  const url = `http://127.0.0.1:${port}`;
  const request = async (method: string, pathname: string, body?: unknown, secret?: string) => {
    const response = await fetch(url + pathname, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(secret ? { authorization: `Bearer ${secret}` } : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, data: await response.json() as any };
  };
  const invitation = output.match(/\/invite#(\S+)/)?.[1];
  assert.equal((invitation ? await request('POST', '/api/auth/invite', { token: invitation, password: 'test-password' }) : await request('POST', '/api/auth/login', { username: 'admin', password: 'test-password' })).status, 200);
  const user = (await request('GET', '/api/me')).data;
  return { request, user, url, dir, child };
}

test('credential transfers require an explicit grant; imported credentials work offline and stop after delivered unsharing',async()=>{
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
 const port=49000+Math.floor(Math.random()*400);
 const laptop=await launch('laptop',port);let server=await launch('server',port+500);
 const accepted=await server.request('POST','/api/admin/peers',{name:'Laptop',ownerUserId:server.user.id});assert.equal(accepted.status,201);
 const linked=await laptop.request('POST','/api/admin/peers',{direction:'outgoing',name:'Server',url:server.url,token:accepted.data.token,ownerUserId:laptop.user.id});assert.equal(linked.status,201);
 await waitFor(async()=>(await server.request('GET','/api/admin/peers')).data.some((p:any)=>p.online));
 const src=await laptop.request('POST','/api/connections',{service:'fixture-authentication',method:'source',name:'work-authentication',config:{secret:'fixture-access-secret'}});assert.equal(src.status,200,JSON.stringify(src.data));
 const source=src.data.connection.id;
 const local=await laptop.request('POST','/api/connections',{service:'fixture-consumer',method:'source',name:'local-consumer',config:{authenticationSource:source,endpoint}});assert.equal(local.status,200,JSON.stringify(local.data));
 const peer=linked.data.peer.id;
 assert.equal((await laptop.request('PUT',`/api/connections/${source}/shares`,{peerIds:[peer]})).status,200);
 let remote:any;
 await waitFor(async()=>{remote=(await server.request('GET','/api/connections')).data.find((c:any)=>c.name==='work-authentication');return !!remote;});
 const candidates=()=>server.request('GET','/api/credentials/providers?format=fixture%2Fauthentication%2Fv1');
 assert.equal((await candidates()).data.length,0,'ordinary sharing does not export credentials');
 const denied=await server.request('POST','/api/connections',{service:'fixture-consumer',method:'source',config:{authenticationSource:remote.id,endpoint}});assert.equal(denied.status,403,JSON.stringify(denied.data));
 assert.equal((await laptop.request('PUT',`/api/connections/${source}/shares`,{peerIds:[peer],credentialPeerIds:[peer]})).status,200);
 await waitFor(async()=>(await candidates()).data.length===1);
 // A generic connection test can leave an otherwise valid authentication source in error.
 const failedProbe=await laptop.request('POST','/api/call',{connection:source,method:'GET',url:'/'});
 assert.equal(failedProbe.status,502);
 await waitFor(async()=>(await server.request('GET','/api/connections')).data.find((c:any)=>c.id===remote.id)?.status==='unavailable',30_000);
 const blockedData=await server.request('POST','/api/call',{connection:remote.id,method:'GET',url:'/'});
 assert.equal(blockedData.status,503,'ordinary data calls stay blocked for an errored shared source');
 const consumer=await server.request('POST','/api/connections',{service:'fixture-consumer',method:'source',name:'server-consumer',config:{authenticationSource:remote.id,endpoint}});assert.equal(consumer.status,200,JSON.stringify(consumer.data));
 assert.equal((await laptop.request('GET',`/api/connections/${source}`)).data.status,'ok','successful credential provision clears the stale provider error');
 const id=consumer.data.connection.id;
 assert.ok(!JSON.stringify(consumer.data).includes('fixture-access-secret'));
 const call=()=>server.request('POST','/api/call',{connection:id,method:'GET',url:'/test'});
 const initial=await call();assert.equal(initial.status,200,JSON.stringify(initial.data));assert.equal(JSON.parse(initial.data.body).authorization,'Bearer fixture-access-secret');
 const sibling=await server.request('POST','/api/connections',{service:'fixture-consumer',method:'source',name:'outlook-consumer',config:{authenticationSource:remote.id,endpoint,audience:'outlook'}});assert.equal(sibling.status,200,JSON.stringify(sibling.data));assert.equal(sibling.data.connection.credential.id,consumer.data.connection.credential.id,'family connections share one cached source credential');
 const projected=await server.request('POST','/api/call',{connection:sibling.data.connection.id,method:'GET',url:'/test'});assert.equal(projected.status,200,JSON.stringify(projected.data));assert.equal(JSON.parse(projected.data.body).authorization,'Bearer fixture-access-secret-outlook','each consumer receives the correct API audience');
 const stored=new DatabaseSync(path.join(server.dir,'switchboard.db'));
 const credentialLink=stored.prepare('SELECT credential_id FROM connections WHERE id=?').get(sibling.data.connection.id)!;
 const version=(stored.prepare('SELECT version FROM credentials WHERE id=?').get(credentialLink.credential_id)!).version;
 stored.prepare("UPDATE connections SET status='error',status_message='Shared credential authentication failed; check or reconnect it' WHERE id=?").run(sibling.data.connection.id);
 const recovered=await server.request('POST','/api/call',{connection:sibling.data.connection.id,method:'GET',url:'/test'});assert.equal(recovered.status,200);
 const recoveredView=(await server.request('GET',`/api/connections/${sibling.data.connection.id}`)).data;
 assert.equal(recoveredView.status,'ok');assert.equal(recoveredView.statusMessage,null);assert.equal(stored.prepare('SELECT version FROM credentials WHERE id=?').get(credentialLink.credential_id)!.version,version,'cached Outlook token recovery does not need credential rotation');stored.close();
 rejectCurrent=true;const renewed=await call();assert.equal(renewed.status,200,JSON.stringify(renewed.data));assert.equal(JSON.parse(renewed.data.body).authorization,'Bearer fixture-access-secret-renewed','intermediate refresh-token persistence and final access-token persistence share a correct CAS version');
 const secretOnly=(await server.request('POST','/api/tokens',{name:'limited',connectionIds:[id]})).data.secret;
 assert.equal((await server.request('GET','/api/credentials/providers?format=fixture%2Fauthentication%2Fv1',undefined,secretOnly)).status,403);
 const raw=await server.request('GET',`/api/connections/${remote.id}/token`);assert.notEqual(raw.status,200);
 await laptop.request('PATCH',`/api/admin/peers/${peer}`,{disabled:true});
 await waitFor(async()=>!(await server.request('GET','/api/admin/peers')).data.some((p:any)=>p.online));
 assert.equal((await call()).status,200,'cached credentials survive a disconnected laptop');
 const stopped=new Promise(resolve=>server.child.once('exit',resolve));server.child.kill();await stopped;server=await launch('server',port+500);
 assert.equal((await call()).status,200,'encrypted imported credentials survive restart while the laptop is offline');
 await laptop.request('PATCH',`/api/admin/peers/${peer}`,{disabled:false});
 await waitFor(async()=>(await server.request('GET','/api/admin/peers')).data.some((p:any)=>p.online));
 await laptop.request('PUT',`/api/connections/${source}/shares`,{peerIds:[peer],credentialPeerIds:[]});
 await waitFor(async()=>(await candidates()).data.length===0);
 assert.notEqual((await call()).status,200,'delivered revocation blocks even an unexpired cached credential');
 const logs=await server.request('GET','/api/activity');assert.ok(!JSON.stringify(logs.data).includes('fixture-access-secret'));assert.ok(!JSON.stringify(logs.data).includes('fixture-refresh'));
});
