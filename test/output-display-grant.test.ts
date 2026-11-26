import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptDisplayGrant, displayGrantActive } from '../web/src/components/output-display-grant.ts';

const sent = { monotonic: 100, wall: 1000 };
const original = acceptDisplayGrant(undefined, sent, 15_000, { monotonic: 200, wall: 1100 })!;
test('renewal arriving first on resume cannot revive a lapsed grant', () => {
  // No timer or animation-frame callback runs before this deferred network callback.
  const renewalSent = { monotonic: 14_000, wall: 14_900 };
  const resumed = { monotonic: 15_100, wall: 16_000 };
  assert.equal(acceptDisplayGrant(original, renewalSent, 15_000, resumed), undefined);
  assert.equal(displayGrantActive(original, resumed), false);
  // Only an explicit reveal (no retained previous grant) starts another display.
  assert.ok(acceptDisplayGrant(undefined, resumed, 15_000, resumed));
});
test('either clock can independently expire display before renewal runs', () => {
  assert.equal(acceptDisplayGrant(original, { monotonic: 5000, wall: 5900 }, 15_000, { monotonic: 15_101, wall: 6000 }), undefined);
  assert.equal(acceptDisplayGrant(original, { monotonic: 5000, wall: 5900 }, 15_000, { monotonic: 5100, wall: 16_001 }), undefined);
});
test('valid renewals remain bounded by request send, not response receipt', () => {
  assert.deepEqual(acceptDisplayGrant(original, { monotonic: 5000, wall: 5900 }, 30_000, { monotonic: 9000, wall: 9900 }), { monotonic: 20_000, wall: 20_900 });
  assert.equal(acceptDisplayGrant(undefined, sent, 100, { monotonic: 200, wall: 1100 }), undefined);
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(acceptDisplayGrant(undefined, sent, duration, sent), undefined);
});
