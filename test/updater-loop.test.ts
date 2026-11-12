import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Controller, atomic, type Settings } from '../updater/engine.ts';

const target = { version: '1.1.0', baseRevision: 'a'.repeat(40), revision: 'b'.repeat(40), protocol: 1, channel: 'stable', notes: '', url: 'https://example.com/release' };

// Run the production polling entry point, not a direct execute() invocation.
async function fixture(t: any, options: { cancel?: boolean; missingFile?: boolean; rejectFirstReport?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-loop-'));
  const stateDir = path.join(dir, 'state'); fs.mkdirSync(stateDir);
  const file = path.join(dir, 'compose.yaml');
  if (!options.missingFile) fs.writeFileSync(file, 'services: {}');
  const trace = path.join(dir, 'docker-calls');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho called >> '${trace}'\necho synthetic-subprocess-secret >&2\nexit 1\n`, { mode: 0o700 });
  const reports: any[] = []; let rejected = false;
  const job = { id: 'synthetic-job', state: 'queued', target, cancel: options.cancel, createdAt: Date.now() };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/api/updater/poll') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ protocol: 1, job })); }
    else if (req.url === '/api/updater/report') {
      reports.push(JSON.parse(body));
      if (options.rejectFirstReport && !rejected) { rejected = true; res.writeHead(503); res.end('{}'); }
      else { job.state = reports.at(-1).state; res.end('{}'); }
    } else { res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const settings: Settings = { instance: 'synthetic', mode: 'compose', dataDir: path.join(dir, 'data'), stateDir, appUrl: `http://127.0.0.1:${port}`, token: 'synthetic-updater-token', env: {}, compose: { directory: dir, files: [file], project: 'synthetic', service: 'app' } };
  const config = path.join(dir, 'settings.json'); atomic(config, settings);
  const child = spawn(process.execPath, ['updater/main.ts', 'run', config], { cwd: path.resolve('.'), env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  async function until(done: () => boolean) {
    const end = Date.now() + 8500;
    while (!done() && Date.now() < end && child.exitCode === null) await new Promise(r => setTimeout(r, 25));
    assert.ok(done(), 'The real updater loop did not acknowledge the job');
  }
  return { dir, stateDir, reports, trace, job, until, output: () => output };
}

test('real updater loop reports failed Compose preflight without deployment or subprocess disclosure', async t => {
  const f = await fixture(t); await f.until(() => f.job.state === 'failed');
  assert.deepEqual(f.reports.map(r => [r.state, r.reason]), [['failed', 'preflight']]);
  assert.equal(fs.readFileSync(f.trace, 'utf8').trim(), 'called');
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'journal.json')));
  const diagnostic = path.join(f.stateDir, 'last-preflight-error.json');
  assert.equal(fs.statSync(diagnostic).mode & 0o777, 0o600);
  assert.match(f.output(), /preflight failed/);
  assert.ok(!f.output().includes('synthetic-subprocess-secret'));
  assert.ok(!fs.readFileSync(diagnostic, 'utf8').includes('synthetic-subprocess-secret'));
});
test('real updater acknowledges queued cancellation without accessing Docker or Compose files', async t => {
  const f = await fixture(t, { cancel: true, missingFile: true }); await f.until(() => f.job.state === 'cancelled');
  assert.deepEqual(f.reports.map(r => r.state), ['cancelled']);
  assert.ok(!fs.existsSync(f.trace)); assert.ok(!fs.existsSync(path.join(f.stateDir, 'journal.json')));
});
test('real updater records missing bundle mount and retries only failure reporting after API outage', async t => {
  const f = await fixture(t, { missingFile: true, rejectFirstReport: true }); await f.until(() => f.job.state === 'failed');
  assert.deepEqual(f.reports.map(r => r.state), ['failed', 'failed']);
  assert.ok(!fs.existsSync(f.trace));
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'last-preflight-error.json'), 'utf8'));
  assert.match(diagnostic.reason, /mount the complete bundle/);
  assert.equal(f.output().split('Updater preflight failed').length - 1, 1);
});
test('idle polling with no journal and no job succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-idle-'));
  try {
    const c = new Controller({ instance: 'synthetic', mode: 'checkout', dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), initialRelease: '/synthetic/release', appUrl: 'http://127.0.0.1:8770', env: {} });
    c.api = async () => ({ protocol: 1 });
    await c.tick();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
