import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { prepareRuntime } from './runtime.ts';
import { randomBytes } from 'node:crypto';
import type { Job } from '../server/updates/control.ts';
import type { Target } from '../server/updates/releases.ts';

const exec = promisify(execFile);
const UPSTREAM = 'https://github.com/tader/switchboard.git';
const IMAGE = 'ghcr.io/tader/switchboard@sha256:';
export interface Settings {
  instance: string; mode: 'checkout' | 'compose' | 'runtime'; dataDir: string; stateDir: string; appUrl: string;
  initialRelease?: string; env: Record<string, string>; token?: string;
  compose?: { files: string[]; project: string; service: string; directory: string; sourceBuild?: boolean; dataVolume?: string; stateVolume?: string; privateNetwork?: boolean };
}
export interface Journal {
  job: Job; phase: string; previous: string; target?: string; backup?: string; opened?: boolean;
  failure?: { phase: string; reason: string };
  durations: Record<string, number>; startedAt: number; outageAt?: number;
}
export function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600); fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function validateSettings(s: Settings) {
  if (!/^[\w-]{1,80}$/.test(s.instance) || !['checkout', 'compose', 'runtime'].includes(s.mode)) throw Error('Invalid instance or mode');
  for (const p of [s.dataDir, s.stateDir]) if (!path.isAbsolute(p)) throw Error('Data and updater state paths must be absolute');
  if (s.compose?.dataVolume && (s.dataDir !== '/data' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s.compose.dataVolume))) throw Error('Named-volume mode requires exact dataDir /data and an explicit volume name');
  const canonical = (p: string): string => fs.existsSync(p) ? fs.realpathSync(p) : path.join(canonical(path.dirname(p)), path.basename(p));
  const data = canonical(s.dataDir), state = canonical(s.stateDir);
  if (s.initialRelease && (state === canonical(s.initialRelease) || state.startsWith(canonical(s.initialRelease) + path.sep))) throw Error('Updater state must be outside the application source tree');
  if (data === state || data.startsWith(state + path.sep) || state.startsWith(data + path.sep)) throw Error('Updater state must be outside data and backup');
  const url = new URL(s.appUrl);
  if (url.username || url.password || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || s.mode === 'compose' && s.compose?.privateNetwork === true && url.hostname === s.compose.service || s.mode === 'runtime' && Object.values(os.networkInterfaces()).flat().some(i => i?.address === url.hostname.replace(/^\[|\]$/g, '')))))) throw Error('Use HTTPS or loopback HTTP for appUrl');
  if (s.mode !== 'compose' && (!s.initialRelease || !path.isAbsolute(s.initialRelease))) throw Error('Set initialRelease to an absolute source directory');
  if (s.mode === 'compose' && (!s.compose || !/^[a-z0-9][a-z0-9_-]*$/.test(s.compose.project) || !/^[a-zA-Z0-9_-]+$/.test(s.compose.service) || !path.isAbsolute(s.compose.directory) || !s.compose.files.length || s.compose.files.some(f => !path.isAbsolute(f)))) throw Error('Configure the fixed Compose project, service, directory and absolute files');
  for (const key of Object.keys(s.env ?? {})) if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw Error('Invalid environment key');
}
export function acquireController(s: Settings) {
  fs.mkdirSync(s.stateDir, { recursive: true, mode: 0o700 }); fs.chmodSync(s.stateDir, 0o700);
  const lease = new DatabaseSync(path.join(s.stateDir, 'controller-lease.db'));
  try { lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease(id INTEGER); BEGIN EXCLUSIVE;'); }
  catch { lease.close(); throw Error('Another updater is running'); }
  const file = path.join(s.stateDir, 'controller.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { mode: 0o600 });
  return () => { fs.rmSync(file, { force: true }); lease.close(); };
}
export async function command(file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  // Never forward subprocess output: npm/build/Compose output can contain credentials.
  try { return (await exec(file, args, { cwd, env: env ?? process.env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (e: any) { throw Error(`${path.basename(file)} ${args[0] ?? ''} failed (exit ${typeof e.code === 'number' ? e.code : 'unavailable'}); inspect configuration locally. Output withheld to protect secrets.`); }
}
export function assertTarget(t: Target) {
  if (t.protocol !== 1 || !/^[a-f0-9]{40}$/.test(t.revision) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(t.version) || !['stable', 'validated-main'].includes(t.channel)) throw Error('Invalid target');
  if (t.image && !(t.image.startsWith(IMAGE) && /^[a-f0-9]{64}$/.test(t.image.slice(IMAGE.length)))) throw Error('Invalid pinned image');
}
export function readJson<T>(file: string): T | undefined { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; } }
function assertNoExternalData(root: string, dir = root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink() && /^Singleton/.test(entry.name)) { continue; }
    if (entry.isSymbolicLink()) { const resolved = fs.realpathSync(p); if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Error('Data contains an external symbolic link; move persistent state inside dataDir before adoption'); }
    else if (entry.isDirectory()) assertNoExternalData(root, p);
  }
}
export async function assertListenAvailable(host: string, port: number) {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', () => reject(Error('The listen address or port is unavailable; stop the existing listener or choose another port'))); socket.listen(port, host, () => socket.close(() => resolve())); });
}
export class Controller {
  s: Settings;
  journal?: Journal;
  child?: import('node:child_process').ChildProcess;
  onMessage?: (message: any) => void;
  constructor(s: Settings) { validateSettings(s); this.s = s; this.journal = readJson(path.join(s.stateDir, 'journal.json')); }
  save() {
    atomic(path.join(this.s.stateDir, 'journal.json'), this.journal);
    if (this.journal && ['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required'].includes(this.journal.phase)) {
      const dir = path.join(this.s.stateDir, 'history'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      atomic(path.join(dir, `${this.journal.job.id}.json`), this.journal);
    }
  }
  async pairOwnedChild() {
    const child = this.child; if (!child?.connected) throw Error('Owned server IPC is unavailable');
    const id = -Date.now();
    const result = await new Promise<any>((resolve, reject) => {
      const listener = (m: any) => { if (m?.kind !== 'local-manager' || m.id !== id) return; clearTimeout(timer); child.off('message', listener); m.error ? reject(Error('Local pairing unavailable')) : resolve(m.result); };
      const timer = setTimeout(() => { child.off('message', listener); reject(Error('Local pairing timed out')); }, 3000);
      child.on('message', listener); child.send({ kind: 'local-manager', id, action: 'pair' });
    });
    if (typeof result.token !== 'string' || !result.token.startsWith('swbu_')) throw Error('Invalid pairing response');
    this.s.token = result.token;
  }
  async api(endpoint: string, body?: unknown): Promise<any> {
    const request = () => fetch(`${this.s.appUrl.replace(/\/$/, '')}/api/updater/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.s.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(endpoint === 'drain' ? 60_000 : 30_000), redirect: 'error' });
    let r = await request();
    if (r.status === 401 && this.s.mode === 'runtime' && this.child?.connected) { await this.pairOwnedChild(); r = await request(); }
    if (!r.ok) throw Error(`Application updater API returned ${r.status}`);
    return r.json();
  }
  async report(state: string) { if (!this.journal) return; this.journal.phase = state; this.save(); return this.api('report', { id: this.journal.job.id, state, durations: this.journal.durations }); }
  composeArgs(override?: string) { const c = this.s.compose!; return ['compose', '--project-directory', c.directory, '-p', c.project, ...c.files.flatMap(f => ['-f', f]), ...((override ?? (fs.existsSync(path.join(this.s.stateDir, 'active-compose.json')) ? path.join(this.s.stateDir, 'active-compose.json') : undefined)) ? ['-f', override ?? path.join(this.s.stateDir, 'active-compose.json')] : [])]; }
  async compose(args: string[], override?: string) { return command('docker', [...this.composeArgs(override), ...args], this.s.compose!.directory); }
  async composeInfo() {
    const info = JSON.parse(await this.compose(['config', '--format', 'json']));
    const service = info.services?.[this.s.compose!.service];
    if (!service || (service.deploy?.replicas && service.deploy.replicas !== 1) || service.scale > 1) throw Error('Managed Compose requires one service replica');
    const volumes = service.volumes ?? [];
    if (service.entrypoint || service.post_start?.length || service.pre_stop?.length || service.lifecycle) throw Error('Managed Compose requires the standard image entrypoint without lifecycle hooks');
    const standardCommand = ['node', '--disable-warning=ExperimentalWarning', 'server/main.ts'];
    if (service.command && JSON.stringify(service.command) !== JSON.stringify(standardCommand)) throw Error('Adopt the standard image command before managed upgrades');
    if (volumes.some((v: any) => v.target === '/app' || v.target?.startsWith('/app/') || v.target === '/usr/local/bin/docker-entrypoint.sh')) throw Error('Mounts must not replace managed image code or its entrypoint');
    const dataMount = (v: any) => v.target === '/data' && (this.s.compose!.dataVolume
      ? v.type === 'volume' && info.volumes?.[v.source]?.name === this.s.compose!.dataVolume
      : v.type === 'bind' && path.resolve(v.source) === this.s.dataDir);
    if (!volumes.some((v: any) => dataMount(v) && !v.read_only)) throw Error('Compose /data mount does not match the exact configured host path or named volume');
    if (volumes.some((v: any) => !v.read_only && !dataMount(v))) throw Error('All writable persistent mounts must be inside the managed /data mount');
    if (service.privileged || volumes.some((v: any) => /docker\.sock/.test(v.source ?? '')) || service.use_api_socket) throw Error('Application must not have Docker control access');
    return service;
  }
  override(image: string, gated: boolean) {
    const p = path.join(this.s.stateDir, 'active-compose.json');
    atomic(p, { services: { [this.s.compose!.service]: { image, pull_policy: 'never', environment: { SWITCHBOARD_START_GATED: gated ? '1' : '0', SWITCHBOARD_INSTALL_MODE: 'compose', SWITCHBOARD_DATA_DIR: '/data' } } } });
    return p;
  }
  current(): string { return readJson<{ release: string }>(path.join(this.s.stateDir, 'current.json'))?.release ?? this.s.initialRelease!; }
  async identifyCurrent() {
    if (this.s.mode !== 'compose') return this.current();
    await this.composeInfo();
    const ids = (await this.compose(['ps', '-q', this.s.compose!.service])).split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw Error('Start exactly one configured Compose service before enrollment');
    const rows = JSON.parse(await command('docker', ['inspect', ids[0]]));
    const image = rows[0].Image;
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error('Cannot pin previous image');
    return image;
  }
  async prepare(t: Target) {
    assertTarget(t);
    const release = path.join(this.s.stateDir, 'releases', t.revision);
    if (this.s.mode === 'compose' && !this.s.compose?.sourceBuild) {
      if (!t.image) throw Error('No published immutable image is ready');
      await command('docker', ['pull', t.image]); await this.verifyImage(t.image, t); return t.image;
    }
    if (this.s.mode === 'runtime') return prepareRuntime(t, this.s.stateDir);
    fs.mkdirSync(path.dirname(release), { recursive: true, mode: 0o700 });
    // Incomplete preparations are disposable. Never modify the operator checkout.
    if (!fs.existsSync(path.join(release, '.prepared'))) {
      fs.rmSync(release, { recursive: true, force: true });
      await command('git', ['clone', '--no-checkout', '--filter=blob:none', UPSTREAM, release]);
      await command('git', ['checkout', '--detach', t.revision], release);
      if (await command('git', ['rev-parse', 'HEAD'], release) !== t.revision) throw Error('Source revision mismatch');
      const pkg = JSON.parse(fs.readFileSync(path.join(release, 'package.json'), 'utf8'));
      if (pkg.managedUpgradeProtocol !== 1) throw Error('Target does not implement managed startup');
      const version = pkg.version;
      if (version !== t.version) throw Error('Source version mismatch');
      atomic(path.join(release, 'build-info.json'), { version, revision: t.revision });
      if (this.s.mode === 'checkout') {
        await command('npm', ['ci'], release); await command('npm', ['ci', '--prefix', 'web'], release); await command('npm', ['run', 'build', '--prefix', 'web'], release);
      } else await command('docker', ['build', '--build-arg', `SWITCHBOARD_REVISION=${t.revision}`, '--tag', `switchboard-managed:${t.revision}`, release]);
      fs.writeFileSync(path.join(release, '.prepared'), '', { mode: 0o600 });
    }
    if (this.s.mode === 'checkout') return release;
    const rows = JSON.parse(await command('docker', ['image', 'inspect', `switchboard-managed:${t.revision}`])); await this.verifyImage(rows[0].Id, t); return rows[0].Id as string;
  }
  async verifyImage(image: string, t: Target) {
    const script = "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));const b=JSON.parse(fs.readFileSync('build-info.json'));if(p.managedUpgradeProtocol!==1||b.revision!==process.argv[1]||b.version!==process.argv[2])process.exit(1)";
    await command('docker', ['run', '--rm', '--network=none', '--entrypoint', 'node', image, '-e', script, t.revision, t.version]);
  }
  async rehearse(target: string) {
    const dir = path.join(this.s.stateDir, 'rehearsal'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { mode: 0o700 });
    if (this.s.mode === 'compose') await this.dataHelper('rehearse', dir, this.journal!.previous);
    else {
      const db = new DatabaseSync(path.join(this.s.dataDir, 'switchboard.db'), { readOnly: true });
      try { await backup(db, path.join(dir, 'switchboard.db')); } finally { db.close(); }
    }
    // Only migrations run: no main.ts, extension loading, networking or credential decryption.
    const script = "import('./server/db.ts').then(m=>{m.initDb();m.db.close()})";
    try {
      if (this.s.mode !== 'compose') await command(this.s.mode === 'runtime' ? path.join(target, 'bin/node') : process.execPath, ['--input-type=module', '-e', script], target, { ...process.env, SWITCHBOARD_DATA_DIR: dir });
      else await command('docker', ['run', '--rm', '--network=none', '--entrypoint', 'node', '--mount', this.s.compose?.stateVolume ? `type=volume,src=${this.s.compose.stateVolume},dst=/managed-state` : `type=bind,src=${fs.realpathSync(dir)},dst=/rehearsal`, '-e', this.s.compose?.stateVolume ? 'SWITCHBOARD_DATA_DIR=/managed-state/rehearsal' : 'SWITCHBOARD_DATA_DIR=/rehearsal', target, '--input-type=module', '-e', script]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  async stop() {
    if (this.s.mode === 'compose') {
      const override = fs.existsSync(path.join(this.s.stateDir, 'active-compose.json')) ? path.join(this.s.stateDir, 'active-compose.json') : undefined;
      await this.compose(['stop', '-t', '45', this.s.compose!.service], override);
      const ids = await this.compose(['ps', '--status', 'running', '-q', this.s.compose!.service], override); if (ids) throw Error('Old service is still running');
    } else {
      const child = readJson<{ pid: number; started?: string }>(path.join(this.s.stateDir, 'child.json'));
      let lock = readJson<{ host: string; pid: number }>(path.join(this.s.dataDir, '.server-lock'));
      if (!lock && this.childAlive()) {
        const until = Date.now() + 2000;
        while (!lock && Date.now() < until) { await new Promise(r => setTimeout(r, 100)); lock = readJson(path.join(this.s.dataDir, '.server-lock')); }
        if (!lock && this.childAlive()) throw Error('Managed child is alive without a data lock; refusing backup or concurrent start');
      }
      if (lock && !this.childAlive()) {
        let alive = true; try { process.kill(lock.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; else throw e; }
        if (!alive && lock.host === os.hostname()) { fs.rmSync(path.join(this.s.dataDir, '.server-lock'), { force: true }); lock = undefined; }
      }
      if (lock) {
        if (lock.host !== os.hostname() || !Number.isSafeInteger(lock.pid) || lock.pid < 2) throw Error('Cannot stop a foreign instance');
        // Only the managed launcher's own child may be stopped.
        if (child?.pid !== lock.pid) throw Error('Stop the unmanaged server manually before adoption');
        if (this.childAlive()) {
          const started = await command('ps', ['-p', String(lock.pid), '-o', 'lstart=']);
          if (!child?.started || started !== child.started) throw Error('Managed process identity is uncertain; refusing to signal it');
        }
        try { process.kill(lock.pid, 'SIGTERM'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
        const end = Date.now() + 45_000;
        while (Date.now() < end) { try { process.kill(lock.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') break; throw e; } await new Promise(r => setTimeout(r, 100)); }
        try { process.kill(lock.pid, 0); throw Error('Server did not stop; refusing backup or concurrent start'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
      }
    }
    if (this.s.mode === 'compose') await this.dataHelper('unlock', this.s.stateDir, this.journal?.previous ?? await this.identifyStoppedImage());
    else fs.rmSync(path.join(this.s.dataDir, '.server-lock'), { force: true });
  }
  async identifyStoppedImage() {
    const ids = await this.compose(['ps', '-a', '-q', this.s.compose!.service]);
    const rows = JSON.parse(await command('docker', ['inspect', ids])); return rows[0].Image as string;
  }
  childAlive() {
    const child = readJson<{ pid: number }>(path.join(this.s.stateDir, 'child.json'));
    if (!child) return false;
    try { process.kill(child.pid, 0); return true; } catch (e: any) { if (e.code === 'ESRCH') return false; throw e; }
  }
  async start(release: string, gated = true) {
    if (this.s.mode === 'compose') await this.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', this.s.compose!.service], this.override(release, gated));
    else {
      if (fs.existsSync(path.join(this.s.dataDir, '.server-lock'))) throw Error('Server lock is still held');
      if (this.s.mode === 'runtime') await assertListenAvailable(this.s.env.SWITCHBOARD_HOST ?? '127.0.0.1', Number(this.s.env.SWITCHBOARD_PORT ?? (new URL(this.s.appUrl).port || 8770)));
      const child = spawn(this.s.mode === 'runtime' ? path.join(release, 'bin/node') : process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], { cwd: release, env: { ...process.env, ...this.s.env, SWITCHBOARD_DATA_DIR: this.s.dataDir, SWITCHBOARD_START_GATED: gated ? '1' : '0', SWITCHBOARD_INSTALL_MODE: this.s.mode }, detached: this.s.mode !== 'runtime', stdio: this.s.mode === 'runtime' ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
      this.child = child; child.on('message', message => this.onMessage?.(message));
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      atomic(path.join(this.s.stateDir, 'child.json'), { pid: child.pid }); child.unref();
      const started = await command('ps', ['-p', String(child.pid), '-o', 'lstart=']);
      atomic(path.join(this.s.stateDir, 'child.json'), { pid: child.pid, started });
    }
  }
  async ready(revision?: string) {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      try { const r = await this.api('ready'); if (r.ready && (!revision || r.build.revision === revision)) return r; } catch { /* startup in progress */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw Error('Server failed readiness before opening');
  }
  async dataHelper(operation: 'rehearse' | 'snapshot' | 'restore' | 'unlock' | 'identity', directory: string, image: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image) && !/^ghcr\.io\/tader\/switchboard@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Helper requires a fixed immutable image');
    // Fixed code, paths and operations. No application env, networking, shell or Docker socket.
    const script = `
      const fs=require('node:fs'),path=require('node:path');
      const [op,uid,gid,transfer]=process.argv.slice(1);
      const check=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink()&&/^Singleton/.test(e.name))continue;if(e.isSymbolicLink()){const r=fs.realpathSync(p);if(!r.startsWith('/managed-data/'))throw Error('External persistent link');}else if(e.isDirectory())check(p);}};
      const copy=(src,dst)=>{
        const st=fs.lstatSync(src);if(/^Singleton/.test(path.basename(src)))return;
        if(st.isSymbolicLink()){fs.symlinkSync(fs.readlinkSync(src),dst);return;}
        if(st.isDirectory()){fs.mkdirSync(dst,{recursive:true,mode:448});for(const n of fs.readdirSync(src))copy(path.join(src,n),path.join(dst,n));return;}
        if(!st.isFile())throw Error('Unsupported persistent entry');
        const input=fs.openSync(src,'r'),output=fs.openSync(dst,'w',384|(st.mode&64));
        try{const b=Buffer.alloc(1048576);let count;while((count=fs.readSync(input,b,0,b.length,null))>0){let offset=0;while(offset<count)offset+=fs.writeSync(output,b,offset,count-offset);}fs.fsyncSync(output);}finally{fs.closeSync(input);fs.closeSync(output);}
        fs.utimesSync(dst,st.atime,st.mtime);
      };
      const own=(p)=>{if(fs.lstatSync(p).isSymbolicLink())return;fs.chownSync(p,+uid,+gid);if(fs.statSync(p).isDirectory()){fs.chmodSync(p,448);for(const n of fs.readdirSync(p))own(path.join(p,n));}else fs.chmodSync(p,384|(fs.statSync(p).mode&64));};
      (async()=>{
        if(op==='identity')console.log(fs.readFileSync('/managed-data/update-instance-id','utf8'));
        if(op==='unlock')fs.rmSync('/managed-data/.server-lock',{force:true});
        if(op==='snapshot'){check('/managed-data');for(const n of fs.readdirSync('/managed-data'))copy('/managed-data/'+n,'/transfer/'+n);own('/transfer');}
        if(op==='restore'){for(const n of fs.readdirSync('/managed-data'))fs.rmSync('/managed-data/'+n,{recursive:true,force:true});for(const n of fs.readdirSync('/transfer'))copy('/transfer/'+n,'/managed-data/'+n);fs.rmSync('/managed-data/.server-lock',{force:true});const p='/managed-data/update-control.json';if(fs.existsSync(p)){const s=JSON.parse(fs.readFileSync(p));if(s.job)s.job.state='rolled-back';fs.writeFileSync(p,JSON.stringify(s),{mode:384});}}
        if(op==='rehearse'){const {DatabaseSync,backup}=require('node:sqlite');const db=new DatabaseSync('/managed-data/switchboard.db',{readOnly:true});try{await backup(db,'/transfer/switchboard.db');}finally{db.close();}own('/transfer');}
      })().catch(error=>{console.error('Data helper failed',error.code??'unknown',error.syscall??'unknown');process.exit(1);});`;
    const stateVolume = this.s.compose!.stateVolume;
    const relative = path.relative(this.s.stateDir, directory);
    if (stateVolume && (relative.startsWith('..') || path.isAbsolute(relative))) throw Error('Transfer must be inside updater state');
    const helperScript = script.replaceAll("'/transfer/'", "(transfer+'/')").replaceAll("'/transfer/switchboard.db'", "(transfer+'/switchboard.db')").replaceAll("'/transfer'", 'transfer');
    return command('docker', ['run', '--rm', '--network=none', '--read-only', '--user', '0:0', '--entrypoint', 'node', '--mount', `type=${this.s.compose!.dataVolume ? 'volume' : 'bind'},src=${this.s.compose!.dataVolume ?? fs.realpathSync(this.s.dataDir)},dst=/managed-data${['snapshot', 'rehearse', 'identity'].includes(operation) ? ',readonly' : ''}`, '--mount', stateVolume ? `type=volume,src=${stateVolume},dst=/state${operation === 'restore' ? ',readonly' : ''}` : `type=bind,src=${fs.realpathSync(directory)},dst=/transfer${operation === 'restore' ? ',readonly' : ''}`, image, '-e', helperScript, operation, String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0), stateVolume ? path.posix.join('/state', relative) : '/transfer']);
  }
  async snapshot() {
    if (this.s.mode !== 'compose') assertNoExternalData(this.s.dataDir);
    const dir = path.join(this.s.stateDir, 'backups', this.journal!.job.id); fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.rmSync(dir, { recursive: true, force: true }); if (this.s.mode === 'compose') { fs.mkdirSync(dir, { mode: 0o700 }); await this.dataHelper('snapshot', dir, this.journal!.previous); }
    else fs.cpSync(this.s.dataDir, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: p => !/^Singleton/.test(path.basename(p)) });
    // Restrict every backup entry, even if original data had permissive modes.
    const restrict = (p: string) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600 | (st.mode & 0o100)); if (st.isDirectory()) for (const name of fs.readdirSync(p)) restrict(path.join(p, name)); }; restrict(dir);
    fs.rmSync(path.join(dir, '.server-lock'), { force: true });
    const sync = (p: string) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; if (st.isDirectory()) for (const n of fs.readdirSync(p)) sync(path.join(p, n)); const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }; sync(dir);
    this.journal!.backup = dir; this.save();
  }
  async rollback() {
    const j = this.journal!;
    if (j.opened) { await this.report('recovery-required').catch(() => {}); return; }
    try {
      await this.stop();
      if (j.backup) {
        // Copy before replacing data; preserve failed candidate data for explicit recovery.
        const failed = path.join(this.s.stateDir, `failed-data-${j.job.id}`);
        if (this.s.mode === 'compose') {
          if (!fs.existsSync(failed)) { fs.mkdirSync(failed, { mode: 0o700 }); await this.dataHelper('snapshot', failed, j.previous); }
          await this.dataHelper('restore', j.backup, j.previous);
        } else {
          const restore = path.join(this.s.stateDir, 'restore'); fs.rmSync(restore, { recursive: true, force: true }); fs.cpSync(j.backup, restore, { recursive: true, verbatimSymlinks: true });
          if (fs.existsSync(this.s.dataDir)) { if (fs.existsSync(failed)) fs.rmSync(this.s.dataDir, { recursive: true }); else { fs.cpSync(this.s.dataDir, failed, { recursive: true, verbatimSymlinks: true }); fs.rmSync(this.s.dataDir, { recursive: true }); } }
          fs.cpSync(restore, this.s.dataDir, { recursive: true, verbatimSymlinks: true }); fs.rmSync(restore, { recursive: true });
        }
      }
      await this.start(j.previous); await this.ready();
      // Rollback startup also crosses an external-side-effect boundary.
      j.opened = true; this.save(); await this.api('open', {});
      if (this.s.mode === 'compose') this.override(j.previous, false);
      atomic(path.join(this.s.stateDir, 'current.json'), { release: j.previous });
      j.durations.total = Date.now() - j.startedAt; if (j.outageAt) j.durations.outage = Date.now() - j.outageAt;
      await this.report('rolled-back');
    } catch (error) { j.failure = { phase: 'rollback', reason: error instanceof Error ? error.message.slice(0, 500) : 'Rollback failed' }; this.save(); await this.report('recovery-required').catch(() => {}); }
  }
  async verifyInstance(previous?: string) {
    const poll = await this.api('poll', {});
    const expected = this.s.mode === 'compose'
      ? await this.dataHelper('identity', this.s.stateDir, previous ?? await this.identifyCurrent())
      : fs.readFileSync(path.join(this.s.dataDir, 'update-instance-id'), 'utf8').trim();
    if (poll.protocol !== 1 || poll.instance !== this.s.instance || poll.dataIdentity !== expected || poll.build?.mode !== this.s.mode) throw Error('Configured data directory, deployment mode or instance does not match the enrolled application');
    return poll;
  }
  async execute(job: Job) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)) throw Error('Invalid job identity');
    assertTarget(job.target);
    if (this.journal?.phase === 'recovery-required') throw Error('Owner recovery is required');
    if (this.journal && !['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required'].includes(this.journal.phase)) throw Error('Recover the pending journal first');
    const previous = await this.identifyCurrent(); await this.verifyInstance(previous);
    this.journal = { job, previous, phase: 'preparing', startedAt: Date.now(), durations: {} }; this.save();
    let cutover = false;
    try {
      await this.report('preparing');
      const start = Date.now(); this.journal.target = await this.prepare(job.target); this.save();
      await this.rehearse(this.journal.target); this.journal.durations.preparation = Date.now() - start;
      const poll = await this.api('poll', {}); if (poll.build?.revision !== job.target.baseRevision || poll.build.custom) throw Error('Running build changed during preparation'); if (poll.job?.id !== job.id) throw Error('Job changed');
      if (poll.job.cancel) { await this.report('cancelled'); return; }
      this.journal.outageAt = Date.now(); const claim = await this.report('draining'); if (claim?.cancel) { await this.report('cancelled'); return; } cutover = true;
      await this.api('drain', {}); await this.stop(); await this.report('snapshot').catch(() => {});
      const snapshotAt = Date.now(); await this.snapshot(); this.journal.durations.backup = Date.now() - snapshotAt;
      this.journal.phase = 'starting'; this.save();
      await this.start(this.journal.target); await this.ready(job.target.revision);
      // Persist BEFORE asking the candidate to load extensions or accept requests.
      this.journal.opened = true; this.journal.phase = 'opening'; this.save();
      await this.api('report', { id: job.id, state: 'opening' }); await this.api('open', {});
      if (this.s.mode === 'compose') this.override(this.journal.target, false);
      atomic(path.join(this.s.stateDir, 'current.json'), { release: this.journal.target });
      this.journal.durations.outage = Date.now() - this.journal.outageAt;
      this.journal.durations.total = Date.now() - this.journal.startedAt;
      atomic(path.join(this.s.stateDir, 'last-success.json'), { jobId: job.id, previous: this.journal.previous, release: this.journal.target, backup: this.journal.backup, durations: this.journal.durations, completedAt: Date.now() });
      await this.report('succeeded');
    } catch (error) {
      this.journal.failure = { phase: this.journal.phase, reason: error instanceof Error ? error.message.slice(0, 500) : 'Controller operation failed' }; this.save();
      if (cutover || this.journal.opened) await this.rollback(); else await this.report('failed').catch(() => {});
    }
  }
  async recover() {
    const j = this.journal; if (!j || ['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required'].includes(j.phase)) return;
    if (j.opened) { j.phase = 'recovery-required'; this.save(); await this.report('recovery-required').catch(() => {}); return; }
    if (j.phase === 'draining') {
      try { const poll = await this.api('poll', {}); if (poll.job?.id === j.job.id && ['preparing', 'queued'].includes(poll.job.state)) { await this.report(poll.job.cancel ? 'cancelled' : 'failed'); return; } } catch { /* A stopped application needs pre-open recovery. */ }
    }
    if (j.phase === 'preparing') { await this.report('failed').catch(() => {}); return; }
    await this.rollback();
  }
}
