import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BrowserProfileLock } from '../server/browser-profile-lock.ts';

test('browser profile operations serialize independently and recover after errors', async () => {
  const lock = new BrowserProfileLock();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = lock.run('a', undefined, async () => { events.push('first'); await gate; throw new Error('failed'); });
  const second = lock.run('a', undefined, async () => { events.push('second'); });
  await lock.run('b', undefined, async () => { events.push('other'); });
  assert.deepEqual(events, ['first', 'other']);
  release();
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(events, ['first', 'other', 'second']);
});

test('cancelled waiters do not run or block later operations', async () => {
  const lock = new BrowserProfileLock();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = lock.run('a', undefined, async () => gate);
  const controller = new AbortController();
  const cancelled = lock.run('a', controller.signal, async () => assert.fail('must not run'));
  const last = lock.run('a', undefined, async () => 'done');
  controller.abort();
  release();
  await first;
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(await last, 'done');
});

test('a cancelled final waiter cannot remove a still occupied profile lock', async () => {
  const lock = new BrowserProfileLock();
  let release!: () => void;
  const held = lock.run('a', undefined, () => new Promise<void>(r => { release = r; }));
  await Promise.resolve();
  const abort = new AbortController();
  const cancelled = lock.run('a', abort.signal, async () => assert.fail('cancelled'));
  abort.abort(); await assert.rejects(cancelled);
  let ran = false;
  const later = lock.run('a', undefined, async () => { ran = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(ran, false);
  release(); await held; await later; assert.equal(ran, true);
});
