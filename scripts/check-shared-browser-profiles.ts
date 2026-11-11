// Local synthetic SSO, using the production core pipe transport and both adapters.
// Usage: node scripts/check-shared-browser-profiles.ts <microsoft checkout> <idm checkout>
import fs from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [microsoft, idm] = process.argv.slice(2);
if (!microsoft || !idm) throw Error('Pass Microsoft and IDM checkout paths');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swb-synthetic-sso-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
const { initDb } = await import('../server/db.ts');
const { initKey } = await import('../server/crypto.ts');
const { createUser } = await import('../server/users.ts');
const core = await import('../server/browser-profiles.ts');
const { acquireBrowserRefresh } = await import(pathToFileURL(path.join(microsoft, 'plugins/microsoft-authentication/lib/browser.js')).href);
const { TEAMS_CLIENT_ID } = await import(pathToFileURL(path.join(microsoft, 'plugins/microsoft-authentication/lib/session.js')).href);
const { authenticate, operationState } = await import(pathToFileURL(path.join(idm, 'lib/authentication.js')).href);
const { ORIGIN } = await import(pathToFileURL(path.join(idm, 'lib/model.js')).href);
initKey(); initDb(); const user = createUser('fixture', 'user');
const profile = await core.reserveBrowserProfile(user.id, 'fixture', 'fixture-flow');
let loginPages = 0, retainedLogins = 0;
const token = 'x.' + Buffer.from(JSON.stringify({ tid: '11111111-1111-4111-8111-111111111111', oid: '22222222-2222-4222-8222-222222222222' })).toString('base64url') + '.x';
const msOrigin = 'https://teams.microsoft.com';
const loginOrigin = 'https://login.microsoftonline.com';
const tokenUrl = loginOrigin + '/fixture/oauth2/v2.0/token';
// Every request is fulfilled over CDP. No Microsoft or IDM network is used.
const fixture: typeof profile = { id: profile.id, run(options, operation) {
  return profile.run({ ...options, headless: true }, async (browser, signal) => {
    const originalPage = browser.page.bind(browser);
    const subscriptions: (() => void)[] = [];
    const wrapped = Object.create(browser);
    wrapped.call = browser.call.bind(browser);
    // Fetch.fulfillRequest suppresses Chrome's request ExtraInfo event. Restore the
    // synthetic fixture Origin from its document URL for the scoped capture guard.
    wrapped.subscribe = (listener: (event: any) => void) => browser.subscribe(event => {
      if(event.method==='Network.requestWillBeSent'&&event.params.request.url===tokenUrl) event={...event,params:{...event.params,request:{...event.params.request,headers:{...event.params.request.headers,Origin:new URL(event.params.documentURL).origin}}}};
      listener(event);
    });
    wrapped.page = async (url: string, browserContextId?: string) => {
      const page = await originalPage(url, browserContextId), originalCall = page.call.bind(page);

      subscriptions.push(browser.subscribe(async event => {
        if (event.sessionId !== page.sessionId || event.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = event.params, u = new URL(request.url);
        if (process.env.FIXTURE_TRACE) console.log(request.method, u.origin, u.pathname, u.search);
        let body = '', type = 'text/html', status = 200, headers: {name:string;value:string}[] = [];
        if (u.origin === loginOrigin && u.pathname === '/fixture-login') {
          loginPages++;
          const cookies = await browser.call('Storage.getCookies', { ...(browserContextId ? { browserContextId } : {}) });
          const already = cookies.cookies.some((c: any) => c.name === 'fixture-sso');
          if (already) retainedLogins++;
          else await browser.call('Storage.setCookies', { ...(browserContextId ? { browserContextId } : {}), cookies: [{ name: 'fixture-sso', value: 'synthetic', domain: 'login.microsoftonline.com', path: '/', secure: true, expires: Math.floor(Date.now()/1000)+3600 }] });
          body = `<script>location.href=${JSON.stringify(u.searchParams.get('return')! + '?fixture=ready')}</script>`;
        } else if (u.href.startsWith(tokenUrl)) {
          type = 'application/json'; headers = [{ name: 'Access-Control-Allow-Origin', value: msOrigin }, { name: 'Access-Control-Allow-Headers', value: 'content-type' }];
          body = JSON.stringify({ refresh_token: 'synthetic-refresh', id_token: token });
        } else if (u.origin === msOrigin) {
          body = u.searchParams.has('fixture') ? `<script>fetch(${JSON.stringify(tokenUrl)},{method:'POST',body:new URLSearchParams({client_id:${JSON.stringify(TEAMS_CLIENT_ID)},grant_type:'authorization_code',code:'fixture'})})</script>` : `<script>location.href=${JSON.stringify(loginOrigin + '/fixture-login?return=' + encodeURIComponent(msOrigin + '/v2/'))}</script>`;
        } else if (u.origin === ORIGIN && u.pathname.includes('ResolvePropertyValues')) {
          type = 'application/json'; const jar=await browser.call('Storage.getCookies'); if(!jar.cookies.some((c:any)=>c.name==='fixture-idm'))status=401; body = JSON.stringify({ d: { '1': 'Fixture application' } });
        } else if (u.origin === ORIGIN) {
          body = u.searchParams.has('fixture') ? '<main>Fixture dashboard</main><script>localStorage.setItem("fixture-idm","synthetic")</script>' : `<script>location.href=${JSON.stringify(loginOrigin + '/fixture-login?return=' + encodeURIComponent(ORIGIN + '/Dashboard.aspx'))}</script>`;
          if (u.searchParams.has('fixture')) await browser.call('Storage.setCookies', { cookies: [{ name: 'fixture-idm', value: 'synthetic', domain: new URL(ORIGIN).hostname, path: '/', secure: true }] });
        } else { status = 403; body = 'Fixture blocks all other URLs'; }
        await originalCall('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: type }, ...headers], body: Buffer.from(body).toString('base64') }).catch(() => {});
      }));
      await originalCall('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      // IDM installs its production read guard too. Its continuation is unnecessary
      // because the fixture fulfills the request; no requests may escape the fixture.
      page.call = (method, params, timeout) => method === 'Fetch.continueRequest' || method === 'Fetch.failRequest' ? Promise.resolve({}) : originalCall(method, params, timeout);
      return page;
    };
    try { return await operation(wrapped, signal); } finally { subscriptions.forEach(fn => fn()); }
  });
} };
try {
  const captured = await acquireBrowserRefresh('/unused', { silent: true, sharedProfile: fixture });
  assert.equal(captured.refreshToken, 'synthetic-refresh');
  console.log('Microsoft synthetic capture passed.');
  const state = await authenticate(fixture, {}, undefined);
  assert.equal(loginPages, 2); assert.equal(retainedLogins, 1, 'IDM must reuse the Microsoft SSO cookie after a process restart');
  assert.deepEqual(state.cookies.map((c: any) => c.name), ['fixture-idm']);
  assert.ok(state.origins.every((o: any) => o.origin === ORIGIN));
  assert.equal(JSON.stringify(state).includes('fixture-sso'), false);
  assert.deepEqual(operationState({ cookies: [{ name: 'ms', domain: '.microsoftonline.com' }], origins: [{ origin: loginOrigin, localStorage: [{ name: 'token', value: 'synthetic' }] }] }), { cookies: [], origins: [] });
  // Import the exact snapshot into the production IDM Session/MCP operations
  // browser. This browser has an independent directory and synthetic-only routing.
  const {Session}=await import(pathToFileURL(path.join(idm,'lib/session.js')).href);
  const {MCP}=await import(pathToFileURL(path.join(idm,'lib/mcp.js')).href);
  const operationDir=path.join(dir,'fixture-operations');
  const session=new Session(operationDir,{coreAuthentication:true,mcpCommand:process.env.IDM_MCP_COMMAND},async(dir:string,settings:any,headless:boolean)=>{
    assert.equal(headless,true);
    const client=await MCP.start(dir,settings,true),code=client.code.bind(client);
    client.code=(source:string)=>code(source.replace('await page.goto(', `await page.context().route('**/*',r=>r.request().url().includes('/ResolvePropertyValues')?r.fulfill({contentType:'application/json',body:JSON.stringify({d:{'1':'Fixture application'}})}):r.fulfill({contentType:'text/html',body:'<main>Local synthetic operation session</main>'}));await page.goto(`));
    return client;
  });
  try {
    await session.importAuthentication(state);
    const imported=await session.client.code('async page => await page.context().storageState()');
    assert.deepEqual(imported.cookies.map((c:any)=>c.name),['fixture-idm']);
    assert.equal(imported.origins[0].origin,ORIGIN);
    assert.equal(JSON.stringify(imported).includes('fixture-sso'),false);
    assert.ok((await session.status()).ready);
  } finally {await session.close();}
  // Check real browser cancellation and queued cancellation. A cancelled last waiter
  // must leave the running browser's lock held until the process has actually exited.
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const running = profile.run({ headless: true, signal: controller.signal }, async browser => { await browser.call('Browser.getVersion'); ready(); return new Promise(() => {}); });
  await started;
  const queuedAbort = new AbortController(); let queuedRan = false;
  const queued = profile.run({ headless: true, signal: queuedAbort.signal }, async () => { queuedRan = true; });
  queuedAbort.abort(); await assert.rejects(queued); assert.equal(queuedRan, false);
  controller.abort(); await assert.rejects(running);
  await profile.run({ headless: true }, async browser => { await browser.call('Browser.getVersion'); });
  await profile.run({headless:true,browserPath:'/fixture/missing-browser'},async browser=>{await browser.call('Browser.getVersion');});
  // Deadline and browser-exit recovery are real process exercises.
  await assert.rejects(profile.run({ headless: true, timeoutMs: 400 }, async () => new Promise(() => {})));
  await assert.rejects(profile.run({ headless: true }, async browser => { await browser.call('Browser.close'); return new Promise(() => {}); }), /closed/);
  let activeReady!:()=>void; const activeStarted=new Promise<void>(r=>{activeReady=r;});
  const unloading=profile.run({headless:true},async browser=>{await browser.call('Browser.getVersion');activeReady();return new Promise(()=>{});});
  await activeStarted;
  const otherProfile=await core.reserveBrowserProfile(user.id,'other-plugin','other-flow');
  let otherReady!:()=>void,releaseOther!:()=>void;const otherStarted=new Promise<void>(r=>{otherReady=r;});
  const held=new Promise<void>(r=>{releaseOther=r;});
  const unaffected=otherProfile.run({headless:true},async browser=>{await browser.call('Browser.getVersion');otherReady();await held;await browser.call('Browser.getVersion');});
  await otherStarted;await core.stopBrowserProfiles('fixture');await assert.rejects(unloading);releaseOther();await unaffected;
  await core.releaseBrowserFlow('other-flow');
  // A hard-killed host cannot run JS exit handlers. Verify Chrome exits on pipe
  // EOF, then rehearse restart orphan collection against that throwaway database.
  const crashData=path.join(dir,'crash-restart');await fs.mkdir(crashData);
  const moduleURL=(file:string)=>pathToFileURL(path.resolve(import.meta.dirname,'../server',file)).href;
  const workerSource=`const {initDb}=await import(${JSON.stringify(moduleURL('db.ts'))});const {initKey}=await import(${JSON.stringify(moduleURL('crypto.ts'))});const {createUser}=await import(${JSON.stringify(moduleURL('users.ts'))});const core=await import(${JSON.stringify(moduleURL('browser-profiles.ts'))});initKey();initDb();const user=createUser('crash-fixture','user');const profile=await core.reserveBrowserProfile(user.id,'fixture','crash-flow');await profile.run({headless:true},async browser=>{const {processInfo}=await browser.call('SystemInfo.getProcessInfo');console.log(processInfo.find(p=>p.type==='browser').id);await new Promise(()=>{});});`;
  const worker=spawn(process.execPath,['--input-type=module','-e',workerSource],{env:{...process.env,SWITCHBOARD_DATA_DIR:crashData},stdio:['ignore','pipe','pipe']});
  const browserPid=await new Promise<number>((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(Error('Crash fixture did not start'));},10000);
    worker.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(Number(output.trim()));}});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.stderr.resume();
  });
  worker.kill('SIGKILL');let exited=false;
  for(let i=0;i<50;i++){try{process.kill(browserPid,0);}catch{exited=true;break;}await new Promise(r=>setTimeout(r,100));}
  if(!exited)process.kill(browserPid,'SIGKILL');assert.equal(exited,true,'private pipe EOF must stop the orphan browser');
  const recovery=`const {initDb,all}=await import(${JSON.stringify(moduleURL('db.ts'))});const {initKey}=await import(${JSON.stringify(moduleURL('crypto.ts'))});const core=await import(${JSON.stringify(moduleURL('browser-profiles.ts'))});initKey();initDb();await core.sweepBrowserProfiles();if(all('SELECT * FROM browser_profiles').length)throw Error('Orphan metadata remains');`;
  execFileSync(process.execPath,['--input-type=module','-e',recovery],{env:{...process.env,SWITCHBOARD_DATA_DIR:crashData}});
  assert.deepEqual(await fs.readdir(path.join(crashData,'browser-profiles')),[]);
  console.log('PASS: real private-pipe browser, Microsoft token capture → persisted SSO → IDM auth, origin-only handoff, queued cancellation, deadlines, browser-exit recovery, scoped plugin unload cleanup, separate real IDM operation browser, and hard-crash/restart orphan cleanup. All network responses synthetic.');
} finally { await core.stopBrowserProfiles(); await core.releaseBrowserFlow('fixture-flow'); await fs.rm(dir, { recursive: true, force: true }); }
