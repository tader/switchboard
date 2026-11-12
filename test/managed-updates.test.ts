import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Hono } from 'hono';
import { runningBuild, eligible, selectTarget, bindTarget, imageDigest, type Target } from '../server/updates/releases.ts';
import { Controller, acquireController, assertTarget, atomic, validateSettings, type Settings, type Journal } from '../updater/engine.ts';
import { lockInstance } from '../server/updates/instance-lock.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-updates-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const baseRevision = 'a'.repeat(40), revision = 'b'.repeat(40);
const target: Target = { version: '1.1.0', baseRevision, revision, protocol: 1, channel: 'stable', notes: 'Synthetic release', url: 'https://example.com/release' };
const build = { version: '1.0.0', revision: baseRevision, mode: 'checkout' as const, custom: false };
function fetcher(pkg: Record<string, unknown> = { version: target.version, managedUpgradeProtocol: 1 }, overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const routes: Record<string, unknown> = {
      'releases/latest': { tag_name: `v${target.version}`, body: 'Synthetic release' },
      [`commits/v${target.version}`]: { sha: revision }, 'commits/main': { sha: revision },
      [`contents/package.json?ref=${revision}`]: { content: Buffer.from(JSON.stringify(pkg)).toString('base64') },
      [`actions/workflows/check.yml/runs?head_sha=${revision}&event=push&status=success&per_page=10`]: { workflow_runs: [{ head_sha: revision, head_branch: 'main', conclusion: 'success' }] },
      [`compare/${baseRevision}...${revision}`]: { status: 'ahead', base_commit: { sha: baseRevision }, merge_base_commit: { sha: baseRevision } }, ...overrides,
    };
    const key = url.split('/repos/tader/switchboard/')[1];
    if (!(key in routes)) throw Error('Unexpected external request');
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}
test('release selection pins source, requires protocol and validates exact running ancestry', async () => {
  const found = await bindTarget(build, await selectTarget('stable', 'checkout', fetcher()), fetcher());
  assert.equal(eligible(build, found), true);
  assert.equal(eligible({ ...build, custom: true }, found), false);
  assert.equal(eligible({ ...build, version: '2.0.0' }, found), false);
  assert.equal(eligible({ ...build, revision: 'c'.repeat(40) }, found), false);
  assert.equal(eligible(build, { ...found, protocol: 0 as any }), false);
  await assert.rejects(selectTarget('stable', 'checkout', fetcher({ version: target.version })), /gated managed startup/);
  await assert.rejects(selectTarget('stable', 'checkout', fetcher({ version: '1.2.0', managedUpgradeProtocol: 1 })), /version/);
  await assert.rejects(bindTarget(build, target, fetcher(undefined, { [`compare/${baseRevision}...${revision}`]: { status: 'behind' } })), /descendant/);
  await assert.rejects(selectTarget('stable', 'checkout', (async () => { throw Error('network'); }) as typeof fetch));
});
test('validated main requires successful exact CI and source Compose never requests a registry', async () => {
  const found = await selectTarget('validated-main', 'compose', fetcher(), true);
  assert.equal(found.image, undefined); assert.equal(found.revision, revision);
  await assert.rejects(selectTarget('validated-main', 'checkout', fetcher(undefined, { [`actions/workflows/check.yml/runs?head_sha=${revision}&event=push&status=success&per_page=10`]: { workflow_runs: [] } })), /validation/);
  await assert.rejects(selectTarget('stable', 'compose', fetcher()), /Unexpected external/);
});
test('published image must exist and is pinned to digest', async () => {
  let n = 0;
  const f = (async () => ++n === 1 ? Response.json({ token: 'synthetic-registry-token' }) : new Response('{}', { headers: { 'docker-content-digest': `sha256:${'c'.repeat(64)}` } })) as typeof fetch;
  assert.equal(await imageDigest(revision, f), `ghcr.io/tader/switchboard@sha256:${'c'.repeat(64)}`);
  await assert.rejects(imageDigest(revision, (async () => Response.json({ token: 'synthetic' })) as typeof fetch), /not ready/);
});
function settings(name: string): Settings {
  const stateDir = path.join(tmp, name), dataDir = `${stateDir}-data`; fs.mkdirSync(stateDir); fs.mkdirSync(dataDir);
  return { instance: name, stateDir, dataDir, initialRelease: '/synthetic/previous', mode: 'checkout', appUrl: 'http://127.0.0.1:8770', env: {} };
}
test('settings and target reject browser-controlled commands and overlapping state', () => {
  const s = settings('settings');
  assert.throws(() => validateSettings({ ...s, stateDir: path.join(s.dataDir, 'journal') }), /outside/);
  assert.throws(() => validateSettings({ ...s, appUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => assertTarget({ ...target, revision: '--upload-pack=evil' }), /Invalid/);
  assert.throws(() => assertTarget({ ...target, image: 'example.com/arbitrary:latest' }), /image/);
});
test('one controller and one server hold independently released process locks', () => {
  const s = settings('locking'); const unlock = acquireController(s);
  assert.throws(() => acquireController(s), /running/); unlock(); acquireController(s)();
  const unlockServer = lockInstance(s.dataDir);
  assert.throws(() => lockInstance(s.dataDir), /Another server/); unlockServer(); lockInstance(s.dataDir)();
  const code = `import {lockInstance} from ${JSON.stringify(path.resolve('server/updates/instance-lock.ts'))};lockInstance(process.argv[1]);process.kill(process.pid,'SIGKILL');`;
  spawnSync(process.execPath, ['--input-type=module', '-e', code, s.dataDir], { stdio: 'ignore' });
  lockInstance(s.dataDir)();
});
class FakeController extends Controller {
  events: string[] = []; cancel = false; failReady = false; failOpen = false; failedRestore = false;
  override async verifyInstance() { return {}; }
  override async identifyCurrent() { return '/synthetic/previous'; }
  override async prepare() { this.events.push('prepare'); return '/synthetic/target'; }
  override async rehearse() { this.events.push('rehearse'); }
  override async api(endpoint: string, body?: any): Promise<any> {
    this.events.push(endpoint === 'report' ? `report:${body.state}` : endpoint);
    if (endpoint === 'poll') return { build, job: { ...this.journal!.job, cancel: this.cancel } };
    if (endpoint === 'open' && this.failOpen) throw Error('open failed');
    return {};
  }
  override async stop() { this.events.push('stop'); if (this.failedRestore) throw Error('stop failed'); }
  override async start(release: string) { this.events.push(`start:${release}`); }
  override async ready(expected?: string) { this.events.push('ready'); if (expected && this.failReady) throw Error('startup failed'); return {}; }
}
const job = () => ({ id: 'synthetic-job', target, state: 'queued', createdAt: Date.now() });
test('prepare and rehearse precede outage; cancellation never stops or deploys', async () => {
  const c = new FakeController(settings('cancel')); c.cancel = true; await c.execute(job());
  assert.deepEqual(c.events, ['report:preparing', 'prepare', 'rehearse', 'poll', 'report:cancelled']);
  assert.equal(c.journal!.phase, 'cancelled');
});
test('cancellation accepted while claiming preparation skips all preparation work', async () => {
  const c = new FakeController(settings('preparation-claim-cancel'));
  const api = c.api.bind(c);
  c.api = async (endpoint, body) => { const result = await api(endpoint, body); return endpoint === 'report' && body.state === 'preparing' ? { cancel: true } : result; };
  await c.execute(job());
  assert.deepEqual(c.events, ['report:preparing', 'report:cancelled']);
  assert.equal(c.journal!.phase, 'cancelled');
});
test('startup failure restores full owner-only snapshot before rollback opening', async () => {
  const c = new FakeController(settings('rollback')); c.failReady = true;
  fs.mkdirSync(path.join(c.s.dataDir, 'browser-profiles')); fs.writeFileSync(path.join(c.s.dataDir, 'browser-profiles', 'synthetic'), 'profile bytes');
  fs.writeFileSync(path.join(c.s.dataDir, 'secret.key'), 'synthetic-key');
  await c.execute(job());
  assert.equal(c.journal!.phase, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(c.journal!.backup!, 'secret.key'), 'utf8'), 'synthetic-key');
  assert.equal(fs.statSync(c.journal!.backup!).mode & 0o777, 0o700);
  assert.ok(c.events.indexOf('prepare') < c.events.indexOf('drain'));
  assert.ok(c.events.includes('start:/synthetic/previous'));
  assert.ok(fs.existsSync(path.join(c.s.stateDir, 'failed-data-synthetic-job', 'browser-profiles', 'synthetic')));
});
test('an uncertain old-process stop requires recovery without snapshot or candidate start', async () => {
  const c = new FakeController(settings('stop-failure')); c.failedRestore = true;
  fs.writeFileSync(path.join(c.s.dataDir, 'synthetic-state'), 'unchanged');
  await c.execute(job());
  assert.equal(c.journal!.phase, 'recovery-required');
  assert.equal(c.journal!.backup, undefined);
  assert.ok(!c.events.some(e => e.startsWith('start:')));
  assert.equal(fs.readFileSync(path.join(c.s.dataDir, 'synthetic-state'), 'utf8'), 'unchanged');
});
test('after opening intent is durable, failure never restores data', async () => {
  const c = new FakeController(settings('post-open')); c.failOpen = true; await c.execute(job());
  assert.equal(c.journal!.phase, 'recovery-required'); assert.equal(c.journal!.opened, true);
  assert.equal(c.events.filter(e => e === 'stop').length, 1);
  assert.ok(!c.events.includes('start:/synthetic/previous'));
});
test('updater death recovers pre-open only, with no deployment replay', async () => {
  const s = settings('death'); const c = new FakeController(s);
  const journal: Journal = { job: job(), phase: 'starting', previous: '/synthetic/previous', target: '/synthetic/target', durations: {}, startedAt: Date.now() };
  atomic(path.join(s.stateDir, 'journal.json'), journal);
  const recovered = new FakeController(s); await recovered.recover();
  assert.equal(recovered.journal!.phase, 'rolled-back'); assert.ok(!recovered.events.includes('prepare')); assert.ok(!recovered.events.includes('start:/synthetic/target'));
  journal.opened = true; atomic(path.join(s.stateDir, 'journal.json'), journal);
  const opened = new FakeController(s); await opened.recover(); assert.equal(opened.journal!.phase, 'recovery-required'); assert.ok(!opened.events.includes('stop'));
});

// Isolated in-process API, using real session/token lookup and encryption/database setup.
test('admin-only jobs and one-time narrow enrollment reject scoped, MCP, peer and updater credentials', async () => {
  const dir = path.join(tmp, 'api'); fs.mkdirSync(dir);
  const { config } = await import('../server/config.ts'); config.dataDir = dir;
  const { initKey } = await import('../server/crypto.ts'); initKey();
  const database = await import('../server/db.ts'); database.initDb();
  const { createUser, createToken } = await import('../server/users.ts');
  const { updates, updaterApi, ensureUpdateIdentity } = await import('../server/updates/control.ts');
  ensureUpdateIdentity();
  const app = new Hono(); app.onError((e: any, c) => c.json({ error: e.message }, e.status ?? 500)); app.route('/admin', updates); app.route('/updater', updaterApi);
  const admin = createUser('synthetic-admin', 'admin'), user = createUser('synthetic-user', 'user');
  const full = createToken(admin.id, 'synthetic-admin', null).secret;
  const scoped = createToken(admin.id, 'synthetic-scoped', []).secret;
  const mcp = createToken(admin.id, 'synthetic-mcp', null, null, { audience: 'mcp' }).secret;
  const normal = createToken(user.id, 'synthetic-user', null).secret;
  const req = (url: string, token?: string, body?: unknown, method = 'POST') => app.request(url, { method, headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const token of [undefined, scoped, mcp, normal, 'synthetic-peer-token']) assert.notEqual((await req('/admin/enrollment', token)).status, 200);
  assert.equal((await req('/updater/poll', full, {})).status, 401);
  const enrollment = await (await req('/admin/enrollment', full)).json() as any;
  const body = { code: enrollment.code, instance: 'synthetic', mode: 'checkout', protocol: 1 };
  const response = await req('/updater/enroll', undefined, body); assert.equal(response.status, 200);
  const { token } = await response.json() as any;
  assert.equal((await req('/updater/enroll', undefined, body)).status, 401);
  assert.equal((await req('/updater/poll', token, {})).status, 200);
  assert.equal((await req('/admin/enrollment', token)).status, 401);
  assert.ok(!fs.readFileSync(path.join(dir, 'update-control.json'), 'utf8').includes(token));
  const { config: currentConfig } = await import('../server/config.ts');
  const originalRoot = currentConfig.root;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: build.version }));
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: build.version, revision: baseRevision }));
  currentConfig.root = dir;
  const stateFile = path.join(dir, 'update-control.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); atomic(stateFile, { ...state, checkedAt: Date.now(), target });
  assert.equal((await req('/admin/jobs', full)).status, 202);
  assert.equal((await req('/admin/jobs', full)).status, 409);
  assert.equal((await req('/admin/jobs/cancel', full)).status, 200);
  const queued = (await (await req('/updater/poll', token, {})).json() as any).job;
  assert.equal((await (await req('/updater/report', token, { id: queued.id, state: 'draining' })).json() as any).cancel, true);
  assert.equal((await (await req('/updater/poll', token, {})).json() as any).job.state, 'cancelled');
  await req('/updater/report', token, { id: queued.id, state: 'cancelled' });
  assert.equal((await (await req('/updater/report', token, { id: queued.id, state: 'preparing' })).json() as any).cancel, true);
  assert.equal((await (await req('/updater/poll', token, {})).json() as any).job.state, 'cancelled');
  await req('/updater/report', token, { id: queued.id, state: 'failed', reason: 'preflight' });
  assert.equal((await (await req('/updater/poll', token, {})).json() as any).job.state, 'cancelled');
  assert.equal((await req('/admin/jobs', full)).status, 202);
  const next = (await (await req('/updater/poll', token, {})).json() as any).job;
  await req('/updater/report', token, { id: next.id, state: 'preparing' });
  await req('/admin/jobs/cancel', full);
  assert.equal((await (await req('/updater/poll', token, {})).json() as any).job.state, 'preparing');
  assert.equal((await (await req('/updater/report', token, { id: next.id, state: 'draining' })).json() as any).cancel, true);
  await req('/updater/report', token, { id: next.id, state: 'cancelled' });
  assert.equal((await req('/admin/jobs', full)).status, 202);
  const failed = (await (await req('/updater/poll', token, {})).json() as any).job;
  await req('/updater/report', token, { id: failed.id, state: 'failed', reason: 'preflight', error: 'synthetic-secret' });
  const failure = (await (await req('/updater/poll', token, {})).json() as any).job;
  assert.match(failure.error, /validate the installation/); assert.ok(!failure.error.includes('synthetic-secret'));

  const frozen = runningBuild();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  assert.equal(runningBuild().version, frozen.version); assert.equal(runningBuild().custom, true);
  currentConfig.root = originalRoot;
  await req('/admin/enrollment', full, undefined, 'DELETE'); assert.equal((await req('/updater/poll', token, {})).status, 401);
  database.db.close();
});


test('old server rejects a future database schema before any normal startup', () => {
  const s = settings('future-schema');
  const script = `const {DatabaseSync}=await import('node:sqlite');const d=new DatabaseSync(process.env.SWITCHBOARD_DATA_DIR+'/switchboard.db');d.exec('PRAGMA user_version=99999');d.close();const m=await import(${JSON.stringify(path.resolve('server/db.ts'))});m.initDb();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SWITCHBOARD_DATA_DIR: s.dataDir }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /schema is newer/);
});
