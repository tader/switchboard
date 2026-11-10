import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remembersUpdates, rememberUpdates, planWithRememberedAccess } from '../web/src/plugin-update.ts';

test('remember successful update choice and clear it after a failure', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) };
  assert.equal(remembersUpdates(storage), false);
  rememberUpdates(true, storage); assert.equal(remembersUpdates(storage), true);
  rememberUpdates(false, storage); assert.equal(remembersUpdates(storage), false);
});

test('remembered access prepares a plan for review without applying it', async () => {
  const plugins = [{ id: 'one' }, { id: 'two' }] as any;
  const calls: { path: string; body: unknown }[] = [];
  const request = async (path: string, options: {body: unknown}) => {
    calls.push({path, body: options.body});
    return { planId: 'plan', requiresReview: false } as any;
  };
  assert.deepEqual(await planWithRememberedAccess(plugins, request), { planId:'plan', requiresReview:false });
  assert.deepEqual(calls, [{ path: '/admin/plugins/update/plan', body: { updates: [{ id: 'one' }, { id: 'two' }] } }]);
  await assert.rejects(planWithRememberedAccess(plugins, async () => { throw new Error('access failed'); }), /access failed/);
});
