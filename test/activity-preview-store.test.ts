import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPreviewStore, invalidatePreviews } from '../shared/activity-preview-store.ts';
import { provisionPreviews, retirePreviewStores, validatePreviewVolumeBacking } from '../updater/activity-previews.ts';
import { atomic, type Settings } from '../updater/engine.ts';
import { withPreviewIO } from '../shared/activity-preview-io.ts';
import { canonical, assertOwnedPreviewStore } from '../shared/activity-preview-store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-store-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test('first publication resumes a verified intent and preserves unrelated entries', () => {
  const root = path.join(tmp, 'interrupted-publication'), excluded = [path.join(tmp, 'data')];
  const identity = { version: 1, instance: 'fixture-instance', location: canonical(root), storeId: '11111111-1111-1111-1111-111111111111' };
  withPreviewIO(root, true, io => io.write('writing.tmp', 'store.tmp', JSON.stringify(identity)));
  fs.writeFileSync(path.join(root, 'sentinel'), 'unrelated');
  const generation = openPreviewStore(root, excluded, identity.instance);
  assert.deepEqual(assertOwnedPreviewStore(root, excluded, identity.instance), identity);
  assert.equal(openPreviewStore(root, excluded, identity.instance), generation);
  assert.equal(fs.existsSync(path.join(root, 'store.tmp')), false);
  assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'unrelated');
  const foreign = path.join(tmp, 'foreign-intent');
  withPreviewIO(foreign, true, io => io.write('writing.tmp', 'store.tmp', JSON.stringify(identity)));
  assert.throws(() => openPreviewStore(foreign, excluded, identity.instance), /identity/);
  assert.equal(fs.existsSync(path.join(foreign, 'store.tmp')), true);
  assert.equal(fs.existsSync(path.join(foreign, 'store.json')), false);
  const unknown = path.join(tmp, 'unclaimed-partial');
  withPreviewIO(unknown, true, io => io.write('writing.tmp', 'store.tmp', ''));
  assert.throws(() => openPreviewStore(unknown, excluded, identity.instance));
  assert.deepEqual(fs.readdirSync(unknown), ['store.tmp']);
});
test('durable creation claim recovers empty and truncated first writes without adopting foreign files', async () => {
  for (const partial of [undefined, '', '{"version":1,']) {
    const stateDir = path.join(tmp, 'claim-state-' + (partial?.length ?? 'before-write')), dataDir = stateDir + '-data';
    fs.mkdirSync(stateDir); fs.mkdirSync(dataDir);
    const s: Settings = { instance: 'fixture', mode: 'runtime', stateDir, dataDir, initialRelease: path.join(tmp, 'release'), appUrl: 'http://localhost', env: {} };
    const excluded = [dataDir, stateDir, s.initialRelease!];
    const file = path.join(stateDir, 'activity-preview-control.json');
    await assert.rejects(provisionPreviews(s, s.initialRelease!, excluded, async () => '', (file, value: any) => {
      atomic(file, value);
      if (value.stores.some((v: any) => v.pending)) throw Error('Interrupted after durable claim');
    }), /durable claim/);
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    const binding = pending.stores[0], root = binding.location;
    assert.equal(binding.pending, true); assert.equal(binding.retired, true);
    if (partial !== undefined) withPreviewIO(root, false, io => io.write('writing.tmp', 'store.tmp', partial));
    fs.writeFileSync(path.join(root, 'sentinel'), 'unrelated');
    const env = await provisionPreviews(s, s.initialRelease!, excluded, async () => '', atomic);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(env.SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID, binding.storeId);
    assert.equal(env.SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH, pending.epoch);
    assert.equal(saved.stores[0].pending, undefined); assert.equal(saved.stores[0].retired, false);
    assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'unrelated');
    const retained = fs.readdirSync(root).filter(name => name.startsWith('unpublished-'));
    assert.equal(retained.length, partial === undefined ? 0 : 1);
    if (partial !== undefined) assert.equal(fs.readFileSync(path.join(root, retained[0]), 'utf8'), partial);
  }
});
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

test('ordinary Compose store switch stays closed until old-store retirement succeeds', async () => {
  const { PreviewStoreSwitchError, boundPreviewEnvironment } = await import('../updater/activity-previews.ts');
  const stateDir = path.join(tmp, 'switch-state'); fs.mkdirSync(stateDir);
  const instance = '11111111-1111-1111-1111-111111111111', epoch = '22222222-2222-2222-2222-222222222222';
  const oldId = '33333333-3333-3333-3333-333333333333', newId = '44444444-4444-4444-4444-444444444444';
  const file = path.join(stateDir, 'activity-preview-control.json');
  atomic(file, { instance, epoch, stores: [{ kind: 'compose', location: 'old', storeId: oldId, mountpoint: '/volumes/old', retired: false }] });
  const s: Settings = { instance: 'switch', dataDir: '/data', stateDir, mode: 'compose', appUrl: 'http://127.0.0.1:8770', env: {}, compose: { files: ['/fixture/compose.yaml'], directory: '/fixture', project: 'switch', service: 'app', dataVolume: 'data', stateVolume: 'state', previewVolume: 'new' } };
  let unavailable = true, oldInspections = 0;
  const operations: string[] = [];
  const run = async (_file: string, args: string[]) => {
    if (args[0] === 'volume') {
      const names = args.slice(2);
      if (names.includes('old')) { oldInspections++; if (unavailable) throw Error('old volume temporarily unavailable'); }
      return JSON.stringify(names.map(Name => ({ Name, Driver: 'local', Options: null, Mountpoint: '/volumes/' + Name })));
    }
    const operation = args.at(-2)!; operations.push(operation);
    return JSON.stringify({ storeId: operation === 'retire' ? oldId : newId });
  };
  const image = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(provisionPreviews(s, image, ['/data', '/state', '/app'], run, atomic), PreviewStoreSwitchError);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stores[0].retired, false);
  assert.equal(boundPreviewEnvironment(s, []).SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE, '0');
  assert.deepEqual(operations, []);
  unavailable = false;
  const env = await provisionPreviews(s, image, ['/data', '/state', '/app'], run, atomic);
  assert.deepEqual(operations, ['retire', 'open']);
  assert.equal(env.SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID, newId);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stores[0].retired, true);
  unavailable = true; // Already retired volumes need not be mounted on every healthy restart.
  await provisionPreviews(s, image, ['/data', '/state', '/app'], run, atomic);
  assert.equal(oldInspections, 2);
});

test('removing the last Compose store retires live history and retains failure for retry', async () => {
  const { PreviewStoreSwitchError, hasRetiredPreviewStores } = await import('../updater/activity-previews.ts');
  const stateDir = path.join(tmp, 'detach-state'); fs.mkdirSync(stateDir);
  const file = path.join(stateDir, 'activity-preview-control.json');
  atomic(file, { instance: '11111111-1111-1111-1111-111111111111', epoch: '22222222-2222-2222-2222-222222222222', stores: [{ kind: 'compose', location: 'old', storeId: '33333333-3333-3333-3333-333333333333', mountpoint: '/volumes/old', retired: false }] });
  const s: Settings = { instance: 'detach', dataDir: '/data', stateDir, mode: 'compose', appUrl: 'http://127.0.0.1:8770', env: {}, compose: { files: ['/fixture/compose.yaml'], directory: '/fixture', project: 'detach', service: 'app', dataVolume: 'data', stateVolume: 'state' } };
  let unavailable = true;
  const calls: string[] = [];
  const run = async (_file: string, args: string[]) => {
    calls.push(args[0]);
    if (unavailable) throw Error('old volume unavailable');
    return args[0] === 'volume' ? JSON.stringify([{ Name: 'old', Driver: 'local', Options: null, Mountpoint: '/volumes/old' }]) : '{}';
  };
  const image = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(provisionPreviews(s, image, ['/data', '/state', '/app'], run, atomic), PreviewStoreSwitchError);
  assert.equal(hasRetiredPreviewStores(s), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stores[0].retired, false);
  unavailable = false;
  assert.deepEqual(await provisionPreviews(s, image, ['/data', '/state', '/app'], run, atomic), {});
  assert.deepEqual(calls, ['volume', 'volume', 'run']);
  assert.equal(hasRetiredPreviewStores(s), true);
  await provisionPreviews(s, image, ['/data', '/state', '/app'], async () => { throw Error('retired stores need not be available'); }, atomic);
});

test('fresh Compose startup without a store does not require storage or claim deletion', async () => {
  const { hasRetiredPreviewStores } = await import('../updater/activity-previews.ts');
  const stateDir = path.join(tmp, 'fresh-no-store'); fs.mkdirSync(stateDir);
  const s: Settings = { instance: 'fresh', dataDir: '/data', stateDir, mode: 'compose', appUrl: 'http://127.0.0.1:8770', env: {}, compose: { files: ['/fixture/compose.yaml'], directory: '/fixture', project: 'fresh', service: 'app' } };
  assert.deepEqual(await provisionPreviews(s, 'sha256:' + 'a'.repeat(64), ['/data', '/state', '/app'], async () => { throw Error('no Docker storage operations expected'); }, atomic), {});
  assert.equal(hasRetiredPreviewStores(s), false);
});
