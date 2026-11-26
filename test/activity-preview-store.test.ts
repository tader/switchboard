import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPreviewStore, invalidatePreviews } from '../shared/activity-preview-store.ts';
import { provisionPreviews, retirePreviewStores, validatePreviewVolumeBacking } from '../updater/activity-previews.ts';
import { atomic, type Settings } from '../updater/engine.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-store-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test('unrecognized nonempty roots survive open and retirement without adoption', () => {
  const root = path.join(tmp, 'unrecognized'); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'sentinel'), 'unrelated');
  assert.throws(() => openPreviewStore(root, [path.join(tmp, 'data')], 'instance'), /nonempty/);
  assert.throws(() => invalidatePreviews(root, [path.join(tmp, 'data')], 'instance'), /nonempty/);
  assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'unrelated');
  assert.deepEqual(fs.readdirSync(root), ['sentinel']);
});
test('verified retirement removes only owned regular files and rejects relocation or another instance', () => {
  const root = path.join(tmp, 'owned'), excluded = [path.join(tmp, 'data')];
  openPreviewStore(root, excluded, 'instance');
  fs.writeFileSync(path.join(root, 'sentinel'), 'unrelated');
  fs.mkdirSync(path.join(root, 'unrelated-directory'));
  const name = 'preview-' + JSON.parse(fs.readFileSync(path.join(root, 'store.json'), 'utf8')).storeId + '-12345678-1234-1234-1234-123456789abc.enc';
  fs.writeFileSync(path.join(root, name), 'owned');
  assert.throws(() => invalidatePreviews(root, excluded, 'other-instance'), /identity/);
  assert.ok(fs.existsSync(path.join(root, name)));
  invalidatePreviews(root, excluded, 'instance');
  assert.ok(!fs.existsSync(path.join(root, name)));
  assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'unrelated');
  assert.ok(fs.statSync(path.join(root, 'unrelated-directory')).isDirectory());
  const moved = root + '-moved'; fs.renameSync(root, moved);
  assert.throws(() => openPreviewStore(moved, excluded, 'instance'), /identity/);
  assert.equal(fs.readFileSync(path.join(moved, 'sentinel'), 'utf8'), 'unrelated');
});
test('independent restore fence advances even after current storage configuration is removed', async () => {
  const dataDir = path.join(tmp, 'history-data'), stateDir = path.join(tmp, 'history-state');
  fs.mkdirSync(dataDir); fs.mkdirSync(stateDir);
  const s: Settings = { instance: 'history', dataDir, stateDir, mode: 'checkout', initialRelease: '/synthetic/source', appUrl: 'http://127.0.0.1:8770', env: {} };
  const excluded = [dataDir, stateDir, '/synthetic/source'];
  const env = await provisionPreviews(s, '/synthetic/source', excluded, async () => '', atomic);
  const name = 'preview-' + env.SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID + '-12345678-1234-1234-1234-123456789abc.enc';
  fs.writeFileSync(path.join(env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT, name), 'owned');
  const before = JSON.parse(fs.readFileSync(path.join(stateDir, 'activity-preview-control.json'), 'utf8'));
  // Changed settings do not erase the durable store history.
  s.mode = 'runtime';
  await retirePreviewStores(s, undefined, excluded, async () => '', atomic);
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'activity-preview-control.json'), 'utf8'));
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.instance, before.instance);
  assert.ok(!fs.existsSync(path.join(env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT, name)));
  fs.rmSync(env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT, { recursive: true, force: true });
});
test('volume inspection rejects aliasing, nested mountpoints and ambiguous driver options', () => {
  const volume = (Name: string, Mountpoint: string, Options: any = null) => ({ Name, Mountpoint, Driver: 'local', Options });
  validatePreviewVolumeBacking([volume('preview', '/volumes/p'), volume('data', '/volumes/d'), volume('state', '/volumes/s')]);
  assert.throws(() => validatePreviewVolumeBacking([volume('p', '/volumes/p'), volume('d', '/volumes/p')]), /overlaps/);
  assert.throws(() => validatePreviewVolumeBacking([volume('p', '/volumes/p'), volume('d', '/volumes/p/data')]), /overlaps/);
  assert.throws(() => validatePreviewVolumeBacking([volume('p', '/volumes/p', { type: 'none', o: 'bind', device: '/managed-data' })]), /driver options/);
});
