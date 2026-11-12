/** Actual prepared-runtime cutover/recovery using local synthetic release fixtures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Controller, acquireController, atomic, readJson, type Settings } from '../updater/engine.ts';
import type { Target } from '../server/updates/releases.ts';
const runtime = path.resolve(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-controller-rehearsal-'));
const candidate = path.join(root, 'candidate'); fs.cpSync(runtime,candidate,{recursive:true});
const b = JSON.parse(fs.readFileSync(path.join(runtime,'build-info.json'),'utf8'));
atomic(path.join(candidate,'build-info.json'),{...b,revision:'b'.repeat(40)});
const socket=net.createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
const url=`http://127.0.0.1:${port}`;
const s:Settings={instance:'local-manager',mode:'runtime',initialRelease:runtime,stateDir:path.join(root,'state'),dataDir:path.join(root,'data'),appUrl:url,env:{SWITCHBOARD_HOST:'127.0.0.1',SWITCHBOARD_PORT:String(port),SWITCHBOARD_PUBLIC_URL:url,SWITCHBOARD_UPDATE_CHECKS:'false'}};
const unlock=acquireController(s);
class Rehearsal extends Controller {
  fail=false;
  override async prepare() { return candidate; }
  override async ready(revision?:string) { const result=await super.ready(revision);if(revision&&this.fail)throw Error('Synthetic pre-open readiness failure');return result; }
}
const c=new Rehearsal(s);
async function ipc(action:string):Promise<any>{return new Promise((resolve,reject)=>{const id=1;const child=c.child!;const timer=setTimeout(()=>reject(Error('IPC timeout')),5000);const listener=(m:any)=>{if(m.id===id){clearTimeout(timer);child.off('message',listener);resolve(m.result)}};child.on('message',listener);child.send({kind:'local-manager',id,action});});}
async function enqueue(id:string){const target:Target={version:b.version,revision:'b'.repeat(40),baseRevision:b.revision,channel:'stable',notes:'Synthetic runtime',url:'https://example.com/release',protocol:1};const job={id,target,state:'queued',createdAt:Date.now()};const file=path.join(s.dataDir,'update-control.json');atomic(file,{...readJson<any>(file),job});return job;}
try {
  await c.start(runtime,false);
  for(let n=0;;n++){try{if((await fetch(url+'/readyz')).ok)break;}catch{}if(n>200)throw Error('Readiness timeout');await new Promise(r=>setTimeout(r,100));}
  const {setupUrl}=await ipc('bootstrap');assert.ok(setupUrl);
  assert.equal((await fetch(url+'/api/auth/invite',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({token:setupUrl.split('#')[1],password:'synthetic-test-password'})})).status,200);
  await c.pairOwnedChild();
  for(const endpoint of ['/api/me','/api/admin/updates','/api/connections'])assert.equal((await fetch(url+endpoint,{headers:{authorization:`Bearer ${s.token}`}})).status,401);
  c.fail=true;await c.execute(await enqueue('runtime-rollback'));assert.equal(c.journal!.phase,'rolled-back');
  c.fail=false;await c.execute(await enqueue('runtime-upgrade'));assert.equal(c.journal!.phase,'succeeded');assert.equal((await c.api('poll',{})).build.revision,'b'.repeat(40));
  // Simulate a supervisor restart before opening, including loss of its in-memory credential.
  c.journal!.phase='starting';c.journal!.opened=false;c.save();await c.stop();await c.start(candidate,true);c.s.token=undefined;
  await c.recover();assert.equal(c.journal!.phase,'rolled-back');assert.equal((await c.api('poll',{})).build.revision,b.revision);
  await c.stop();await c.start(c.current(),false);await c.ready();await c.stop();
  console.log('PASS: real prepared runtime migration rehearsal, full snapshot, candidate cutover, pre-open rollback, successful upgrade, credential-free interrupted recovery, restart, narrow credential API rejection');console.log(`Artifacts: ${root}`);
} finally {await c.stop().catch(()=>{});unlock();}
