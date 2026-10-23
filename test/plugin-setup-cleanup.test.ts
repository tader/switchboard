import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-setup-'));
process.env.SWITCHBOARD_DATA_DIR = path.join(tmp, 'data');
process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR = path.join(tmp, 'builtin');
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR, { recursive: true });
const { initKey } = await import('../server/crypto.ts');
const { initDb } = await import('../server/db.ts');
initKey();
initDb();
const { plugins } = await import('../server/plugins/manager.ts');
let enter!: () => void, release!: () => void;
const entered = new Promise<void>((resolve) => (enter = resolve)),
  gate = new Promise<void>((resolve) => (release = resolve));
const state = {
  enter,
  gate,
  ports: {} as Record<string, number>,
  disposed: {} as Record<string, number>,
};
(globalThis as any).__pluginSetupCleanupFixture = state;
function plugin(id: string, mode: string) {
  const dir = path.join(process.env.SWITCHBOARD_DATA_DIR!, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `import http from 'node:http'; export default async()=>{const state=globalThis.__pluginSetupCleanupFixture;const server=http.createServer((req,res)=>res.end('fixture'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));state.ports[${JSON.stringify(id + '-' + mode)}]=server.address().port;${mode === 'late' ? 'state.enter();await state.gate;' : ''}return {services:${mode === 'invalid' ? "[{id:'invalid service'}]" : '[]'},async dispose(){state.disposed[${JSON.stringify(id + '-' + mode)}]=(state.disposed[${JSON.stringify(id + '-' + mode)}]||0)+1;await new Promise(resolve=>server.close(resolve));}};};`,
  );
}
function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
after(async () => {
  release();
  await plugins.stop();
  delete (globalThis as any).__pluginSetupCleanupFixture;
  fs.rmSync(tmp, { recursive: true, force: true });
});
test('a timed-out setup disposes its eventual instance without disposing a newer reload', async (t) => {
  plugin('late', 'late');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const loading = plugins.start();
    await entered;
    const oldPort = state.ports['late-late'];
    assert.equal(await listening(oldPort), true);
    t.mock.timers.tick(15000);
    await loading;
    assert.equal(plugins.get('late').status, 'error');
    assert.match(plugins.get('late').error!, /setup timed out/);
    assert.equal(state.disposed['late-late'], undefined);
    plugin('late', 'active');
    await plugins.reload(['late']);
    assert.equal(plugins.get('late').status, 'active');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.disposed['late-late'], 1);
    assert.equal(await listening(oldPort), false);
    assert.equal(state.disposed['late-active'], undefined);
    assert.equal(await listening(state.ports['late-active']), true);
    await plugins.setEnabled('late', false);
    assert.equal(state.disposed['late-active'], 1);
  } finally {
    t.mock.timers.reset();
  }
});
test('service validation failure disposes the candidate and closes its listener', async () => {
  plugin('invalid', 'invalid');
  await plugins.reload(['invalid']);
  assert.equal(plugins.get('invalid').status, 'error');
  assert.equal(state.disposed['invalid-invalid'], 1);
  assert.equal(await listening(state.ports['invalid-invalid']), false);
});
