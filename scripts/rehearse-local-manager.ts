/** Synthetic, isolated runtime rehearsal. Usage: node scripts/rehearse-local-manager.ts /prepared/runtime */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const runtime = path.resolve(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-manager-rehearsal-'));
const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r()));
const url = `http://127.0.0.1:${port}`;
const settings = { instance: 'local-manager', mode: 'runtime', initialRelease: runtime, stateDir: path.join(root, 'updater'), dataDir: path.join(root, 'data'), appUrl: url, env: { SWITCHBOARD_HOST: '127.0.0.1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_PUBLIC_URL: url, SWITCHBOARD_UPDATE_CHECKS: 'false', SWITCHBOARD_WATCH_PLUGINS: 'false' } };
let active: ReturnType<typeof launch> | undefined;
function launch() {
  const child = spawn(path.join(runtime, 'bin/node'), ['--disable-warning=ExperimentalWarning', 'updater/desktop.ts'], { cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'] });
  const events: any[] = []; readline.createInterface({ input: child.stdout }).on('line', line => { events.push(JSON.parse(line)); });
  child.stderr.on('data', () => {});
  const send = (action: string) => child.stdin.write(JSON.stringify({ action, ...(action === 'start' ? { settings } : {}) }) + '\n');
  const wait = async (event: string) => { const until = Date.now() + 100_000; while (Date.now() < until) { const index = events.findIndex(e => e.event === event); if (index >= 0) return events.splice(index, 1)[0]; if (events.some(e => e.event === 'error')) throw Error('Supervisor error'); await new Promise(r => setTimeout(r, 100)); } throw Error(`Timed out: ${event}`); };
  return { child, send, wait, events };
}
async function offline() { const end = Date.now() + 50_000; while (Date.now() < end) { try { await fetch(url + '/readyz', { signal: AbortSignal.timeout(500) }); } catch { return; } await new Promise(r => setTimeout(r, 100)); } throw Error('Owned server remained running'); }
try {
  active = launch(); active.send('start');
  const first = await active.wait('started'); assert.ok(first.setupUrl?.startsWith(url + '/invite#'));
  assert.ok((await fetch(first.setupUrl.split('#')[0])).ok);
  const response = await fetch(url + '/api/auth/invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ token: first.setupUrl.split('#')[1], password: 'synthetic-test-password' }) }); assert.equal(response.status, 200);
  active.send('status'); const paired = await active.wait('paired'); assert.equal(paired.event, 'paired');
  for (const endpoint of ['/api/me', '/api/admin/updates', '/api/connections']) assert.equal((await fetch(url + endpoint, { headers: { authorization: 'Bearer swbu_synthetic-narrow-credential' } })).status, 401);
  active.send('status'); const status = await active.wait('status'); assert.equal(status.ready, true); assert.equal(status.attention, 0);
  active.send('quit'); await new Promise(r => active!.child.once('exit', r)); await offline();
  active = launch(); active.send('start'); assert.equal((await active.wait('started')).setupUrl, undefined); active.send('status'); await active.wait('paired');
  active.child.kill('SIGKILL'); await new Promise(r => active!.child.once('exit', r)); await offline();
  active = launch(); active.send('start'); await active.wait('started'); active.send('status'); await active.wait('paired');
  // Only the owned synthetic server PID is signalled. Three restart attempts, then stop.
  for (let crash = 0; crash < 4; crash++) {
    const pid = JSON.parse(fs.readFileSync(path.join(settings.stateDir, 'child.json'), 'utf8')).pid;
    process.kill(pid, 'SIGKILL');
    if (crash < 3) {
      const until = Date.now() + 30_000;
      while (true) { const next = JSON.parse(fs.readFileSync(path.join(settings.stateDir, 'child.json'), 'utf8')).pid; try { if (next !== pid && (await fetch(url + '/readyz')).ok) break; } catch {} if (Date.now() > until) throw Error('Owned restart timed out'); await new Promise(r => setTimeout(r, 100)); }
    }
  }
  await active.wait('server-failed'); await new Promise(r => active!.child.once('exit', r)); await offline();
  active = launch(); active.send('start'); await active.wait('started'); active.send('status'); await active.wait('paired');
  active.child.stdin.end(); await new Promise(r => active!.child.once('exit', r)); await offline();
  console.log('PASS: independent prepared runtime, browser enrollment, private pairing, general API rejection, restart/adoption, manager crash cleanup, parent-pipe cleanup, bounded owned-server restarts');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, port, checks: 8 })); console.log(`Artifacts: ${root}`);
} finally { if (active?.child.exitCode === null && active.child.signalCode === null) { active.child.stdin.end(); } }
