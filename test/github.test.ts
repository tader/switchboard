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

async function tarball(version: string) {
  const dir = path.join(tmp, `src-${version}`, 'owner-repo-sha');
  for (const [f, content] of Object.entries(repoFiles(version))) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  const out = path.join(tmp, `${version}.tgz`);
  await tar.c({ gzip: true, file: out, cwd: path.dirname(dir) }, ['owner-repo-sha']);
  return fs.readFileSync(out);
}

let versions: Record<string, Buffer>;
const realFetch = globalThis.fetch;

before(async () => {
  versions = { aaa111: await tarball('1.0.0'), bbb222: await tarball('2.0.0') };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/owner/repo/commits/')) return new Response(commit);
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

test('install every plugin in a repository, update and uninstall', async () => {
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

  await gh.uninstall('hello');
  assert.equal(plugins.service('hello'), undefined);
  assert.throws(() => plugins.get('hello'));
  await assert.rejects(gh.uninstall('api-key'), /Built-in/);
  assert.equal(fs.readdirSync(path.join(process.env.HUB_DATA_DIR!, 'tmp')).length, 0, 'temp dirs cleaned up');
  await plugins.stop();
});
