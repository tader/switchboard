/** Opt-in, disposable Docker rehearsal. Never use deployment settings or real instance data. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Controller, command, atomic, type Settings } from '../updater/engine.ts';
import type { Job } from '../server/updates/control.ts';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? os.homedir() : os.tmpdir(), '.managed-compose-'));
const previousTag = `switchboard-managed-rehearsal:previous-${process.pid}`, candidateTag = `switchboard-managed-rehearsal:candidate-${process.pid}`;
async function port() { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return p; }
const revision = 'b'.repeat(40), previousRevision = 'a'.repeat(40);
let projects: { file: string; project: string }[] = [];
try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  await command('docker', ['build', '--build-arg', `SWITCHBOARD_REVISION=${previousRevision}`, '-t', previousTag, root]);
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  for (const name of ['server', 'plugins', 'docs', 'web', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-entrypoint.sh', '.dockerignore']) fs.cpSync(path.join(root, name), path.join(source, name), { recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/web/dist') });
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')); pkg.version = '99.0.0'; atomic(path.join(source, 'package.json'), pkg); fs.chmodSync(path.join(source, 'package.json'), 0o644);
  let schema = fs.readFileSync(path.join(source, 'server/db.ts'), 'utf8'); schema = schema.replace('\n];\n', '\n  `ALTER TABLE connections ADD COLUMN synthetic_upgrade TEXT;`,\n];\n'); fs.writeFileSync(path.join(source, 'server/db.ts'), schema);
  await command('docker', ['build', '--build-arg', `SWITCHBOARD_REVISION=${revision}`, '-t', candidateTag, source]);
  for (const mode of ['bind-source', 'volume-image']) {
    const dir = path.join(temp, mode); fs.mkdirSync(dir); const dataDir = path.join(dir, 'data'), stateDir = path.join(dir, 'updater'); fs.mkdirSync(dataDir); fs.mkdirSync(stateDir);
    const project = `managed-rehearsal-${process.pid}-${mode}`, file = path.join(dir, 'compose.json'), appPort = await port();
    const volume = `${project}-data`, token = 'swbu_synthetic-compose-token';
    atomic(file, { services: { app: { image: previousTag, build: { context: root }, ports: [`127.0.0.1:${appPort}:8770`], environment: { SWITCHBOARD_UPDATE_CHECKS: 'false', SWITCHBOARD_WATCH_PLUGINS: 'false', SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${appPort}` }, volumes: [mode === 'bind-source' ? `${dataDir}:/data` : 'data:/data'] }, unrelated: { image: previousTag, entrypoint: ['node', '-e', 'setInterval(()=>{},1000)'] } }, ...(mode === 'volume-image' ? { volumes: { data: { name: volume } } } : {}) });
    projects.push({ file, project });
    const s: Settings = { instance: 'synthetic', mode: 'compose', dataDir: mode === 'volume-image' ? '/data' : dataDir, stateDir, appUrl: `http://127.0.0.1:${appPort}`, env: {}, token, compose: { files: [file], project, service: 'app', directory: dir, sourceBuild: mode === 'bind-source', ...(mode === 'volume-image' ? { dataVolume: volume } : {}) } };
    class Rehearsal extends Controller {
      failCandidate = true;
      override async prepare(t: Job['target']) {
        if (mode === 'bind-source') await command('docker', ['build', '--build-arg', `SWITCHBOARD_REVISION=${revision}`, '-t', candidateTag, source]);
        const pinned = JSON.parse(await command('docker', ['image', 'inspect', candidateTag]))[0].Id; await this.verifyImage(pinned, t); console.log(`${mode}: candidate verified`); return pinned;
      }
      override async rehearse(target: string) { console.log(`${mode}: rehearsing migrations`); await super.rehearse(target); console.log(`${mode}: migrations rehearsed`); }
      override async ready(expected?: string) { const r = await super.ready(expected); if (expected && this.failCandidate) throw Error('Synthetic startup check failure'); return r; }
    }
    const c = new Rehearsal(s);
    await c.compose(['up', '-d', '--no-build']);
    // Wait only for the disposable app's liveness before seeding its dedicated test credential.
    const deadline = Date.now() + 30_000;
    while (true) { try { if ((await fetch(`${s.appUrl}/readyz`)).ok) break; } catch {} if (Date.now() > deadline) throw Error('Initial Compose readiness failed'); await new Promise(r => setTimeout(r, 500)); }
    const appId = await c.compose(['ps', '-q', 'app']), unrelated = await c.compose(['ps', '-q', 'unrelated']);
    const job: Job = { id: `synthetic-${mode}`, state: 'queued', createdAt: Date.now(), target: { version: '99.0.0', revision, baseRevision: previousRevision, channel: 'stable', protocol: 1, notes: '', url: 'https://example.com' } };
    const control = { tokenHash: createHash('sha256').update(token).digest('hex'), paired: { instance: 'synthetic', mode: 'compose', protocol: 1, seen: Date.now() }, job };
    const seed = "const fs=require('fs');fs.writeFileSync('/data/update-control.json',process.argv[1],{mode:384});fs.mkdirSync('/data/browser-profiles/synthetic',{recursive:true});fs.writeFileSync('/data/browser-profiles/synthetic/Cookies','synthetic-profile');fs.mkdirSync('/data/plugins/synthetic',{recursive:true});fs.writeFileSync('/data/plugins/synthetic/plugin.json',JSON.stringify({id:'synthetic',name:'Synthetic',version:'1.0.0'}));fs.writeFileSync('/data/plugins/synthetic/index.ts','export default ()=>({})');";
    await command('docker', ['exec', '--user', 'node', appId, 'node', '-e', seed, JSON.stringify(control)]);
    await c.execute(job);
    const rollbackMetrics = { ...c.journal?.durations };
    assert.equal(c.journal?.phase, 'rolled-back', JSON.stringify(c.journal)); assert.equal((await c.api('ready')).build.revision, previousRevision);
    assert.equal(await c.compose(['ps', '-q', 'unrelated']), unrelated);
    const liveId = await c.compose(['ps', '-q', 'app']);
    assert.equal(await command('docker', ['exec', liveId, 'node', '-e', "console.log(require('fs').readFileSync('/data/browser-profiles/synthetic/Cookies','utf8'))"]), 'synthetic-profile');
    c.failCandidate = false;
    const next = { ...job, id: `${job.id}-success` };
    await command('docker', ['exec', '--user', 'node', liveId, 'node', '-e', "const fs=require('fs');const p='/data/update-control.json';const s=JSON.parse(fs.readFileSync(p));s.job=JSON.parse(process.argv[1]);fs.writeFileSync(p,JSON.stringify(s));", JSON.stringify(next)]);
    await c.execute(next); assert.equal(c.journal!.phase, 'succeeded'); assert.equal((await c.api('ready')).build.revision, revision);
    assert.equal(await c.compose(['ps', '-q', 'unrelated']), unrelated);
    console.log(JSON.stringify({ mode, rollback: rollbackMetrics, success: c.journal!.durations }));
    console.log(`${mode}: migration rehearsal, pre-open rollback, success, immutable metadata, persistent browser/extension data and unrelated service preservation passed`);
  }
} finally {
  for (const { file, project } of projects) await command('docker', ['compose', '-p', project, '-f', file, 'down', '-v']).catch(() => {});
  await command('docker', ['run', '--rm', '--network=none', '--user', '0:0', '--entrypoint', 'node', '--mount', `type=bind,src=${temp},dst=/fixture`, previousTag, '-e', "const fs=require('fs');function own(p){if(fs.lstatSync(p).isSymbolicLink())return;fs.chownSync(p,+process.argv[1],+process.argv[2]);if(fs.statSync(p).isDirectory())for(const n of fs.readdirSync(p))own(p+'/'+n)}own('/fixture')", String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0)]).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}
