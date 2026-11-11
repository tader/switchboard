import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { CDP } from '../server/authentication-browser.ts';
class Child extends EventEmitter {
  stdio = [null, null, null, new PassThrough(), new PassThrough()];
  exitCode: number | null = null;
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); if (signal === 'SIGKILL') this.exit(); return true; }
  exit() { this.exitCode = 0; this.emit('exit', 0); }
}
function fixture(ignoreClose = false) {
  const child = new Child(); let args: string[] = []; let options: any;
  child.stdio[3]!.on('data', data => {
    const message = JSON.parse(data.toString().replace(/\0$/, ''));
    child.stdio[4]!.write(JSON.stringify({ id: message.id, result: { product: 'fixture' } }) + '\0');
    if (message.method === 'Browser.close' && !ignoreClose) queueMicrotask(() => child.exit());
  });
  const browser = new CDP('/fixture', '/synthetic-profile', { spawnProcess: ((exe: string, a: string[], o: any) => { args = a; options = o; return child; }) as unknown as typeof spawn });
  return { child, browser, args, options };
}
test('authentication CDP uses private pipes, bounded calls and idempotent closure', async () => {
  const f = fixture(); assert.ok(f.args.includes('--remote-debugging-pipe')); assert.ok(!f.args.some(a => /debugging-port|ws:\/\//.test(a)));
  assert.deepEqual(f.options.stdio, ['ignore','ignore','ignore','pipe','pipe']);
  assert.equal((await f.browser.call('Browser.getVersion')).product, 'fixture');
  const close = f.browser.close(); assert.equal(f.browser.close(), close); await close;
  await assert.rejects(f.browser.call('Browser.getVersion'), { code: 'browser_closed' });
});
test('an unresponsive authentication browser is terminated and reaped before closure completes', async () => {
  const f = fixture(true); await f.browser.close(); assert.deepEqual(f.child.signals, ['SIGTERM','SIGKILL']); assert.equal(f.child.exitCode, 0);
});
test('spawn failure rejects control calls and resolves exit without leaking a child', async () => {
  const f = fixture(); f.child.emit('error', new Error('synthetic launch error'));
  await assert.rejects(f.browser.call('Browser.getVersion'), { code: 'browser_closed' }); await f.browser.close(); await f.browser.exit;
});
