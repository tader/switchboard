import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/bump-version.sh', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-version-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const first = path.join(dir, 'first');
  git(dir, 'init', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', remote, first);
  git(first, 'config', 'user.name', 'Version test');
  git(first, 'config', 'user.email', 'version@example.com');
  const manifest = { name: 'fixture', version: '0.1.0', private: true, scripts: { preversion: 'touch unexpected-script' } };
  const lock = { name: 'fixture', version: '0.1.0', lockfileVersion: 3, packages: {
    '': { name: 'fixture', version: '0.1.0' },
    'node_modules/example': { version: '2.0.0' },
  } };
  fs.writeFileSync(path.join(first, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(first, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  fs.mkdirSync(path.join(first, 'web'));
  fs.writeFileSync(path.join(first, 'web/package.json'), '{"name":"web","private":true}\n');
  git(first, 'add', '.');
  git(first, 'commit', '-m', 'Initial version');
  git(first, 'push', 'origin', 'main');
  return { dir, remote, first };
}

function bump(cwd: string, pr: string) {
  return spawnSync('bash', [script], { cwd, env: { ...process.env, PR_NUMBER: pr }, encoding: 'utf8' });
}

function assertVersion(cwd: string, version: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(lock.packages['node_modules/example'].version, '2.0.0');
  assert.equal(fs.existsSync(path.join(cwd, 'unexpected-script')), false, 'Version hooks are disabled');
  assert.equal(fs.readFileSync(path.join(cwd, 'web/package.json'), 'utf8'), '{"name":"web","private":true}\n');
}

test('version bumps keep manifests in sync and reruns do not bump twice', (t) => {
  const { first } = fixture(t);
  const initial = git(first, 'rev-parse', 'HEAD');
  const firstRun = bump(first, '1');
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assertVersion(first, '0.1.1');
  assert.equal(git(first, 'diff', '--name-only', initial, 'HEAD'), 'package-lock.json\npackage.json');
  const once = git(first, 'rev-parse', 'HEAD');
  assert.equal(bump(first, '1').status, 0);
  assert.equal(git(first, 'rev-parse', 'HEAD'), once);
  assert.equal(bump(first, '10').status, 0, 'PR 10 is distinct from PR 1');
  assertVersion(first, '0.1.2');
  const twice = git(first, 'rev-parse', 'HEAD');
  assert.equal(bump(first, '1').status, 0);
  assert.equal(git(first, 'rev-parse', 'HEAD'), twice);
  assert.equal(git(first, 'tag'), '', 'Bumps do not create tags');
});

test('a competing bump is preserved and a rejected push is recomputed', (t) => {
  const { dir, remote, first } = fixture(t);
  const rival = path.join(dir, 'rival');
  git(dir, 'clone', remote, rival);
  git(rival, 'config', 'user.name', 'Version test');
  git(rival, 'config', 'user.email', 'version@example.com');
  // Advance main after the first run prepares its commit, before it pushes.
  fs.writeFileSync(path.join(first, '.git/hooks/pre-push'),
    `#!/bin/sh\nset -e\nrm -- "$0"\ncd ${quote(rival)}\nPR_NUMBER=20 bash ${quote(script)}\n`, { mode: 0o755 });
  const result = bump(first, '21');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Main advanced/);
  assertVersion(first, '0.1.2');
  assert.equal(git(first, 'rev-list', '--count', 'HEAD'), '3');
  const messages = git(first, 'log', '--format=%B');
  assert.match(messages, /Version-Bump-For-PR: 20/);
  assert.match(messages, /Version-Bump-For-PR: 21/);
  assert.equal(git(first, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
});

test('a denied push fails clearly and leaves remote main unchanged', (t) => {
  const { remote, first } = fixture(t);
  const initial = git(remote, 'rev-parse', 'main');
  fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = bump(first, '30');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check repository write permissions and branch protection/);
  assert.equal(git(remote, 'rev-parse', 'main'), initial);
});
