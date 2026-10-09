import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

// Uses the HUB_* variables from before the rename to Switchboard, which must keep working.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gh-'));
process.env.HUB_DATA_DIR = path.join(tmp, 'data');
process.env.HUB_WATCH_PLUGINS = 'false';
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
// An existing database from before the rename is moved to its new name.
fs.writeFileSync(path.join(process.env.HUB_DATA_DIR, 'hub.db'), '');

// A fake repository with two plugins, served as GitHub tarballs per commit.
let commit = 'aaa111';
const repoFiles = (version: string) => ({
  'plugins/hello/plugin.json': JSON.stringify({ id: 'hello', name: 'Hello', version, dependencies: ['api-key'] }),
  'plugins/hello/index.ts': `export default (ctx) => ({ services: [{ id: 'hello', name: 'Hello ${version}', baseUrl: 'https://example.com', authMethods: [ctx.require('api-key').bearerToken()] }] });`,
  'plugins/other/plugin.json': JSON.stringify({ id: 'other', name: 'Other', version }),
  'plugins/other/index.ts': `export default () => ({});`,
  'README.md': 'repo',
});

async function tarball(version: string, changes: Record<string, string | null> = {}) {
  const dir = path.join(tmp, `src-${version}`, 'owner-repo-sha');
  for (const [f, content] of Object.entries({ ...repoFiles(version), ...changes })) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  const out = path.join(tmp, `${version}.tgz`);
  await tar.c({ gzip: true, file: out, cwd: path.dirname(dir) }, ['owner-repo-sha']);
  return fs.readFileSync(out);
}

let versions: Record<string, Buffer>;
const refs: Record<string, string> = { 'feature/new': 'ccc333', same: 'bbb222', v1: 'aaa111', aaa111: 'aaa111', broken: 'bad001', wrong: 'bad002', missing: 'bad003', blocked: 'bad004' };
const resolved: string[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  versions = {
    aaa111: await tarball('1.0.0'), bbb222: await tarball('2.0.0'), ccc333: await tarball('3.0.0'),
    bad001: await tarball('broken', { 'plugins/hello/index.ts': 'export default () => { throw new Error("Broken feature"); };' }),
    bad002: await tarball('wrong', { 'plugins/hello/plugin.json': JSON.stringify({ id: 'other', name: 'Wrong', version: '9' }) }),
    bad003: await tarball('missing', { 'plugins/hello/plugin.json': null }),
    bad004: await tarball('blocked', { 'plugins/hello/plugin.json': JSON.stringify({ id: 'hello', name: 'Hello', version: '9', dependencies: ['not-installed'] }) }),
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/tader/switchboard-plugins/main/plugins.json') return Response.json({ schemaVersion: 1, plugins: [] });
    if (url.startsWith('https://api.github.com/repos/owner/repo/commits/')) {
      const ref = decodeURIComponent(url.split('/commits/')[1]);
      resolved.push(ref);
      const sha = ref === 'HEAD' ? commit : refs[ref];
      return sha ? new Response(sha) : new Response('Not found', { status: 404 });
    }
    const m = url.match(/^https:\/\/api\.github\.com\/repos\/owner\/repo\/tarball\/(\w+)$/);
    if (m) return new Response(new Uint8Array(versions[m[1]]));
    return realFetch(input, init);
  }) as typeof fetch;
  const { initKey } = await import('../server/crypto.ts');
  const { initDb } = await import('../server/db.ts');
  initKey();
  initDb();
  const { plugins } = await import('../server/plugins/manager.ts');
  await plugins.start();
});

test('data and tokens from before the rename to Switchboard', async () => {
  assert.ok(fs.existsSync(path.join(process.env.HUB_DATA_DIR!, 'switchboard.db')), 'hub.db was renamed');
  assert.ok(!fs.existsSync(path.join(process.env.HUB_DATA_DIR!, 'hub.db')));
  const { isApiToken, TOKEN_PREFIX } = await import('../server/users.ts');
  assert.equal(TOKEN_PREFIX, 'swb_');
  assert.ok(isApiToken('hub_old') && isApiToken('swb_new') && !isApiToken('ghp_other'));
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('install every plugin in a repository, update and uninstall', async (t) => {
  const gh = await import('../server/plugins/github.ts');
  const { plugins } = await import('../server/plugins/manager.ts');

  assert.deepEqual(gh.parseRepo('https://github.com/owner/repo/tree/main/plugins/hello'), { repo: 'owner/repo', ref: 'main', path: 'plugins/hello' });
  assert.deepEqual(gh.parseRepo('owner/repo@v2'), { repo: 'owner/repo', ref: 'v2', path: undefined });

  const ids = await gh.install({ repo: 'owner/repo' });
  assert.deepEqual(ids.sort(), ['hello', 'other']);
  assert.equal(plugins.get('hello').status, 'active');
  assert.equal(plugins.service('hello')?.name, 'Hello 1.0.0');
  assert.equal(plugins.get('hello').source?.path, 'plugins/hello');

  assert.deepEqual((await gh.checkUpdates()).map((u) => u.updateAvailable), [false, false]);
  commit = 'bbb222';
  assert.ok((await gh.checkUpdates()).every((u) => u.updateAvailable));

  const r = await gh.update('hello');
  assert.deepEqual([r.from, r.to], ['aaa111', 'bbb222']);
  assert.equal(plugins.service('hello')?.name, 'Hello 2.0.0');
  assert.equal(plugins.get('other').manifest.version, '1.0.0', 'other plugin untouched');

  await t.test('switch refs, follow future updates, and return to the default branch', async () => {
    const switched = await gh.update('hello', { ref: ' feature/new ' });
    assert.equal(switched.ref, 'feature/new');
    assert.equal(switched.fromRef, null);
    assert.equal(plugins.service('hello')?.name, 'Hello 3.0.0');
    assert.equal(resolved.at(-1), 'feature/new');
    refs['feature/new'] = 'bbb222';
    assert.equal((await gh.checkUpdates()).find((u) => u.id === 'hello')?.latest, 'bbb222');
    await gh.update('hello');
    assert.equal(plugins.get('hello').source?.ref, 'feature/new');
    assert.equal(plugins.get('hello').source?.commit, 'bbb222');
    const same = await gh.update('hello', { ref: 'same' });
    assert.equal(same.from, same.to);
    assert.equal(plugins.get('hello').source?.ref, 'same');
    await gh.update('hello', { ref: 'v1' });
    assert.equal(plugins.get('hello').source?.commit, 'aaa111');
    await gh.update('hello', { ref: 'aaa111' });
    assert.equal(plugins.get('hello').source?.ref, 'aaa111');
    await gh.update('hello', { ref: null });
    assert.equal(resolved.at(-1), 'HEAD');
    assert.equal(plugins.get('hello').source?.ref, undefined);
    assert.equal(plugins.get('hello').source?.commit, 'bbb222');
    await plugins.reload(['hello']);
    assert.equal(plugins.get('hello').source?.ref, undefined, 'default choice persists across reload');
  });

  await t.test('reject bad input and preserve the previous installation on failure', async () => {
    const { one } = await import('../server/db.ts');
    const before = one('SELECT * FROM plugins WHERE id = ?', 'hello');
    const original = fs.readFileSync(path.join(plugins.get('hello').dir, 'index.ts'), 'utf8');
    for (const input of [null, [], 'main', { ref: false }, { ref: 123 }, { ref: {} }, { ref: '' }, { ref: 'a\nb' }]) assert.throws(() => gh.updateOptions(input));
    for (const ref of ['does-not-exist', 'wrong', 'missing', 'broken', 'blocked']) {
      await assert.rejects(gh.update('hello', { ref }));
      assert.deepEqual(one('SELECT * FROM plugins WHERE id = ?', 'hello'), before, ref);
      assert.equal(fs.readFileSync(path.join(plugins.get('hello').dir, 'index.ts'), 'utf8'), original, ref);
      assert.equal(plugins.service('hello')?.name, 'Hello 2.0.0', ref);
      assert.equal(plugins.get('other').manifest.version, '1.0.0', 'mismatched ID did not overwrite other');
    }
    assert.deepEqual(fs.readdirSync(path.join(process.env.HUB_DATA_DIR!, 'plugins')).sort(), ['hello', 'other']);
  });

  await t.test('serialize updates so omitted refs follow the preceding switch', async () => {
    const [first, second] = await Promise.all([gh.update('hello', { ref: 'v1' }), gh.update('hello')]);
    assert.equal(first.to, 'aaa111');
    assert.equal(second.from, 'aaa111');
    assert.equal(second.ref, 'v1');
    assert.equal(plugins.get('hello').source?.ref, 'v1');
    assert.equal(plugins.get('other').manifest.version, '1.0.0');
  });

  await gh.uninstall('hello');
  assert.equal(plugins.service('hello'), undefined);
  assert.throws(() => plugins.get('hello'));
  await assert.rejects(gh.uninstall('api-key'), /Built-in/);
  assert.equal(fs.readdirSync(path.join(process.env.HUB_DATA_DIR!, 'tmp')).length, 0, 'temp dirs cleaned up');
  await plugins.stop();
});
