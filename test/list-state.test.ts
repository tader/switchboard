import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch, resolveView, sortRows } from '../web/src/list-state.ts';

const defaults = { q: '', status: '', sort: 'time', order: 'desc', offset: '0', live: 'false' };
test('view restoration preserves filters and Live without restoring pagination or unrelated fields', () => {
  assert.deepEqual(resolveView(defaults, { q: 'error', status: '500', live: 'true', offset: '50', secret: 'ignored' }, new URLSearchParams(), ['offset']), { ...defaults, q: 'error', status: '500', live: 'true' });
  assert.deepEqual(resolveView(defaults, { q: 42, live: true, sort: null }, new URLSearchParams()), defaults);
  assert.deepEqual(resolveView(defaults, null, new URLSearchParams('unrelated=value')), defaults);
});
test('explicit filtered links override remembered filters rather than combining with them', () => {
  assert.deepEqual(resolveView(defaults, { q: 'old query', status: '500', live: 'true' }, new URLSearchParams('status=200')), { ...defaults, status: '200' });
  assert.deepEqual(resolveView(defaults, { q: 'old query' }, new URLSearchParams('q=&offset=50'), ['offset']), { ...defaults, offset: '50' });
});
test('sorting uses numbers, natural names and stable ids, with missing dates last in either direction', () => {
  const rows = [{ id: 'b', name: 'Item 10', used: null }, { id: 'c', name: 'Item 2', used: 10 }, { id: 'a', name: 'Item 2', used: 10 }, { id: 'd', name: 'Item 1', used: 2 }];
  assert.deepEqual(sortRows(rows, r => r.name, 'asc').map(r => r.id), ['d', 'a', 'c', 'b']);
  assert.deepEqual(sortRows(rows, r => r.used, 'desc').map(r => r.id), ['a', 'c', 'd', 'b']);
  assert.deepEqual(sortRows(rows, r => r.used, 'asc').map(r => r.id), ['d', 'a', 'c', 'b']);
  assert.deepEqual(rows.map(r => r.id), ['b', 'c', 'a', 'd']);
});
test('search combines words across fields and handles missing values', () => {
  assert.equal(matchesSearch('  GITHUB work ', 'Work account', null, 'GitHub'), true);
  assert.equal(matchesSearch('github home', 'Work account', 'GitHub'), false);
  assert.equal(matchesSearch(' ', null), true);
});
