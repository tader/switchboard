import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

test('startup announcement waits for the actual listening socket', { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-readiness-'));
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const preload = path.join(dir, 'delay-listen.mjs');
  await fs.writeFile(preload, `import http from 'node:http';const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){setTimeout(()=>listen.apply(this,args),1500);return this;};`);
  const child = spawn(process.execPath, ['--import', preload, 'server/main.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_DATA_DIR: path.join(dir, 'data'), SWITCHBOARD_UPDATE_CHECKS: 'false', SWITCHBOARD_WATCH_PLUGINS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('Switchboard listening') && Date.now() < deadline) {
      assert.equal(child.exitCode, null, 'server must stay alive');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(output.includes('Switchboard listening'), 'server announced readiness');
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 200);
  } finally {
    const stopped = once(child, 'exit'); child.kill(); if (child.exitCode === null && child.signalCode === null) await stopped;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
