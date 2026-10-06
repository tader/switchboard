import test from 'node:test';
import assert from 'node:assert/strict';
import { pageResult, pagination, reminderFilters } from '../plugins/apple-reminders/index.ts';

test('Apple Reminders pagination tokens continue only the same filtered query', () => {
  const firstUrl = new URL('http://localhost/reminders?hideCompleted=true&due=today&pageSize=2');
  const first = pagination(firstUrl);
  assert.deepEqual({ limit: first.limit, offset: first.offset }, { limit: 2, offset: 0 });
  const result = pageResult({ items: [{ id: 'a' }, { id: 'b' }], nextOffset: 2 }, first.fingerprint);
  assert.equal(result.items.length, 2);
  assert.ok(result.nextToken);

  const next = pagination(new URL(`http://localhost/reminders?due=today&pageSize=2&hideCompleted=true&nextToken=${result.nextToken}`));
  assert.equal(next.offset, 2);
  assert.throws(
    () => pagination(new URL(`http://localhost/reminders?due=overdue&pageSize=2&hideCompleted=true&nextToken=${result.nextToken}`)),
    /different query/,
  );
});

test('Apple Reminders pagination enforces the 100-item maximum', () => {
  assert.equal(pagination(new URL('http://localhost/lists')).limit, 100);
  assert.throws(() => pagination(new URL('http://localhost/lists?pageSize=101')), /between 1 and 100/);
  assert.throws(() => pagination(new URL('http://localhost/lists?pageSize=0')), /between 1 and 100/);
});

test('Apple Reminders parses simple status and date filters', () => {
  const filters = reminderFilters(new URL('http://localhost/reminders?hideCompleted=true&due=overdue&dueDateLte=2026-10-06T12%3A00%3A00Z&completionDateGt=2026-01-01T00%3A00%3A00Z'));
  assert.deepEqual(filters, {
    listId: undefined,
    hideCompleted: true,
    due: 'overdue',
    dueDateLte: '2026-10-06T12:00:00Z',
    completionDateGt: '2026-01-01T00:00:00Z',
  });
  assert.throws(() => reminderFilters(new URL('http://localhost/reminders?hideCompleted=yes')), /true or false/);
  assert.throws(() => reminderFilters(new URL('http://localhost/reminders?due=eventually')), /overdue/);
});
