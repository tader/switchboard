import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = 'owner/service';
const sha = 'b'.repeat(40);
const valid = { base: { ref: 'main' }, head: { repo: { full_name: repo }, ref: 'release-please--branches--main', sha }, state: 'open' };
function dispatch(pr: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'release-ci-'));
  try {
    const log = join(dir, 'calls.jsonl');
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(process.env.CALL_LOG,JSON.stringify(args)+'\\n');if(args[0]==='api')process.stdout.write(process.env.PR_FIXTURE);\n`, { mode: 0o700 });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [resolve('.github/scripts/dispatch-release-checks.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, GH_TOKEN: 'offline-fixture', GH_REPO: repo, RELEASE_PRS: JSON.stringify([{ number: 42, head: { sha: 'a'.repeat(40) } }]), PR_FIXTURE: JSON.stringify(pr), CALL_LOG: log },
    });
    return { status: result.status, calls: readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('release checks dispatch against freshly fetched same-repository release PR head', () => {
  const r = dispatch(valid);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [['api', `repos/${repo}/pulls/42`], ['workflow', 'run', 'check.yml', '--ref', valid.head.ref, '-f', `expected_sha=${sha}`]]);
});
test('release check dispatcher rejects forks, unrelated branches, closed PRs and invalid revisions', () => {
  for (const pr of [
    { ...valid, head: { ...valid.head, repo: { full_name: 'attacker/fork' } } },
    { ...valid, head: { ...valid.head, ref: 'feature/unrelated' } },
    { ...valid, base: { ref: 'other' } },
    { ...valid, state: 'closed' },
    { ...valid, head: { ...valid.head, sha: 'main' } },
  ]) {
    const r = dispatch(pr);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 1, 'unsafe PR must never reach workflow dispatch');
  }
});
test('release workflow explicitly schedules required CI including image validation', () => {
  const release = YAML.parse(readFileSync('.github/workflows/release-please.yml', 'utf8'));
  const check = YAML.parse(readFileSync('.github/workflows/check.yml', 'utf8'));
  assert.equal(release.permissions.actions, 'write');
  assert.ok(release.jobs.release.steps.some((s: any) => s.run === 'node .github/scripts/dispatch-release-checks.mjs'));
  assert.ok(check.on.workflow_dispatch.inputs.expected_sha);
  assert.ok(check.jobs.check.steps.some((s: any) => s.run?.includes('git rev-parse HEAD') && s.env?.EXPECTED_SHA === '${{ inputs.expected_sha }}'));
  assert.equal(check.jobs.image.needs, 'check');
  assert.deepEqual(check.on.push.branches, ['main']);
  assert.equal(check.on.workflow_dispatch.inputs.publish_edge.type, 'boolean');
  assert.equal(check.on.workflow_dispatch.inputs.publish_edge.default, false);
  const expression = check.jobs.image.with.publish.match(/^\$\{\{([\s\S]+)\}\}$/)?.[1];
  assert.ok(expression);
  // This workflow expression uses only the shared boolean/comparison subset.
  const publishes = new Function('github', 'inputs', `return (${expression});`);
  for (const [event_name, ref, publish_edge, expected] of [
    ['push', 'refs/heads/main', false, true],
    ['pull_request', 'refs/pull/42/merge', true, false],
    ['workflow_dispatch', 'refs/heads/main', false, false],
    ['workflow_dispatch', 'refs/heads/release-please--branches--main', true, false],
    ['workflow_dispatch', 'refs/heads/main', true, true],
    ['workflow_run', 'refs/heads/main', true, false],
  ] as const) {
    assert.equal(publishes({ event_name, ref }, { publish_edge }), expected, `${event_name}: ${ref}, publish_edge=${publish_edge}`);
  }
});

test('validated image callers build the same revision as the required unit checks', () => {
  const check = YAML.parse(readFileSync('.github/workflows/check.yml', 'utf8'));
  const checkout = check.jobs.check.steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
  const tested = checkout.with?.ref ?? '${{ github.sha }}';
  assert.equal(check.jobs.image.with.validated, true);
  assert.equal(check.jobs.image.with.ref, tested);
  assert.equal(check.jobs.runtime.with.ref, tested);
});
