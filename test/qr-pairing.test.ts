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
fs.writeFileSync(path.join(fixture, 'index.js'), "export default ctx => ({services:[{id:'qr-fixture',name:'QR fixture',baseUrl:'https://example.com',authMethods:[{id:'test',name:'Test',authorize(){},fields:[{key:'kind',label:'Kind'}],connect({config}){if(!ctx.capabilities?.deviceQr)throw Error('missing capability');return{device:config.kind==='code'?{userCode:'TEST-CODE',verificationUri:'https://example.com/link',interval:2}:config.kind==='bad'?{qrCode:'x'.repeat(4097)}:{qrCode:'sgnl://linkdevice?uuid=fixture&pub_key=fixture',instructions:'Scan this fixture',expiresIn:150,interval:3},pending:{ok:true}}},poll(){return{credentials:{fixture:true},account:{id:'fixture',label:'Fixture'}}}}]}]});");
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
  } finally {
    await plugins.stop(); database.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
