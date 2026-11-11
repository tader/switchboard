import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const host = fileURLToPath(new URL('../server/authentication-browser-host.js', import.meta.url));
test('browser owner reaps a TERM-resistant browser after its parent is hard-killed', { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-owner-'));
  const ready = path.join(dir, 'ready');
  const fixture = path.join(dir, 'browser.mjs');
  await fs.writeFile(fixture, `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
  const source = `const {spawn}=await import('node:child_process');const child=spawn(process.execPath,${JSON.stringify([host, process.execPath, fixture, ready])},{stdio:['ignore','ignore','ignore','pipe','pipe','ipc']});child.on('exit',()=>process.exit());setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  let browserPid: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (let i = 0; i < 100; i++) {
      try { browserPid = Number(await fs.readFile(ready, 'utf8')); break; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(browserPid, 'browser started');
    const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
    const started = Date.now();
    while (alive(browserPid) && Date.now() - started < 6000) await new Promise(r => setTimeout(r, 50));
    assert.equal(alive(browserPid), false, 'owner must kill and reap the browser even when TERM is ignored');
  } finally {
    parent.kill('SIGKILL');
    if (browserPid && alive(browserPid)) process.kill(browserPid, 'SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
