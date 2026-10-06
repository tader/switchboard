import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The slim Microsoft Graph descriptions that ship with the plugin, through the same code the console uses.
process.env.SWITCHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-ms-'));
const root = path.resolve(import.meta.dirname, '..');
const { describe } = await import('../server/openapi.ts');
const oauth2 = (await import('../plugins/oauth2/index.ts')).default({} as any).exports;
const ctx = (plugin: string) => ({ settings: {}, dir: path.join(root, 'plugins', plugin), publicUrl: 'https://sb.example', callbackUrl: 'https://sb.example/oauth/callback', require: () => oauth2 }) as any;
const microsoft = (await import('../plugins/microsoft/index.ts')).default(ctx('microsoft'));
const msCtx = { ...ctx('outlook-mail'), require: () => microsoft.exports };

test('Microsoft Graph API descriptions', async () => {
  const conn = { id: 'c', name: 'n', serviceId: '', methodId: 'oauth', config: {}, credentials: {} } as any;
  const expected: Record<string, [string, string]> = {
    'outlook-mail': ['POST', '/me/sendMail'],
    'outlook-calendar': ['POST', '/me/events'],
    onedrive: ['GET', '/me/drive/root/children'],
    'microsoft-todo': ['POST', '/me/todo/lists/{todoTaskList-id}/tasks'],
  };
  for (const [plugin, [method, p]] of Object.entries(expected)) {
    const service = (await import(`../plugins/${plugin}/index.ts`)).default(msCtx).services[0];
    const d = (await describe(service, conn))!;
    assert.equal(d.server, 'https://graph.microsoft.com/v1.0', plugin);
    assert.ok(d.operations.length > 40, `${plugin}: ${d.operations.length} operations`);
    assert.ok(d.operations.some((o) => o.method === method && o.path === p), `${plugin} has ${method} ${p}`);
    assert.ok(d.operations.every((o) => /^\/(me|shares|drives)/.test(o.path)), `${plugin} only has its own operations`);
  }
  const mail = (await import('../plugins/outlook-mail/index.ts')).default(msCtx).services[0];
  const send = (await describe(mail, conn))!.operations.find((o) => o.path === '/me/sendMail')!;
  assert.deepEqual(JSON.parse(send.body!.example!).message.toRecipients, [{ emailAddress: { address: 'someone@example.com' } }]);
  const list = (await describe(mail, conn))!.operations.find((o) => o.method === 'GET' && o.path === '/me/messages')!;
  assert.ok(['$filter', '$select', '$top', '$search'].every((n) => list.params.some((x) => x.name === n)), 'OData query options');
  const drive = (await import('../plugins/onedrive/index.ts')).default(msCtx).services[0];
  const ops = (await describe(drive, conn))!.operations;
  assert.ok(ops.some((o) => o.path === "/me/drive/root/search(q='{q}')"), 'search, which Graph\'s description lacks');
  assert.equal(JSON.parse(ops.find((o) => o.method === 'POST' && o.path === '/me/drive/root/children')!.body!.example!).name, 'New folder');
  const graph = microsoft.services[0];
  assert.ok((await describe(graph, conn))!.operations.length > 600, 'the general service covers all of them');
});
