import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

test('native Windows preview store verifies objects and keeps operations bound to handles', { skip: process.platform !== 'win32' }, async () => {
  const runtime = path.resolve(process.env.SWITCHBOARD_TEST_RUNTIME ?? import.meta.dirname + '/..');
  const m = await import(pathToFileURL(path.join(runtime, 'shared/activity-preview-store.ts')).href);
  const { withPreviewIO } = await import(pathToFileURL(path.join(runtime, 'shared/activity-preview-io.ts')).href);
  const adapter = createRequire(import.meta.url)(path.join(runtime, 'native/activity-preview-store/build/Release/preview_store.node'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-ntfs-'));
  const parent = path.join(base, 'parent'); fs.mkdirSync(parent);
  const root = path.join(parent, 'previews'), excluded = [path.join(base, 'data'), path.join(base, 'state'), runtime];
  const instance = '11111111-1111-1111-1111-111111111111';
  const ps = (file: string, code: string) => execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';$p=$env:PREVIEW_TEST_PATH;" + code], { env: { ...process.env, PREVIEW_TEST_PATH: file }, encoding: 'utf8' }).trim();
  const acl = (file: string) => ps(file, '(Get-Acl -LiteralPath $p).Sddl');
  const restore = (file: string, sddl: string) => ps(file, `$a=Get-Acl -LiteralPath $p;$a.SetSecurityDescriptorSddlForm('${sddl}');Set-Acl -LiteralPath $p -AclObject $a`);
  const broaden = (file: string) => ps(file, "$a=Get-Acl -LiteralPath $p;$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));Set-Acl -LiteralPath $p -AclObject $a");
  try {
    const pendingRoot = path.join(parent, 'pending');
    const pending = { version: 1, instance, location: m.canonical(pendingRoot), storeId: '33333333-3333-3333-3333-333333333333' };
    withPreviewIO(pendingRoot, true, (io: any) => io.write('writing.tmp', 'store.tmp', JSON.stringify(pending)));
    fs.writeFileSync(path.join(pendingRoot, 'sentinel'), 'unrelated');
    const pendingAcl = acl(path.join(pendingRoot, 'store.tmp'));
    broaden(path.join(pendingRoot, 'store.tmp'));
    assert.throws(() => m.openPreviewStore(pendingRoot, excluded, instance));
    restore(path.join(pendingRoot, 'store.tmp'), pendingAcl);
    m.openPreviewStore(pendingRoot, excluded, instance);
    assert.deepEqual(m.assertOwnedPreviewStore(pendingRoot, excluded, instance), pending);
    assert.equal(fs.readFileSync(path.join(pendingRoot, 'sentinel'), 'utf8'), 'unrelated');
    assert.equal(fs.existsSync(path.join(pendingRoot, 'store.tmp')), false);
    for (const partial of [undefined, '', '{"version":1,']) {
      const interrupted = path.join(parent, 'partial-' + (partial?.length ?? 'before-write'));
      let claimed: any;
      assert.throws(() => m.openPreviewStore(interrupted, excluded, instance, { claim: (identity: any) => { claimed = identity; throw Error('simulated interruption'); } }), /simulated interruption/);
      if (partial !== undefined) withPreviewIO(interrupted, false, (io: any) => io.write('writing.tmp', 'store.tmp', partial));
      fs.writeFileSync(path.join(interrupted, 'sentinel'), 'unrelated');
      m.openPreviewStore(interrupted, excluded, instance, { storeId: claimed.storeId });
      assert.equal(m.assertOwnedPreviewStore(interrupted, excluded, instance).storeId, claimed.storeId);
      assert.equal(fs.readFileSync(path.join(interrupted, 'sentinel'), 'utf8'), 'unrelated');
      const retained = fs.readdirSync(interrupted).filter(name => name.startsWith('unpublished-'));
      assert.equal(retained.length, partial === undefined ? 0 : 1);
      if (partial !== undefined) assert.equal(fs.readFileSync(path.join(interrupted, retained[0]), 'utf8'), partial);
    }
    const generation = m.openPreviewStore(root, excluded, instance);
    const identity = m.assertOwnedPreviewStore(root, excluded, instance);
    const name = `preview-${identity.storeId}-22222222-2222-2222-2222-222222222222.enc`;
    const write = () => m.writePreviewFile(root, name, 'synthetic-ciphertext', excluded, instance, identity.storeId);
    const read = () => m.readPreviewFile(root, name, excluded, instance, identity.storeId, 65536);
    write(); assert.equal(read(), 'synthetic-ciphertext');
    assert.equal(m.openPreviewStore(root, excluded, instance), generation);
    assert.throws(() => m.readPreviewFile(root, name, excluded, instance, 'wrong-store', 65536));
    assert.throws(() => m.readPreviewFile(root, name, excluded, instance, identity.storeId, 2));
    fs.writeFileSync(path.join(root, 'sentinel'), 'unrelated');
    const file = path.join(root, name), originalFileAcl = acl(file), originalRootAcl = acl(root);
    broaden(file); assert.throws(read); assert.throws(() => m.removePreviewFile(root, name, excluded, instance)); restore(file, originalFileAcl);
    broaden(root); assert.throws(() => m.openPreviewStore(root, excluded, instance)); restore(root, originalRootAcl);
    // The runner is an elevated local administrator. Do not skip a failed owner fixture.
    ps(root, "$a=Get-Acl -LiteralPath $p;$a.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));Set-Acl -LiteralPath $p -AclObject $a");
    assert.throws(() => m.assertOwnedPreviewStore(root, excluded, instance)); restore(root, originalRootAcl);
    const handle = adapter.open(root, false);
    try { assert.throws(() => fs.renameSync(parent, parent + '-swapped')); } finally { adapter.close(handle); }
    const linked = path.join(base, 'linked.enc'); fs.linkSync(file, linked);
    assert.throws(read); fs.unlinkSync(linked); assert.equal(read(), 'synthetic-ciphertext');
    const junction = path.join(base, 'junction');
    ps(junction, `$null=New-Item -ItemType Junction -Path $p -Target '${parent.replaceAll("'", "''")}'`);
    assert.throws(() => m.openPreviewStore(path.join(junction, 'previews'), excluded, instance));
    fs.rmdirSync(junction);
    // A recognized directory/reparse entry must keep retirement closed for retry.
    m.removePreviewFile(root, name, excluded, instance);
    ps(file, `$null=New-Item -ItemType Junction -Path $p -Target '${base.replaceAll("'", "''")}'`);
    assert.throws(() => m.invalidatePreviews(root, excluded, instance));
    assert.equal(m.previewGeneration(root, excluded, instance).retiring, true);
    fs.rmdirSync(file);
    m.openPreviewStore(root, excluded, instance); write();
    assert.notEqual(m.invalidatePreviews(root, excluded, instance), generation);
    assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'unrelated');
    write(); assert.equal(read(), 'synthetic-ciphertext');
    const marker = path.join(root, 'store.json'), markerAcl = acl(marker);
    broaden(marker); assert.throws(read); restore(marker, markerAcl);
    // Use the real server capture/reveal path with a saved nondefault retention.
    fs.mkdirSync(excluded[0]);
    Object.assign(process.env, { SWITCHBOARD_DATA_DIR: excluded[0], SWITCHBOARD_ACTIVITY_PREVIEW_ROOT: root,
      SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE: instance, SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID: identity.storeId,
      SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH: 'synthetic-epoch', SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '1' });
    const imp = (file: string) => import(pathToFileURL(path.join(runtime, file)).href);
    const database = await imp('server/db.ts'); database.initDb();
    try {
      (await imp('server/crypto.ts')).initKey();
      const owner = (await imp('server/users.ts')).createUser('synthetic-owner', 'admin');
      const outputs = await imp('server/activity-output.ts');
      const audit = await imp('server/audit.ts');
      outputs.initOutputStore(); outputs.setOutputRetention(9);
      assert.deepEqual(outputs.outputCaptureAvailability(), { available: true, reason: 'ready' });
      const capture = async () => {
        const id = audit.record({ userId: owner.id, caller: { source: 'proxy', tokenId: null, tokenName: null, ip: null, userAgent: null }, method: 'GET', url: 'https://api.example.test/profile', status: 200 });
        await outputs.observeOutput(Response.json({ account_id: 'demo-account' }), id, owner.id, { fields: { account_id: { maxBytes: 128 } } }, []).text();
        return id;
      };
      const captured = await capture();
      assert.deepEqual(outputs.readOutput(owner.id, captured, true).preview, { account_id: 'demo-account' });
      outputs.initOutputStore(); assert.equal(outputs.outputPolicy().hours, 9);
      assert.deepEqual(outputs.readOutput(owner.id, captured, true).preview, { account_id: 'demo-account' });
      m.invalidatePreviews(root, excluded, instance); outputs.initOutputStore();
      assert.equal(outputs.readOutput(owner.id, captured, true).state, 'unavailable');
      assert.deepEqual(outputs.readOutput(owner.id, await capture(), true).preview, { account_id: 'demo-account' });
      broaden(root); outputs.initOutputStore(); assert.equal(outputs.outputCaptureAvailability().available, false); restore(root, originalRootAcl);
      outputs.initOutputStore(); assert.equal(outputs.outputCaptureAvailability().available, true);
    } finally { database.db.close(); }
    const unowned = path.join(base, 'unowned'); fs.mkdirSync(unowned); fs.writeFileSync(path.join(unowned, 'sentinel'), 'unrelated');
    assert.throws(() => m.openPreviewStore(unowned, excluded, instance));
    assert.equal(fs.readFileSync(path.join(unowned, 'sentinel'), 'utf8'), 'unrelated');
    console.log(`Verified ${process.arch}: private creation, restart, binding, owner, DACL, ancestor pinning, hardlinks, reparse points, interrupted retirement, sentinel preservation, fresh capture`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
