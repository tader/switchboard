import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import type { User } from '../server/users.ts';
import type { PluginManifest } from '../server/plugins/api.ts';
import { installFixturePlugins } from './plugin-fixtures.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-installer-'));
process.env.SWITCHBOARD_DATA_DIR = path.join(tmp, 'data');
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
const realFetch = globalThis.fetch;
const catalogUrl = 'https://api.github.com/repos/tader/switchboard-plugins/contents/plugins.json?ref=main';
interface Fixture { id: string; version?: string; dependencies?: string[]; dependencyVersions?: Record<string, string>; broken?: boolean; atRoot?: boolean }
interface Repo { refs: Map<string, string>; files: Map<string, Buffer>; allowed?: string[]; redirect?: string }
const repos = new Map<string, Repo>();
const seen: { url: string; authorization: string | null }[] = [];
let counter = 0;
let catalog: unknown = { schemaVersion: 1, plugins: [] };
let catalogStatus = 200;
let alice: User;
let bob: User;
let aliceToken: string;
let bobToken: string;

async function fixture(repo: string, fixtures: Fixture[], ref = 'HEAD', allowed?: string[]) {
  const sha = (++counter).toString(16).padStart(40, '0');
  const root = path.join(tmp, sha, 'archive-root');
  for (const p of fixtures) {
    const dir = p.atRoot ? root : path.join(root, 'plugins', p.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: p.id, name: p.id, version: p.version ?? '1.0.0', dependencies: p.dependencies, dependencyVersions: p.dependencyVersions }));
    fs.writeFileSync(path.join(dir, 'index.ts'), p.broken ? 'export default () => { throw new Error("fixture activation failure"); };' : 'export default () => ({ exports: { value: 1 } });');
  }
  const out = path.join(tmp, `${sha}.tgz`);
  await tar.c({ gzip: true, file: out, cwd: path.dirname(root) }, ['archive-root']);
  const spec = repos.get(repo) ?? { refs: new Map(), files: new Map(), allowed };
  spec.refs.set(ref, sha);
  spec.refs.set(sha, sha);
  spec.files.set(sha, fs.readFileSync(out));
  repos.set(repo, spec);
  return sha;
}

before(async () => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    seen.push({ url, authorization });
    if (url === catalogUrl) return Response.json(catalogStatus === 200 ? catalog : { error: 'offline' }, { status: catalogStatus });
    if (url === 'https://api.github.com/user') return Response.json({ id: authorization, login: authorization?.slice(7), avatar_url: '' });
    const m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(commits|tarball)\/(.+)$/);
    if (m) {
      const spec = repos.get(m[1]);
      if (!spec) return new Response('', { status: 404 });
      if (spec.allowed && !spec.allowed.includes(authorization ?? '')) return new Response('', { status: authorization ? 401 : 404 });
      const sha = spec.refs.get(decodeURIComponent(m[3]));
      if (!sha) return new Response('', { status: 404 });
      if (m[2] === 'commits') return new Response(sha);
      if (spec.redirect) return new Response(null, { status: 302, headers: { location: `${spec.redirect}/${m[1]}/${sha}` } });
      return new Response(new Uint8Array(spec.files.get(sha)!));
    }
    const cd = url.match(/^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/([a-f0-9]+)$/);
    if (cd) return new Response(new Uint8Array(repos.get(cd[1])!.files.get(cd[2])!));
    throw new Error(`Unexpected network request: ${url}`);
  }) as typeof fetch;
  const { initKey } = await import('../server/crypto.ts');
  const { initDb } = await import('../server/db.ts');
  initKey(); initDb();
  const { plugins } = await import('../server/plugins/manager.ts');
  installFixturePlugins(process.env.SWITCHBOARD_DATA_DIR!, ['github']);
  await plugins.start();
  const { createUser } = await import('../server/users.ts');
  const { startConnect } = await import('../server/connections.ts');
  alice = createUser('installer-alice', 'admin');
  bob = createUser('installer-bob', 'admin');
  const a = await startConnect(alice, { service: 'github', method: 'token', name: 'a-alice', config: { token: 'alice-good' } });
  const b = await startConnect(bob, { service: 'github', method: 'token', name: 'bob', config: { token: 'bob-good' } });
  assert.equal(a.status, 'connected'); assert.equal(b.status, 'connected');
  if (a.status === 'connected') aliceToken = a.connection.id;
  if (b.status === 'connected') bobToken = b.connection.id;
});

after(async () => {
  const { plugins } = await import('../server/plugins/manager.ts');
  await plugins.stop();
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('private repository selection, ownership, remembered access and redirects', async (t) => {
  const gh = await import('../server/plugins/github.ts');
  const { plugins } = await import('../server/plugins/manager.ts');
  const { config } = await import('../server/config.ts');
  const { startConnect, renameConnection, loadConnection } = await import('../server/connections.ts');
  const previousToken = config.githubToken;
  config.githubToken = 'configured-wrong';
  try {
    await fixture('owner/private', [{ id: 'private-test' }], 'HEAD', ['Bearer alice-good']);
    const start = seen.length;
    await gh.install({ repo: 'owner/private' }, { user: alice });
    assert.equal(plugins.get('private-test').source?.githubConnectionId, aliceToken);
    assert.deepEqual(seen.slice(start).filter((s) => s.url.includes('/commits/')).map((s) => s.authorization), [null, 'Bearer configured-wrong', 'Bearer alice-good']);
    await t.test('explicit selection never falls back or uses another user’s connection', async () => {
      await assert.rejects(gh.previewInstall({ repo: 'owner/private' }, { user: bob, githubConnectionId: aliceToken }), /not found/);
      const start = seen.length;
      await assert.rejects(gh.previewInstall({ repo: 'owner/private' }, { user: bob, githubConnectionId: bobToken }), /rejected/);
      assert(seen.slice(start).every((s) => s.authorization === 'Bearer bob-good'));
    });
    await t.test('automatic updates prefer the remembered connection within the acting user', async () => {
      config.githubToken = undefined;
      await renameConnection(alice.id, aliceToken, 'z-alice');
      await startConnect(alice, { service: 'github', method: 'token', name: 'a-other', config: { token: 'other' } });
      const next = await fixture('owner/private', [{ id: 'private-test', version: '1.1.0' }], 'HEAD');
      const start = seen.length;
      const check = await gh.checkUpdates({ user: alice });
      assert.equal(check.find((u) => u.id === 'private-test')?.latest, next);
      assert.deepEqual(seen.slice(start).filter((s) => s.url.includes('/commits/')).map((s) => s.authorization), [null, 'Bearer alice-good']);
      await gh.update('private-test', {}, { user: alice });
      assert.equal(plugins.get('private-test').manifest.version, '1.1.0');
      assert.equal((await gh.checkUpdates({ user: bob })).find((u) => u.id === 'private-test')?.updateAvailable, false);
      assert((await gh.checkUpdates({ user: bob })).find((u) => u.id === 'private-test')?.error);
    });
    await t.test('configured token access works without a saved connection', async () => {
      config.githubToken = 'configured-good';
      await fixture('owner/configured', [{ id: 'configured-test' }], 'HEAD', ['Bearer configured-good']);
      await gh.install({ repo: 'owner/configured' });
      assert.equal(plugins.get('configured-test').status, 'active');
      assert.equal(plugins.get('configured-test').source?.githubConnectionId, undefined);
      config.githubToken = undefined;
    });
    await t.test('explicit update selection also governs private dependencies', async () => {
      await fixture('owner/chosen', [{ id: 'chosen-app' }], 'HEAD', ['Bearer alice-good']);
      await gh.install({ repo: 'owner/chosen' }, { user: alice, githubConnectionId: aliceToken });
      await fixture('owner/chosen', [{ id: 'chosen-app', version: '1.1.0', dependencies: ['chosen-helper'] }]);
      await fixture('owner/chosen-helper', [{ id: 'chosen-helper' }], 'HEAD', ['Bearer other']);
      const previousCatalog = catalog;
      catalog = { schemaVersion: 1, plugins: [{ id: 'chosen-helper', name: 'Chosen helper', description: '', repo: 'owner/chosen-helper', path: 'plugins/chosen-helper' }] };
      const start = seen.length;
      await assert.rejects(gh.previewUpdates([{ id: 'chosen-app', githubConnectionId: aliceToken }], { user: alice }), /rejected/);
      assert(seen.slice(start).filter((r) => r.url.includes('/repos/owner/chosen-helper/')).every((r) => r.authorization === 'Bearer alice-good'));
      assert.equal(plugins.get('chosen-app').manifest.version, '1.0.0');
      assert(!plugins.plugins.has('chosen-helper'));
      catalog = previousCatalog;
    });
    await t.test('archive redirects omit credentials and reject unexpected hosts', async () => {
      await fixture('owner/redirect', [{ id: 'redirect-test' }], 'HEAD', ['Bearer alice-good']);
      repos.get('owner/redirect')!.redirect = 'https://codeload.github.com';
      await gh.install({ repo: 'owner/redirect' }, { user: alice, githubConnectionId: aliceToken });
      assert(seen.filter((s) => s.url.startsWith('https://codeload.github.com/')).every((s) => s.authorization === null));
      repos.get('owner/redirect')!.redirect = 'https://unexpected.example';
      await assert.rejects(gh.previewInstall({ repo: 'owner/redirect' }, { user: alice, githubConnectionId: aliceToken }), /unexpected archive host/);
      assert(!seen.some((s) => s.url.startsWith('https://unexpected.example')));
    });
    await t.test('connection authentication refresh is reused', async () => {
      const service = plugins.service('github')!;
      service.authMethods.push({ id: 'refresh-fixture', name: 'Refresh fixture', connect: () => ({ credentials: { token: 'expired' }, account: { label: 'refresh' } }), authorize: (req, conn, opts) => {
        const token = opts.force ? 'refreshed' : conn.credentials.token;
        req.headers.set('authorization', `Bearer ${token}`);
        return { credentials: { token } };
      } });
      const result = await startConnect(alice, { service: 'github', method: 'refresh-fixture', name: 'refresh' });
      assert.equal(result.status, 'connected');
      if (result.status !== 'connected') return;
      await fixture('owner/refresh', [{ id: 'refresh-test' }], 'HEAD', ['Bearer refreshed']);
      await gh.install({ repo: 'owner/refresh' }, { user: alice, githubConnectionId: result.connection.id });
      assert.equal(loadConnection(alice.id, result.connection.id).conn.credentials.token, 'refreshed');
    });
  } finally { config.githubToken = previousToken; }
});

test('dependency installation, coordinated upgrades and transactional activation', async (t) => {
  const gh = await import('../server/plugins/github.ts');
  const { plugins, validateManifest } = await import('../server/plugins/manager.ts');
  const { one } = await import('../server/db.ts');
  await t.test('manifest compatibility and validation', () => {
    validateManifest({ id: 'valid', name: 'Valid', version: 'legacy', dependencies: ['shared'], dependencyVersions: { shared: '^1.0.0 || ^2.0.0' } });
    for (const bad of [{ other: '^1' }, { shared: 'nonsense' }, { shared: 12 }, []]) {
      assert.throws(() => validateManifest({ id: 'valid', name: 'Valid', version: '1', dependencies: ['shared'], dependencyVersions: bad } as unknown as PluginManifest));
    }
  });
  await t.test('repository-root plugins find adjacent helpers', async () => {
    await fixture('owner/root-layout', [{ id: 'root-layout', atRoot: true, dependencies: ['root-helper'] }, { id: 'root-helper' }]);
    await gh.install({ repo: 'owner/root-layout' }, { user: alice });
    assert.equal(plugins.get('root-layout').status, 'active');
    assert.equal(plugins.get('root-helper').status, 'active');
  });
  await fixture('owner/family', [
    { id: 'family-app', dependencies: ['family-common'], dependencyVersions: { 'family-common': '^1.0.0' } },
    { id: 'family-common' },
    { id: 'family-unrelated' },
  ]);
  await t.test('single-folder install recursively selects dependencies but not unrelated plugins', async () => {
    const preview = await gh.previewInstall({ repo: 'owner/family', path: 'plugins/family-app' }, { user: alice });
    assert.deepEqual(preview.changes.map((c) => c.id).sort(), ['family-app', 'family-common']);
    assert.equal(plugins.plugins.has('family-app'), false, 'preview does not place or activate code');
    await gh.applyPlan(preview.planId, { user: alice });
    assert.equal(plugins.get('family-app').status, 'active');
    assert.equal(plugins.get('family-common').status, 'active');
    assert(!plugins.plugins.has('family-unrelated'));
  });
  await fixture('owner/family', [
    { id: 'family-app', version: '2.0.0', dependencies: ['family-common'], dependencyVersions: { 'family-common': '^2.0.0' } },
    { id: 'family-common', version: '2.0.0' },
  ]);
  await t.test('shared upgrade requires review and applies both changes', async () => {
    await assert.rejects(gh.update('family-app', {}, { user: alice }), (e: any) => e.status === 409 && e.code === 'plugin_review_required' && e.plan.requiresReview);
    assert.equal(plugins.get('family-common').manifest.version, '1.0.0');
    const preview = await gh.previewUpdates([{ id: 'family-app' }], { user: alice });
    assert.equal(preview.requiresReview, true);
    await gh.applyPlan(preview.planId, { user: alice });
    assert.equal(plugins.get('family-app').manifest.version, '2.0.0');
    assert.equal(plugins.get('family-common').manifest.version, '2.0.0');
  });
  await t.test('catalog resolves dependencies from another repository', async () => {
    await fixture('owner/catalog-common', [{ id: 'catalog-common' }]);
    await fixture('owner/catalog-app', [{ id: 'catalog-app', dependencies: ['catalog-common'], dependencyVersions: { 'catalog-common': '~1.0.0' } }]);
    catalog = { schemaVersion: 1, plugins: [{ id: 'catalog-common', name: 'Common', description: '', repo: 'owner/catalog-common', path: 'plugins/catalog-common' }] };
    await gh.install({ repo: 'owner/catalog-app' }, { user: alice });
    assert.equal(plugins.get('catalog-common').status, 'active');
  });
  await t.test('cycles and disabled dependencies fail before changing files', async () => {
    await fixture('owner/cyclic', [{ id: 'cycle-one', dependencies: ['cycle-two'] }, { id: 'cycle-two', dependencies: ['cycle-one'] }]);
    await assert.rejects(gh.previewInstall({ repo: 'owner/cyclic' }, { user: alice }), /cycle/);
    assert(!plugins.plugins.has('cycle-one'));
    await plugins.setEnabled('family-common', false);
    await assert.rejects(gh.previewUpdates([{ id: 'family-app' }], { user: alice }), /Enable dependency/);
    await plugins.setEnabled('family-common', true);
  });
  await t.test('existing dependent constraints prevent incompatible upgrades', async () => {
    await fixture('owner/protected', [{ id: 'protected-common' }, { id: 'protected-consumer', dependencies: ['protected-common'], dependencyVersions: { 'protected-common': '^1' } }]);
    await gh.install({ repo: 'owner/protected' }, { user: alice });
    await fixture('owner/protected', [{ id: 'protected-common', version: '2.0.0' }, { id: 'protected-consumer', dependencies: ['protected-common'], dependencyVersions: { 'protected-common': '^1' } }]);
    await assert.rejects(gh.previewUpdates([{ id: 'protected-common' }], { user: alice }), /protected-consumer requires/);
    assert.equal(plugins.get('protected-common').manifest.version, '1.0.0');
    // Updating the dependent in the same plan can make the shared upgrade compatible.
    await fixture('owner/protected', [{ id: 'protected-common', version: '2.0.0' }, { id: 'protected-consumer', version: '2.0.0', dependencies: ['protected-common'], dependencyVersions: { 'protected-common': '^2' } }]);
    const p = await gh.previewUpdates([{ id: 'protected-common' }, { id: 'protected-consumer' }], { user: alice });
    await gh.applyPlan(p.planId, { user: alice });
    assert.equal(plugins.get('protected-consumer').status, 'active');
  });
  await t.test('activation failure restores all code and database metadata', async () => {
    const beforeApp = one('SELECT * FROM plugins WHERE id = ?', 'family-app');
    const beforeCommon = one('SELECT * FROM plugins WHERE id = ?', 'family-common');
    await fixture('owner/family', [{ id: 'family-app', version: '3.0.0', dependencies: ['family-common'], dependencyVersions: { 'family-common': '^3' }, broken: true }, { id: 'family-common', version: '3.0.0' }]);
    const preview = await gh.previewUpdates([{ id: 'family-app' }], { user: alice });
    await assert.rejects(gh.applyPlan(preview.planId, { user: alice }), /fixture activation failure/);
    assert.deepEqual(one('SELECT * FROM plugins WHERE id = ?', 'family-app'), beforeApp);
    assert.deepEqual(one('SELECT * FROM plugins WHERE id = ?', 'family-common'), beforeCommon);
    assert.equal(plugins.get('family-common').manifest.version, '2.0.0');
    assert.equal(plugins.get('family-app').status, 'active');
  });
  await t.test('failed new installation leaves no files or metadata', async () => {
    await fixture('owner/broken-new', [{ id: 'broken-new', broken: true }, { id: 'new-helper' }]);
    await assert.rejects(gh.install({ repo: 'owner/broken-new' }, { user: alice }), /activation failure/);
    assert(!plugins.plugins.has('broken-new'));
    assert(!plugins.plugins.has('new-helper'));
    assert(!one('SELECT * FROM plugins WHERE id = ?', 'broken-new'));
    assert(!fs.existsSync(path.join(process.env.SWITCHBOARD_DATA_DIR!, 'plugins', 'new-helper')));
  });
  await t.test('previews are pinned, administrator-bound, single use, and invalidated by local edits', async () => {
    await fixture('owner/pinning', [{ id: 'pinned-plugin' }]);
    const p = await gh.previewInstall({ repo: 'owner/pinning' }, { user: alice });
    await assert.rejects(gh.applyPlan(p.planId, { user: bob }), /preview/);
    await fixture('owner/pinning', [{ id: 'pinned-plugin', version: '2.0.0' }]);
    await gh.applyPlan(p.planId, { user: alice });
    assert.equal(plugins.get('pinned-plugin').manifest.version, '1.0.0');
    await assert.rejects(gh.applyPlan(p.planId, { user: alice }), /preview/);
    const next = await gh.previewUpdates([{ id: 'pinned-plugin' }], { user: alice });
    fs.appendFileSync(path.join(plugins.get('pinned-plugin').dir, 'index.ts'), '\n// local edit');
    await assert.rejects(gh.applyPlan(next.planId, { user: alice }), /state changed/);
    const expired = await gh.previewUpdates([{ id: 'pinned-plugin' }], { user: alice });
    expired.expiresAt = Date.now() - 1;
    await assert.rejects(gh.applyPlan(expired.planId, { user: alice }), /expired/);
  });
  await t.test('runtime loading also enforces ranges on locally edited manifests', async () => {
    const manifestPath = path.join(plugins.get('catalog-app').dir, 'plugin.json');
    const old = fs.readFileSync(manifestPath, 'utf8');
    const m = JSON.parse(old); m.dependencyVersions['catalog-common'] = '^99';
    fs.writeFileSync(manifestPath, JSON.stringify(m));
    await plugins.reload(['catalog-app']);
    assert.equal(plugins.get('catalog-app').status, 'blocked');
    assert.match(plugins.get('catalog-app').error!, /installed version/);
    fs.writeFileSync(manifestPath, old); await plugins.reload(['catalog-app']);
  });
});

test('catalog freshness, validation, bounded responses and admin API routes', async () => {
  const { communityCatalog, validateCatalog } = await import('../server/plugins/catalog.ts');
  catalog = { schemaVersion: 1, plugins: [] };
  assert.equal((await communityCatalog()).plugins.length, 0);
  catalog = { schemaVersion: 1, plugins: [{ id: 'live', name: 'Live', description: 'Changed', repo: 'owner/live' }] };
  assert.equal((await communityCatalog()).plugins[0].id, 'live');
  assert.throws(() => validateCatalog({ schemaVersion: 2, plugins: [] }));
  const icon = 'https://raw.githubusercontent.com/owner/live/main/icon.svg';
  assert.equal(validateCatalog({ schemaVersion: 1, plugins: [{ ...(catalog as any).plugins[0], icon }] }).plugins[0].icon, icon);
  for (const icon of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'https://example.com/tracker.svg']) {
    assert.throws(() => validateCatalog({ schemaVersion: 1, plugins: [{ ...(catalog as any).plugins[0], icon }] }));
  }
  assert.throws(() => validateCatalog({ schemaVersion: 1, plugins: [{ id: 'bad', name: 'Bad', description: '', repo: 'owner/repo', path: '../bad' }] }));
  assert.throws(() => validateCatalog({ schemaVersion: 1, plugins: [(catalog as any).plugins[0], (catalog as any).plugins[0]] }));
  catalogStatus = 503; await assert.rejects(communityCatalog(), /unavailable/); catalogStatus = 200;
  const validCatalog = catalog;
  catalog = { schemaVersion: 1, plugins: [{ id: 'huge', name: 'Huge', description: 'x'.repeat(1024 * 1024), repo: 'owner/huge' }] };
  await assert.rejects(communityCatalog(), /unavailable/); catalog = validCatalog;
  const { Hono } = await import('hono');
  const { admin } = await import('../server/routes/admin.ts');
  const { HttpError } = await import('../server/http.ts');
  const { createToken, createUser } = await import('../server/users.ts');
  const app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status as any : 500));
  app.route('/api/admin', admin);
  const adminSecret = createToken(alice.id, 'installer API', null).secret;
  const ordinary = createUser('ordinary-installer', 'user');
  const ordinarySecret = createToken(ordinary.id, 'ordinary API', null).secret;
  const limitedSecret = createToken(alice.id, 'limited installer', [aliceToken]).secret;
  const call = (url: string, token = adminSecret, body?: unknown) => app.request(`/api/admin${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call('/plugins/community')).status, 200, 'static catalog route is not captured as a plugin id');
  assert.equal((await call('/plugins/community', ordinarySecret)).status, 403);
  assert.equal((await call('/plugins/community', limitedSecret)).status, 403);
  await fixture('owner/api-new', [{ id: 'api-new' }]);
  for (const endpoint of ['/plugins/install/plan', '/plugins/update/plan', '/plugins/apply', '/plugins/install']) {
    assert.equal((await call(endpoint, adminSecret, null)).status, 400, endpoint);
    assert.equal((await call(endpoint, adminSecret, [])).status, 400, endpoint);
  }
  assert.equal((await call('/plugins/update/plan', adminSecret, { updates: [] })).status, 400);
  const preview = await (await call('/plugins/install/plan', adminSecret, { repo: 'owner/api-new' })).json() as any;
  assert(preview.planId);
  const applied = await call('/plugins/apply', adminSecret, { planId: preview.planId });
  assert.equal(applied.status, 200);
  assert.equal(((await applied.json()) as any).plugins[0].id, 'api-new');
  const { one } = await import('../server/db.ts');
  await call('/plugins/check-updates', adminSecret, {});
  const audit = one('SELECT request_headers FROM audit_log WHERE source = ? AND connection_id = ? ORDER BY id DESC LIMIT 1', 'plugin', aliceToken);
  assert(audit);
  assert(!audit.request_headers.includes('alice-good'), 'plugin requests are audited with credentials masked');
});
