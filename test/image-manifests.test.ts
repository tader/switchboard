import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-manifests-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  for (const name of ['bin', 'digests/app', 'digests/updater']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin/docker'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  for (const [kind, chars] of [['app', ['a', 'b']], ['updater', ['c', 'd']]] as const) {
    for (const c of chars) fs.writeFileSync(path.join(dir, 'digests', kind, c.repeat(64)), '');
  }
  return { dir, run(extra: NodeJS.ProcessEnv = {}) {
    const result = spawnSync('bash', ['.github/scripts/publish-image-manifests.sh'], { encoding: 'utf8', env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, CALLS: path.join(dir, 'calls'), DIGESTS: path.join(dir, 'digests'), REPOSITORY: 'synthetic/core', APP_TAGS: 'ghcr.io/synthetic/core:1.2.3,ghcr.io/synthetic/core:sha-' + 'f'.repeat(40), ...extra } });
    const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { status: result.status, calls };
  } };
}
test('publication joins both tested architectures and preserves matching updater tags', () => {
  const { run } = fixture(); const result = run(); assert.equal(result.status, 0); assert.equal(result.calls.length, 2);
  for (const [i, suffix, chars] of [[0, '', ['a', 'b']], [1, '-updater', ['c', 'd']]] as const) {
    assert.deepEqual(result.calls[i], ['buildx', 'imagetools', 'create', '--tag', `ghcr.io/synthetic/core${suffix}:1.2.3`, '--tag', `ghcr.io/synthetic/core${suffix}:sha-${'f'.repeat(40)}`, ...chars.map(c => `ghcr.io/synthetic/core${suffix}@sha256:${c.repeat(64)}`)]);
  }
});
test('incomplete or malformed updater artifacts cannot move either public image tag', () => {
  for (const corrupt of [false, true]) {
    const { dir, run } = fixture(); fs.unlinkSync(path.join(dir, 'digests/updater', 'd'.repeat(64)));
    if (corrupt) fs.writeFileSync(path.join(dir, 'digests/updater/not-a-digest'), '');
    const result = run(); assert.notEqual(result.status, 0); assert.deepEqual(result.calls, []);
  }
});
test('publication rejects foreign repositories and malformed tag lists before invoking Docker', () => {
  for (const APP_TAGS of ['ghcr.io/other/repository:latest', 'ghcr.io/synthetic/core:bad tag', '']) {
    const result = fixture().run({ APP_TAGS }); assert.notEqual(result.status, 0); assert.deepEqual(result.calls, []);
  }
});
