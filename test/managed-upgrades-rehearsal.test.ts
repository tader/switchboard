import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Controller, atomic, command, type Settings } from '../updater/engine.ts';
import type { Job } from '../server/updates/control.ts';

const root = path.resolve(import.meta.dirname, '..');
async function freePort() { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return port; }
function release(dir: string, revision: string, version: string) {
  fs.mkdirSync(dir);
  fs.cpSync(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins')); fs.mkdirSync(path.join(dir, 'web'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  atomic(path.join(dir, 'package.json'), { type: 'module', version, managedUpgradeProtocol: 1 });
  atomic(path.join(dir, 'build-info.json'), { version, revision });
}
test('real gated checkout rehearses migration, preserves encrypted credentials, extension and browser data through rollback', { timeout: 35_000 }, async () => {
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => { providerCalls++; setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{}'); }, 250); });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-checkout-'));
  const previous = path.join(tmp, 'previous'), candidate = path.join(tmp, 'candidate');
  const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40);
  release(previous, oldSha, '1.0.0'); release(candidate, newSha, '1.1.0');
  let code = fs.readFileSync(path.join(candidate, 'server/db.ts'), 'utf8');
  code = code.replace('\n];\n', "\n  `ALTER TABLE connections ADD COLUMN synthetic_upgrade TEXT;`,\n];\n"); fs.writeFileSync(path.join(candidate, 'server/db.ts'), code);
  const port = await freePort(), dataDir = path.join(tmp, 'data'), stateDir = path.join(tmp, 'updater'); fs.mkdirSync(dataDir); fs.mkdirSync(stateDir);
  const token = 'swbu_synthetic-rehearsal-token';
  const job: Job = { id: 'synthetic-rehearsal', state: 'queued', createdAt: Date.now(), target: { version: '1.1.0', revision: newSha, baseRevision: oldSha, protocol: 1, channel: 'stable', notes: '', url: 'https://example.com' } };
  atomic(path.join(dataDir, 'update-control.json'), { tokenHash: createHash('sha256').update(token).digest('hex'), paired: { instance: 'synthetic', mode: 'checkout', protocol: 1, seen: Date.now() }, job });
  const init = "const c=await import('./server/crypto.ts');c.initKey();const d=await import('./server/db.ts');d.initDb();d.run(\"INSERT INTO users(id,username,role,created_at)VALUES('u','synthetic','admin',0)\");d.run(\"INSERT INTO connections(id,user_id,service_id,method_id,name,credentials_enc,created_at,updated_at)VALUES('c','u','synthetic','key','synthetic',?,0,0)\",c.encrypt({secret:'synthetic-encrypted-value'}));const u=await import('./server/users.ts');console.log(u.createToken('u','synthetic-drain',null).secret);d.db.close();";
  const apiToken = await command(process.execPath, ['--input-type=module', '-e', init], previous, { ...process.env, SWITCHBOARD_DATA_DIR: dataDir });
  const ext = path.join(dataDir, 'plugins', 'synthetic'); fs.mkdirSync(ext, { recursive: true });
  atomic(path.join(ext, 'plugin.json'), { id: 'synthetic', name: 'Synthetic', version: '1.0.0' });
  fs.writeFileSync(path.join(ext, 'index.ts'), "import fs from 'node:fs'; import path from 'node:path'; export default function(ctx){let rejectActive;const event=e=>fs.appendFileSync(path.join(process.env.SWITCHBOARD_DATA_DIR,'operation-events'),e+'\\n');fs.appendFileSync(path.join(process.env.SWITCHBOARD_DATA_DIR,'extension-starts'),'opened\\n');return {dispose(){event('dispose');rejectActive?.(new Error('Disposed active operation'));},services:[{id:'synthetic',name:'Synthetic',baseUrl:" + JSON.stringify(providerUrl) + ",authMethods:[{id:'key',name:'Key',connect:async()=>({credentials:{}}),authorize:async()=>{fs.writeFileSync(path.join(process.env.SWITCHBOARD_DATA_DIR,'operation-active'),'active');await new Promise((resolve,reject)=>{rejectActive=reject;setTimeout(resolve,250)});rejectActive=undefined;event('complete');}}]}]};}\n");
  fs.mkdirSync(path.join(dataDir, 'browser-profiles', 'synthetic'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'browser-profiles', 'synthetic', 'Cookies'), 'synthetic-browser-bytes');
  const s: Settings = { instance: 'synthetic', mode: 'checkout', dataDir, stateDir, appUrl: `http://127.0.0.1:${port}`, initialRelease: previous, token, env: { SWITCHBOARD_PORT: String(port), SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_WATCH_PLUGINS: 'false', SWITCHBOARD_UPDATE_CHECKS: 'false' } };
  class Rehearsal extends Controller {
    failCandidate = true;
    exerciseDrain = false;
    drainEvidence?: { status: number; events: string; providerCalls: number };
    override async api(endpoint: string, body?: unknown) {
      let finite: Promise<Response> | undefined;
      if (endpoint === 'drain' && this.exerciseDrain) {
        this.exerciseDrain = false;
        finite = fetch(`${this.s.appUrl}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ connection: 'c', method: 'GET', url: '/slow' }) });
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(path.join(dataDir, 'operation-active'))) { if (Date.now() > deadline) throw Error('Synthetic plugin operation did not start'); await new Promise(r => setTimeout(r, 10)); }
      }
      const r = await super.api(endpoint, body);
      if (endpoint === 'drain') {
        assert.equal((await fetch(`${this.s.appUrl}/api/info`)).status, 503);
        assert.equal((await fetch(`${this.s.appUrl}/healthz`)).status, 200);
        if (finite) { const response = await finite; await response.text(); this.drainEvidence = { status: response.status, events: fs.readFileSync(path.join(dataDir, 'operation-events'), 'utf8'), providerCalls }; }
      }
      return r;
    }
    override async prepare() { return candidate; }
    override async ready(expected?: string) {
      const result = await super.ready(expected);
      if (expected && this.failCandidate) { assert.equal(result.state, 'staged'); throw Error('Synthetic startup validation failure before open'); }
      return result;
    }
  }
  let c = new Rehearsal(s);
  try {
    await c.start(previous); await c.ready(oldSha).catch(e => { if (!String(e).includes('Synthetic')) throw e; });
    assert.equal((await fetch(`${s.appUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.appUrl}/readyz`)).status, 503);
    assert.equal((await fetch(`${s.appUrl}/api/info`)).status, 503);
    assert.equal(fs.existsSync(path.join(dataDir, 'extension-starts')), false);
    await c.api('open', {});
    assert.equal((await fetch(`${s.appUrl}/readyz`)).status, 200);
    assert.equal(fs.readFileSync(path.join(dataDir, 'extension-starts'), 'utf8'), 'opened\n');
    c.exerciseDrain = true; await c.execute(job);
    assert.equal(c.drainEvidence?.status, 200, 'disposing the extension must not invalidate its in-flight authorization');
    assert.equal(c.drainEvidence.events, 'complete\ndispose\n', 'extension disposal must follow completion of its active operation');
    assert.equal(c.drainEvidence.providerCalls, 1);
    assert.equal(c.journal?.phase, 'rolled-back');
    const live = await c.api('ready'); assert.equal(live.build.revision, oldSha); assert.equal(live.state, 'open');
    const failedDb = new DatabaseSync(path.join(stateDir, 'failed-data-synthetic-rehearsal', 'switchboard.db'), { readOnly: true });
    assert.ok((failedDb.prepare('PRAGMA table_info(connections)').all() as any[]).some(r => r.name === 'synthetic_upgrade')); failedDb.close();
    const currentDb = new DatabaseSync(path.join(dataDir, 'switchboard.db'), { readOnly: true });
    assert.ok(!(currentDb.prepare('PRAGMA table_info(connections)').all() as any[]).some(r => r.name === 'synthetic_upgrade')); currentDb.close();
    const decrypted = await command(process.execPath, ['--input-type=module', '-e', "const c=await import('./server/crypto.ts');c.initKey();const {DatabaseSync}=await import('node:sqlite');const d=new DatabaseSync(process.env.SWITCHBOARD_DATA_DIR+'/switchboard.db');console.log(c.decrypt(d.prepare('SELECT credentials_enc FROM connections').get().credentials_enc).secret);d.close()"], previous, { ...process.env, SWITCHBOARD_DATA_DIR: dataDir });
    assert.equal(decrypted, 'synthetic-encrypted-value');
    assert.equal(fs.readFileSync(path.join(dataDir, 'browser-profiles/synthetic/Cookies'), 'utf8'), 'synthetic-browser-bytes');
    assert.equal(fs.readFileSync(path.join(dataDir, 'extension-starts'), 'utf8'), 'opened\nopened\n');
    assert.ok(fs.existsSync(path.join(c.journal!.backup!, 'plugins/synthetic/index.ts')));
    // Kill a real controller after it has started a gated candidate. The application survives it.
    const deathJob = { ...job, id: 'synthetic-controller-death' };
    let savedControl = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-control.json'), 'utf8')); atomic(path.join(dataDir, 'update-control.json'), { ...savedControl, job: deathJob });
    c.journal = { job: deathJob, phase: 'snapshot', previous, target: candidate, startedAt: Date.now(), durations: {} }; c.save();
    await c.api('drain', {}); await c.stop(); await c.snapshot(); c.journal.phase = 'starting'; c.save();
    const crashScript = `const {Controller,acquireController}=await import(${JSON.stringify(path.join(root, 'updater/engine.ts'))});const s=JSON.parse(process.argv[1]);acquireController(s);const c=new Controller(s);await c.start(c.journal.target);await c.ready();process.kill(process.pid,'SIGKILL');`;
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript, JSON.stringify(s)], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(crash.signal, 'SIGKILL');
    assert.equal((await c.api('ready')).state, 'staged');
    c = new Rehearsal(s); await c.recover(); assert.equal(c.journal!.phase, 'rolled-back');
    assert.equal((await c.api('ready')).build.revision, oldSha);
    c.failCandidate = false;
    const next = { ...job, id: 'synthetic-success', state: 'queued' };
    const control = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-control.json'), 'utf8')); atomic(path.join(dataDir, 'update-control.json'), { ...control, job: next });
    await c.execute(next); assert.equal(c.journal!.phase, 'succeeded');
    assert.equal((await c.api('ready')).build.revision, newSha);
    assert.ok(fs.existsSync(path.join(stateDir, 'backups/synthetic-rehearsal')));
    assert.ok(fs.existsSync(path.join(stateDir, 'backups/synthetic-success')));
    assert.equal(fs.readFileSync(path.join(previous, 'build-info.json'), 'utf8').includes(oldSha), true);
    assert.equal(providerCalls, 1, 'drained provider operation was never replayed across rollback, controller death or success');
  } finally { await c.stop(); await new Promise<void>(r => provider.close(() => r())); fs.rmSync(tmp, { recursive: true, force: true }); }
});
