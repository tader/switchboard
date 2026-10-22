import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-qr-'));
process.env.SWITCHBOARD_DATA_DIR = dir;
process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
const fixture = path.join(dir, 'plugins/qr-fixture');
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, 'plugin.json'), JSON.stringify({ id: 'qr-fixture', name: 'QR fixture', version: '1.0.0' }));
fs.writeFileSync(path.join(fixture, 'index.js'), `
export default ctx => ({services:[{id:'qr-fixture',name:'QR fixture',baseUrl:'https://example.com',authMethods:[{
  id:'test',name:'Test',authorize(){},fields:[{key:'kind',label:'Kind'}],
  connect({config}) {
    if (!ctx.capabilities?.deviceQr || !ctx.capabilities?.deviceUpdates || !ctx.capabilities?.deviceBrowser) throw Error('missing capability');
    const kind = config.kind;
    let device = {qrCode:'sgnl://linkdevice?uuid=fixture&pub_key=fixture',instructions:'Scan this fixture',expiresIn:150,interval:3};
    if (kind === 'code') device = {userCode:'TEST-CODE',verificationUri:'https://example.com/link',interval:2};
    if (kind === 'browser') device = {browser:true,instructions:'Complete sign-in in the browser that opens automatically.',expiresIn:600,interval:3};
    if (kind === 'bad') device = {qrCode:'x'.repeat(4097)};
    if (kind === 'mixed') device = {qrCode:'fixture',browser:true,instructions:'mixed'};
    if (kind === 'bad-browser') device = {browser:true,instructions:''};
    if (kind === 'bad-qr-expiry') device = {qrCode:'fixture',qrExpiresAt:'tomorrow'};
    return {device,pending:{kind,stage:0}};
  },
  async poll({pending}) {
    if (pending.kind === 'slow') await new Promise(resolve => setTimeout(resolve, 40));
    if (pending.stage === 0 && ['rotate','invalid-update','browser'].includes(pending.kind)) {
      return {wait:true,pending:{...pending,stage:1},device:pending.kind === 'invalid-update'
        ? {qrCode:'next',userCode:'mixed',verificationUri:'https://example.com'}
        : pending.kind === 'browser' ? {browser:true,instructions:'Still signing in',interval:3}
        : {qrCode:'rotated-fixture',qrExpiresAt:Date.now()+20000,interval:3}};
    }
    return {credentials:{fixture:true},account:{id:'fixture',label:'Fixture'}};
  }
}]}]});
`);
const { initKey } = await import('../server/crypto.ts');
const database = await import('../server/db.ts');
initKey(); database.initDb();
const { plugins } = await import('../server/plugins/manager.ts');
const { createUser } = await import('../server/users.ts');
const { startConnect, pollDevice, cancelFlow } = await import('../server/connections.ts');
const user = createUser('qr-fixture', 'admin');
test('QR pairing uses owner-scoped device polling, cancellation and expiry; code pairing remains compatible', async () => {
  try {
    await plugins.start();
    const begin = (kind: string) => startConnect(user, { service: 'qr-fixture', method: 'test', config: { kind } });
    const qr = await begin('qr');
    assert.equal(qr.status, 'device');
    if (qr.status !== 'device') throw Error('Expected device');
    assert.equal(qr.device.qrCode, 'sgnl://linkdevice?uuid=fixture&pub_key=fixture');
    assert.equal(qr.device.interval, 3);
    assert.equal(qr.device.userCode, undefined);
    const other = createUser('other', 'user');
    await assert.rejects(() => pollDevice(qr.flowId, other));
    assert.equal((await pollDevice(qr.flowId, user)).status, 'connected');
    const code = await begin('code');
    if (code.status !== 'device') throw Error('Expected device');
    assert.equal(code.device.userCode, 'TEST-CODE');
    assert.equal(code.device.verificationUri, 'https://example.com/link');
    cancelFlow(code.flowId, user);
    await assert.rejects(() => pollDevice(code.flowId, user));
    const expired = await begin('qr');
    if (expired.status !== 'device') throw Error('Expected device');
    database.run('UPDATE connect_flows SET expires_at=0 WHERE id=?', expired.flowId);
    await assert.rejects(() => pollDevice(expired.flowId, user));
    await assert.rejects(() => begin('bad'), /Invalid QR pairing data/);
    for (const kind of ['mixed', 'bad-browser', 'bad-qr-expiry']) await assert.rejects(() => begin(kind), /Invalid/);
    const browser = await begin('browser');
    if (browser.status !== 'device') throw Error('Expected browser presentation');
    assert.equal(browser.device.browser, true);
    assert.equal(browser.device.userCode, undefined);
    assert.equal(browser.device.verificationUri, undefined);
    const waiting = await pollDevice(browser.flowId, user);
    assert.equal(waiting.status, 'pending');
    if (waiting.status !== 'pending') throw Error('Expected pending browser sign-in');
    assert.equal(waiting.device?.browser, true);
    assert.equal((await pollDevice(browser.flowId, user)).status, 'connected');

    const rotating = await begin('rotate');
    if (rotating.status !== 'device') throw Error('Expected QR flow');
    const deadline = database.one('SELECT expires_at FROM connect_flows WHERE id=?', rotating.flowId).expires_at;
    const update = await pollDevice(rotating.flowId, user);
    if (update.status !== 'pending') throw Error('Expected rotating QR');
    assert.equal(update.device?.qrCode, 'rotated-fixture');
    assert.ok(update.device!.qrExpiresAt! > Date.now());
    assert.equal(database.one('SELECT expires_at FROM connect_flows WHERE id=?', rotating.flowId).expires_at, deadline);
    assert.equal((await pollDevice(rotating.flowId, user)).status, 'connected');

    const cancelled = await begin('rotate');
    if (cancelled.status !== 'device') throw Error('Expected QR flow');
    cancelFlow(cancelled.flowId, other);
    assert.equal((await pollDevice(cancelled.flowId, user)).status, 'pending');
    cancelFlow(cancelled.flowId, user);
    await assert.rejects(() => pollDevice(cancelled.flowId, user));

    const slow = await begin('slow');
    if (slow.status !== 'device') throw Error('Expected cancellable QR flow');
    const inFlight = pollDevice(slow.flowId, user);
    cancelFlow(slow.flowId, user);
    await assert.rejects(inFlight);

    const timedOut = await begin('slow');
    if (timedOut.status !== 'device') throw Error('Expected expiring QR flow');
    const late = pollDevice(timedOut.flowId, user);
    database.run('UPDATE connect_flows SET expires_at=0 WHERE id=?', timedOut.flowId);
    await assert.rejects(late);

    const invalid = await begin('invalid-update');
    if (invalid.status !== 'device') throw Error('Expected QR flow');
    await assert.rejects(() => pollDevice(invalid.flowId, user), /Invalid QR pairing data/);
    await assert.rejects(() => pollDevice(invalid.flowId, user));

  } finally {
    await plugins.stop(); database.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
