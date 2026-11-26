import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { backup } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-output-'));
process.env.SWITCHBOARD_DATA_DIR = path.join(tmp, 'data');
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT = path.join(tmp, 'outputs');
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE = '1';
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE = 'synthetic-instance';
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH = 'synthetic-epoch';
process.env.SWITCHBOARD_AUDIT_RETENTION_DAYS = '0';
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR);
const { initDb, run, one, all } = await import('../server/db.ts');
const { initKey, encrypt, decrypt } = await import('../server/crypto.ts');
initDb(); initKey();
const { db } = await import('../server/db.ts');
const output = await import('../server/activity-output.ts');
const { record, getAudit, queryAudit, prune } = await import('../server/audit.ts');
const { createUser, createSession, createToken } = await import('../server/users.ts');
const { api } = await import('../server/routes/connections.ts');
const { admin } = await import('../server/routes/admin.ts');
const { HttpError } = await import('../server/http.ts');
const { invalidatePreviews, openPreviewStore, assertPreviewIsolation } = await import('../shared/activity-preview-store.ts');
const owner = createUser('preview-owner', 'admin'), other = createUser('preview-other', 'user');
const root = process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT!;
openPreviewStore(root, [process.env.SWITCHBOARD_DATA_DIR!], 'synthetic-instance');
const { config: testConfig } = await import('../server/config.ts');
testConfig.previewStoreId = JSON.parse(fs.readFileSync(path.join(root, 'store.json'), 'utf8')).storeId;
const rule = { origin: 'https://api.example.test', method: 'GET' as const, path: '/profile', authMethods: ['user'], fields: { account_id: { maxBytes: 128 } } };
const caller = { source: 'proxy' as const, tokenId: null, tokenName: null, ip: null, userAgent: null };
const realNow = Date.now;
let time = 2_000_000_000_000;
const app = new Hono();
app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status as any : 500));
app.route('/api', api); app.route('/api/admin', admin);
const idFor = (user = owner, extras = {}) => record({ userId: user.id, caller, method: 'GET', url: rule.origin + rule.path, status: 200, ...extras });
const files = () => fs.readdirSync(root).filter(n => n.endsWith('.enc'));
async function capture(body = '{"account_id":"demo-account","email":"private@example.test","nested":{"token":"synthetic-secret"}}', options: { status?: number; type?: string; rule?: typeof rule | null; secrets?: string[]; id?: number } = {}) {
  const id = options.id ?? idFor();
  const response = new Response(body, { status: options.status ?? 200, headers: { 'content-type': options.type ?? 'application/json' } });
  const wrapped = output.observeOutput(response, id, owner.id, options.rule === null ? undefined : options.rule ?? rule, options.secrets ?? ['synthetic-secret']);
  assert.equal(await wrapped.text(), body);
  assert.equal(wrapped.status, options.status ?? 200);
  return id;
}
beforeEach(() => {
  Date.now = () => time;
  time = 2_000_000_000_000;
  run('DELETE FROM audit_log');
  output.initOutputStore(); output.setOutputRetention(4); output.sweepOutputs();
});
after(() => { Date.now = realNow; db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('four-hour default, exact deadline before cleanup, independent unlimited request retention', async () => {
  run("DELETE FROM instance_settings WHERE key = 'activity-output-retention'");
  assert.equal(output.outputPolicy().hours, 4);
  const id = await capture();
  const row = one('SELECT * FROM audit_outputs WHERE audit_id = ?', id);
  assert.equal(row.expires_at, time + 4 * 3600_000);
  const shown = output.readOutput(owner.id, id, true);
  assert.deepEqual(shown.preview, { account_id: 'demo-account' });
  assert.equal(shown.displayForMs, 15_000);
  assert.ok(!('preview' in output.readOutput(owner.id, id, false)));
  time = row.expires_at - 1;
  assert.equal(output.readOutput(owner.id, id, true).displayForMs, 1);
  time++;
  assert.equal(output.readOutput(owner.id, id, true).state, 'expired');
  assert.equal(files().length, 1); // read deadline precedes the sweeper
  output.sweepOutputs(); prune();
  assert.equal(files().length, 0);
  assert.equal(one('SELECT 1 FROM audit_outputs'), undefined);
  assert.ok(one('SELECT 1 FROM audit_log WHERE id = ?', id));
});
test('custom one-hour deadline, shortening, increases and disable/re-enable never revive', async () => {
  output.setOutputRetention(1);
  const first = await capture();
  const at = time;
  time += 3600_000 - 1;
  assert.equal(output.readOutput(owner.id, first, true).state, 'retained');
  time++;
  assert.equal(output.readOutput(owner.id, first, true).state, 'expired');
  assert.ok(one('SELECT 1 FROM audit_outputs'));
  output.setOutputRetention(4);
  const second = await capture();
  time += 30 * 60_000;
  output.setOutputRetention(1);
  assert.equal(one('SELECT expires_at FROM audit_outputs WHERE audit_id = ?', second).expires_at, at + 2 * 3600_000);
  output.setOutputRetention(8);
  assert.equal(one('SELECT expires_at FROM audit_outputs WHERE audit_id = ?', second).expires_at, at + 2 * 3600_000);
  output.setOutputRetention(0);
  assert.equal(files().length, 0); assert.equal(all('SELECT * FROM audit_output_unlinks').length, 0);
  const disabled = await capture();
  assert.equal(output.readOutput(owner.id, disabled, true).state, 'disabled');
  output.setOutputRetention(4);
  assert.equal(output.readOutput(owner.id, second, true).state, 'expired');
  assert.equal(output.readOutput(owner.id, disabled, true).state, 'disabled');
  for (const bad of [-1, 0.5, '4', null, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => output.setOutputRetention(bad));
});
test('metadata-only database, encryption, restart, parent and user cascade unlink queue', async () => {
  const id = await capture();
  const ciphertext = fs.readFileSync(path.join(root, files()[0]), 'utf8');
  assert.ok(!ciphertext.includes('demo-account'));
  assert.deepEqual(decrypt(ciphertext).preview, { account_id: 'demo-account' });
  assert.ok(!JSON.stringify(getAudit(owner.id, id)).includes('demo-account'));
  assert.ok(!JSON.stringify(queryAudit(owner.id, {})).includes('demo-account'));
  output.initOutputStore();
  assert.equal(output.readOutput(owner.id, id, true).state, 'retained');
  run('DELETE FROM audit_log WHERE id = ?', id);
  assert.equal(all('SELECT * FROM audit_output_unlinks').length, 1);
  assert.throws(() => output.readOutput(owner.id, id, true));
  output.sweepOutputs(); assert.equal(files().length, 0);
  const disposable = createUser('disposable', 'user');
  const userId = idFor(disposable);
  await output.observeOutput(Response.json({ account_id: 'demo' }), userId, disposable.id, rule, []).text();
  run('DELETE FROM users WHERE id = ?', disposable.id);
  assert.equal(one('SELECT 1 FROM audit_outputs'), undefined);
  output.sweepOutputs(); assert.equal(files().length, 0);
});
test('bounded projection drops unknown/nested secrets and preserves caller bytes/status on omissions', async () => {
  const text = '{"account_id":"demo-account"}';
  for (const size of [output.OUTPUT_LIMIT, output.OUTPUT_LIMIT + 1]) {
    const id = await capture(text.padEnd(size));
    assert.equal(output.readOutput(owner.id, id, true).state, size === output.OUTPUT_LIMIT ? 'retained' : 'omitted');
  }
  for (const body of ['{}', '[]', '{"account_id":2}', '{"account_id":"bad id"}', '{"account_id":"demo\\u0000"}', '{"account_id":"' + 'a'.repeat(129) + '"}', '{"account_id":"echo-synthetic-secret"}', '{bad', '']) {
    const id = await capture(body);
    assert.equal(output.readOutput(owner.id, id, true).state, 'omitted', body);
  }
  for (const options of [{ status: 401 }, { status: 500 }, { status: 302 }, { type: 'text/plain' }, { rule: null }]) {
    const id = await capture(text, options);
    assert.equal(output.readOutput(owner.id, id, true).state, 'omitted');
  }
  for (const [value, state] of [['é'.repeat(64), 'retained'], ['é'.repeat(65), 'omitted']] as const) {
    const id = await capture(JSON.stringify({ account_id: value }));
    assert.equal(output.readOutput(owner.id, id, true).state, state);
  }
  const boundaryRule = { ...rule, fields: { account_id: { maxBytes: output.OUTPUT_LIMIT } } };
  const projectedBoundary = JSON.stringify({ account_id: 'a'.repeat(output.OUTPUT_LIMIT - Buffer.byteLength(JSON.stringify({ account_id: '' }))) });
  const exactProjection = output.projectOutput(Buffer.from(projectedBoundary), boundaryRule, []);
  assert.equal(Buffer.byteLength(JSON.stringify(exactProjection)), output.OUTPUT_LIMIT);
  assert.equal(output.projectOutput(Buffer.from(projectedBoundary + ' '), boundaryRule, []), undefined);
  assert.equal(output.projectOutput(Buffer.from('{"token":"unexpected"}'), { ...rule, fields: { token: { maxBytes: 128 } } }, []), undefined);
  const plus = await capture(text, { type: 'application/profile+json; charset=utf-8' });
  assert.equal(output.readOutput(owner.id, plus, true).state, 'retained');
});
test('interrupted, cancelled, policy-fenced and reused-ID captures are omitted', async () => {
  const id = idFor();
  const failed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('{"account_id":"demo"}')); c.error(Error('interrupted')); } });
  await assert.rejects(output.observeOutput(new Response(failed, { headers: { 'content-type': 'application/json' } }), id, owner.id, rule, []).text());
  assert.equal(one('SELECT 1 FROM audit_outputs'), undefined);
  for (const mutation of ['policy', 'reuse', 'cancel']) {
    const id = idFor();
    let end!: () => void;
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('{"account_id":"old"}')); end = () => c.close(); } });
    const wrapped = output.observeOutput(new Response(source, { headers: { 'content-type': 'application/json' } }), id, owner.id, rule, []);
    if (mutation === 'cancel') { await wrapped.body!.cancel(); continue; }
    const read = wrapped.text();
    if (mutation === 'policy') { output.setOutputRetention(0); output.setOutputRetention(4); }
    else { run('DELETE FROM audit_log WHERE id = ?', id); const replacement = idFor(); run('UPDATE audit_log SET id = ? WHERE id = ?', id, replacement); }
    end(); await read;
    assert.equal(one('SELECT 1 FROM audit_outputs'), undefined);
  }
});
test('real API authorization matrix and owner-only output even for peer-visible metadata', async () => {
  const id = await capture();
  const session = createSession(owner.id), token = createToken(owner.id, 'full', null).secret;
  const scoped = createToken(owner.id, 'scoped', ['synthetic-connection']).secret;
  const foreign = createToken(other.id, 'foreign', null).secret;
  const cases = [
    [{ cookie: 'switchboard_session=' + session }, 200],
    [{ authorization: 'Bearer ' + token }, 200],
    [{ authorization: 'Bearer ' + scoped }, 403],
    [{ authorization: 'Bearer ' + foreign }, 404],
    [{}, 401],
  ] as const;
  for (const suffix of ['output', 'output/status']) for (const [headers, status] of cases) {
    const response = await app.request('/api/audit/' + id + '/' + suffix, { headers: headers as Record<string, string> });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 200 && suffix.endsWith('status')) assert.ok(!('preview' in await response.json()));
  }
  const peerOwner = createUser('peer-shadow-preview', 'user');
  run('UPDATE users SET peer_shadow = 1 WHERE id = ?', peerOwner.id);
  const peerId = idFor(peerOwner);
  assert.equal(getAudit(owner.id, peerId, true).id, peerId);
  const response = await app.request('/api/audit/' + peerId + '/output', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 404);
  const forbidden = await app.request('/api/admin/activity-retention', { headers: { authorization: 'Bearer ' + foreign } });
  assert.equal(forbidden.status, 403);
});
test('snapshots exclude exact ciphertext and payload; restore invalidation survives interruption and ID reuse', async () => {
  const id = await capture();
  const filename = files()[0], ciphertext = fs.readFileSync(path.join(root, filename));
  const saved = path.join(tmp, 'backup.db');
  await backup(db, saved);
  const dbBytes = fs.readFileSync(saved);
  assert.ok(!dbBytes.includes(ciphertext)); assert.ok(!dbBytes.includes(Buffer.from('demo-account')));
  const metadata = one('SELECT * FROM audit_outputs WHERE audit_id = ?', id);
  const prior = JSON.parse(fs.readFileSync(path.join(root, 'generation.json'), 'utf8')).generation;
  invalidatePreviews(root, [process.env.SWITCHBOARD_DATA_DIR!], 'synthetic-instance');
  assert.equal(files().length, 0);
  // Simulate crash after durable retirement but before physical cleanup/restore completes.
  fs.writeFileSync(path.join(root, filename), ciphertext);
  fs.writeFileSync(path.join(root, 'generation.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, 'generation.json'), 'utf8')), generation: '12345678-1234-1234-1234-123456789abc', retiring: true }));
  assert.notEqual(openPreviewStore(root, [process.env.SWITCHBOARD_DATA_DIR!], 'synthetic-instance'), prior);
  assert.equal(files().length, 0);
  output.initOutputStore();
  assert.equal(output.readOutput(owner.id, id, true).state, 'unavailable');
  run('DELETE FROM audit_log WHERE id = ?', id);
  const replacement = idFor(); run('UPDATE audit_log SET id = ? WHERE id = ?', id, replacement);
  // Restoring old metadata and ciphertext cannot bind to the current generation.
  run('INSERT INTO audit_outputs VALUES(?,?,?,?,?)', id, metadata.capture_id, metadata.generation, metadata.captured_at, metadata.expires_at);
  fs.writeFileSync(path.join(root, filename), ciphertext);
  run("UPDATE audit_log SET output_state = 'captured' WHERE id = ?", id);
  assert.equal(output.readOutput(owner.id, id, true).state, 'unavailable');
  output.sweepOutputs(); assert.equal(files().length, 0);
  assert.throws(() => assertPreviewIsolation(path.join(tmp, 'data', 'outputs'), [path.join(tmp, 'data')]));
});
test('legacy, missing files, and unavailable storage remain payload-free', async () => {
  const legacy = idFor();
  run("UPDATE audit_log SET output_state = 'legacy' WHERE id = ?", legacy);
  assert.equal(output.readOutput(owner.id, legacy, true).state, 'legacy');
  const id = await capture();
  fs.unlinkSync(path.join(root, files()[0]));
  assert.equal(output.readOutput(owner.id, id, true).state, 'unavailable');
  output.sweepOutputs();
  assert.equal(one('SELECT 1 FROM audit_outputs WHERE audit_id = ?', id), undefined);
});

test('execute captures final local response once across stream, envelope and HTTP MCP consumers', async () => {
  const { plugins } = await import('../server/plugins/manager.ts');
  const { execute, envelope, passThrough } = await import('../server/proxy.ts');
  const service = {
    id: 'preview-fixture', name: 'Preview fixture', baseUrl: rule.origin,
    outputPreviews: [rule],
    authMethods: [{
      id: 'user', name: 'User', fields: [], connect: async () => ({ kind: 'direct' as const, credentials: {} }),
      authorize: async (req: any, _conn: any, options: any) => { req.headers.set('authorization', options.force ? 'Bearer final-secret' : 'Bearer old-secret'); },
    }, { id: 'app', name: 'App', fields: [], connect: async () => ({ kind: 'direct' as const, credentials: {} }), authorize: async () => {} }],
  };
  plugins.services.set(service.id, { service, pluginId: 'preview-fixture' });
  run('INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'preview-connection', owner.id, service.id, 'user', 'Preview fixture', encrypt({}), encrypt({ accessToken: 'final-secret' }), time, time);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const body = '{"account_id":"demo-account","token":"final-secret"}';
  globalThis.fetch = async () => {
    requests++;
    return new Response(requests % 2 ? '{"error":"retry"}' : body, { status: requests % 2 ? 401 : 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const source of ['proxy', 'console', 'mcp'] as const) {
      const ex = await execute(owner, 'preview-connection', { method: 'GET', url: '/profile' }, undefined, { ...caller, source });
      assert.equal(ex.sent.retried, true);
      if (source === 'proxy') assert.equal(await passThrough(ex).text(), body);
      else if (source === 'console') assert.equal((await envelope(ex)).body, body);
      else assert.equal(await ex.response.text(), body);
      assert.deepEqual(output.readOutput(owner.id, ex.auditId!, true).preview, { account_id: 'demo-account' });
    }
    assert.equal(requests, 6);
    assert.equal(all('SELECT * FROM audit_outputs').length, 3);
    assert.equal(all('SELECT * FROM audit_log').length, 3);
    for (const input of [
      { method: 'POST', url: '/profile' }, { method: 'GET', url: '/elsewhere' }, { method: 'GET', url: '/profile?query=1' },
    ]) {
      const ex = await execute(owner, 'preview-connection', input, undefined, caller); await ex.response.text();
      assert.equal(output.readOutput(owner.id, ex.auditId!, true).state, 'omitted');
    }
    run("UPDATE connections SET method_id = 'app' WHERE id = 'preview-connection'");
    const appOnly = await execute(owner, 'preview-connection', { method: 'GET', url: '/profile' }, undefined, caller); await appOnly.response.text();
    assert.equal(output.readOutput(owner.id, appOnly.auditId!, true).state, 'omitted');
    run("UPDATE connections SET method_id = 'user' WHERE id = 'preview-connection'");
    const peer = await execute(owner, 'preview-connection', { method: 'GET', url: '/profile' }, undefined, { ...caller, peerId: 'synthetic-peer' });
    await peer.response.text();
    assert.equal(one('SELECT 1 FROM audit_outputs WHERE audit_id = ?', peer.auditId!), undefined);
    // Sign-in and plugin maintenance calls have no eligible audited data caller.
    const noAudit = await execute(owner, 'preview-connection', { method: 'GET', url: '/profile' });
    await noAudit.response.text(); assert.equal(noAudit.auditId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    plugins.services.delete(service.id);
    run("DELETE FROM connections WHERE id = 'preview-connection'");
  }
});

test('missing restore capability omits capture; disable does not claim physical deletion until storage returns', async () => {
  const { config } = await import('../server/config.ts');
  const id = await capture();
  config.previewRestoreSafe = false;
  output.initOutputStore();
  assert.equal(output.readOutput(owner.id, id, true).state, 'unavailable');
  const omitted = await capture();
  assert.equal(output.readOutput(owner.id, omitted, true).state, 'omitted');
  assert.throws(() => output.setOutputRetention(0), /deletion will be retried/);
  assert.equal(output.outputPolicy().hours, 0);
  assert.equal(files().length, 1);
  config.previewRestoreSafe = true;
  output.initOutputStore();
  assert.equal(files().length, 0);
  assert.equal(output.setOutputRetention(0).hours, 0);
  output.setOutputRetention(4);
});

test('admin writes require the loaded policy revision and conflicts never shorten or purge', async () => {
  const id = await capture();
  const originalExpiry = one('SELECT expires_at FROM audit_outputs WHERE audit_id = ?', id).expires_at;
  const headers = { authorization: 'Bearer ' + createToken(owner.id, 'policy-admin', null).secret, 'content-type': 'application/json' };
  const read = async () => (await app.request('/api/admin/activity-retention', { headers })).json() as Promise<any>;
  const put = (body: unknown) => app.request('/api/admin/activity-retention', { method: 'PUT', headers, body: JSON.stringify(body) });
  const adminA = await read(), adminB = await read();
  assert.equal(adminA.hours, 4);
  for (const revision of [undefined, null, -1, '0', 0.5]) {
    assert.equal((await put({ hours: 1, revision })).status, 400);
    assert.equal(output.outputPolicy().hours, 4);
  }
  assert.equal((await put({ hours: 8, revision: adminB.revision })).status, 200);
  // Admin A still thinks 6 is an increase from 4. It must not silently shorten the new 8.
  assert.equal((await put({ hours: 6, revision: adminA.revision })).status, 409);
  assert.equal((await put({ hours: 0, revision: adminA.revision })).status, 409);
  assert.equal(output.outputPolicy().hours, 8);
  assert.equal(one('SELECT expires_at FROM audit_outputs WHERE audit_id = ?', id).expires_at, originalExpiry);
  assert.equal(files().length, 1);
  const refreshed = await read();
  assert.equal((await put({ hours: 1, revision: refreshed.revision })).status, 200);
  assert.equal(output.outputPolicy().hours, 1);
});

test('admin capture availability comes from server provisioning, regardless of client host', async () => {
  const { config } = await import('../server/config.ts');
  const headers = { authorization: 'Bearer ' + createToken(owner.id, 'availability-admin', null).secret };
  const read = async (agent: string) => (await app.request('/api/admin/activity-retention', { headers: { ...headers, 'user-agent': agent } })).json() as Promise<any>;
  assert.deepEqual((await read('Switchboard macOS manager')).capture, { available: true, reason: 'ready' });
  assert.deepEqual((await read('Switchboard Windows manager')).capture, { available: true, reason: 'ready' });
  config.previewRestoreSafe = false;
  assert.deepEqual((await read('Chrome browser')).capture, { available: false, reason: 'restore-unsupported' });
  config.previewRestoreSafe = true;
  const rootBefore = config.previewRoot;
  config.previewRoot = undefined;
  assert.deepEqual((await read('Switchboard macOS manager')).capture, { available: false, reason: 'not-provisioned' });
  config.previewRoot = rootBefore;
  fs.renameSync(path.join(root, 'generation.json'), path.join(root, 'generation.unavailable'));
  assert.deepEqual((await read('Chrome browser')).capture, { available: false, reason: 'storage-unavailable' });
  fs.renameSync(path.join(root, 'generation.unavailable'), path.join(root, 'generation.json'));
});

test('periodic maintenance reopens failed startup storage and drains expired files without explicit init', async () => {
  const id = await capture();
  const marker = path.join(root, 'generation.json'), original = fs.readFileSync(marker, 'utf8');
  fs.writeFileSync(marker, '{temporarily unreadable');
  output.initOutputStore();
  assert.equal(output.readOutput(owner.id, id, true).state, 'unavailable');
  time += 4 * 3600_000;
  output.maintainOutputs(); // Still offline: expire metadata and retain the physical unlink queue.
  assert.equal(all('SELECT * FROM audit_outputs').length, 0);
  assert.equal(all('SELECT * FROM audit_output_unlinks').length, 1);
  assert.equal(files().length, 1);
  fs.writeFileSync(marker, original);
  // This is the exact callback invoked by the running minute timer, without explicit initialization.
  output.maintainOutputs();
  assert.equal(files().length, 0);
  assert.equal(all('SELECT * FROM audit_output_unlinks').length, 0);
  assert.equal(output.outputCaptureAvailability().available, true);
});
test('periodic cleanup leaves unknown files and directories in a verified root untouched', async () => {
  const sentinel = path.join(root, 'unrelated-sentinel');
  fs.writeFileSync(sentinel, 'must survive');
  fs.mkdirSync(path.join(root, 'unrelated-folder'));
  await capture();
  output.sweepOutputs();
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive');
  assert.ok(fs.statSync(path.join(root, 'unrelated-folder')).isDirectory());
});

test('policy approvals cannot survive a restored numeric revision or restore epoch', async () => {
  const current = output.outputPolicy(), loaded = output.outputRetentionSettings();
  run("UPDATE instance_settings SET value = ? WHERE key = 'activity-output-retention'", JSON.stringify({ hours: 12, revision: current.revision }));
  assert.throws(() => output.setOutputRetention(10, loaded.revision), /retention changed/);
  assert.equal(output.outputPolicy().hours, 12);
  const beforeRestore = output.outputRetentionSettings(), oldEpoch = testConfig.previewEpoch;
  testConfig.previewEpoch = 'restored-epoch';
  assert.notEqual(output.outputRetentionSettings().revision, beforeRestore.revision);
  assert.throws(() => output.setOutputRetention(1, beforeRestore.revision), /retention changed/);
  testConfig.previewEpoch = oldEpoch;
});
