import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.SWITCHBOARD_PLAYWRIGHT_MODULE ?? 'playwright-core');
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-ui-'));
const artifacts = process.env.SWITCHBOARD_QA_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'activity-ui-artifacts-')); fs.mkdirSync(artifacts, { recursive: true });
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = 'http://127.0.0.1:' + port;
Object.assign(process.env, {
  SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_ACTIVITY_PREVIEW_ROOT: path.join(tmp, 'outputs'),
  SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '1', SWITCHBOARD_PORT: String(port), SWITCHBOARD_HOST: '127.0.0.1',
  SWITCHBOARD_PUBLIC_URL: base, SWITCHBOARD_UPDATE_CHECKS: 'false', SWITCHBOARD_WATCH_PLUGINS: 'false',
});
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR);
const imp = file => import(pathToFileURL(path.join(root, file)).href);
const db = await imp('server/db.ts'); db.initDb();
const crypto = await imp('server/crypto.ts'); crypto.initKey();
const users = await imp('server/users.ts');
const owner = users.createUser('synthetic-ui-admin', 'admin');
const session = users.createSession(owner.id);
const audit = await imp('server/audit.ts');
const outputs = await imp('server/activity-output.ts'); outputs.initOutputStore();
const caller = { source: 'console', tokenId: null, tokenName: null, ip: null, userAgent: null };
const ids = {};
for (const state of ['legacy', 'omitted', 'expired', 'retained', 'fresh']) {
  const id = audit.record({ userId: owner.id, caller, method: 'GET', url: 'https://api.example.test/' + state, status: 200, connection: { id: 'synthetic-connection', name: 'Fixture API', serviceId: 'fixture' } });
  ids[state] = id;
  if (state === 'retained' || state === 'fresh') await outputs.observeOutput(Response.json({ account_id: 'demo-' + 'a'.repeat(120) }), id, owner.id, { fields: { account_id: { maxBytes: 128 } } }, []).text();
  else db.run('UPDATE audit_log SET output_state = ? WHERE id = ?', state, id);
  if (state === 'retained') db.run('UPDATE audit_outputs SET captured_at = captured_at - ?, expires_at = expires_at - ? WHERE audit_id = ?', 90 * 60_000, 90 * 60_000, id);
}
db.db.close();
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
let browser;
try {
  const until = Date.now() + 20000;
  while (true) {
    try { if ((await fetch(base + '/readyz')).ok) break; } catch {}
    if (Date.now() > until) throw Error('Server failed readiness: ' + logs);
    await new Promise(r => setTimeout(r, 50));
  }
  browser = await chromium.launch({ executablePath: process.env.SWITCHBOARD_CHROME ?? '/usr/bin/google-chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'switchboard_session', value: session, url: base }]);
  const page = await context.newPage();
  let reveals = 0;
  page.on('request', r => { if (new URL(r.url()).pathname.endsWith('/output')) reveals++; });
  const open = async (state, filter = '') => {
    await page.goto(base + '/activity?range=all' + filter);
    const row = page.locator('tbody tr').filter({ hasText: '/' + state });
    await row.waitFor(); await row.focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.getByRole('heading', { name: 'Output preview', exact: true }).waitFor();
  };
  await open('retained');
  assert.equal(reveals, 0);
  const view = page.getByRole('button', { name: 'View output', exact: true });
  await view.focus(); await page.keyboard.press('Space');
  await page.locator('pre').filter({ hasText: 'demo-' }).waitFor();
  assert.equal(reveals, 1);
  assert.equal(await page.getByRole('button', { name: 'Hide output' }).getAttribute('aria-expanded'), 'true');
  const contrast = async target => target.evaluate(el => {
    const rgb = color => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = color => rgb(color).map(c => { const n = c / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    const text = luminance(getComputedStyle(el).color), bg = luminance(getComputedStyle(el.closest('dialog')).backgroundColor);
    return (Math.max(text, bg) + 0.05) / (Math.min(text, bg) + 0.05);
  });
  assert.ok(await contrast(page.getByRole('heading', { name: 'Output preview', exact: true })) >= 4.5);
  await page.screenshot({ path: path.join(artifacts, 'preview-desktop-light.png') });
  await page.getByRole('button', { name: 'Hide output' }).click();
  assert.equal(await page.locator('pre').count(), 0);
  await page.getByRole('button', { name: 'View output', exact: true }).click();
  await page.locator('pre').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'View GET details');
  // Narrow dark rendering and text reflow.
  await page.setViewportSize({ width: 320, height: 700 }); await page.emulateMedia({ colorScheme: 'dark' });
  await open('retained'); await page.getByRole('button', { name: 'View output', exact: true }).click(); await page.locator('pre').waitFor();
  const overflow = await page.getByRole('dialog').evaluate(d => ({ client: d.clientWidth, scroll: d.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
  await page.locator('pre').scrollIntoViewIfNeeded();
  assert.ok(await contrast(page.getByRole('heading', { name: 'Output preview', exact: true })) >= 4.5);
  assert.ok(await contrast(page.getByText('Redacted JSON · Only selected fields are shown.', { exact: true })) >= 4.5);
  await page.screenshot({ path: path.join(artifacts, 'preview-320-dark.png') });
  // A 1280px physical viewport at 200% browser zoom has 640 CSS px and DPR 2.
  const zoomContext = await browser.newContext({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await zoomContext.addCookies([{ name: 'switchboard_session', value: session, url: base }]);
  const zoomPage = await zoomContext.newPage();
  await zoomPage.goto(base + '/activity?range=all');
  await zoomPage.locator('tbody tr').filter({ hasText: '/retained' }).click();
  await zoomPage.getByRole('button', { name: 'View output', exact: true }).click();
  await zoomPage.locator('pre').waitFor(); await zoomPage.locator('pre').scrollIntoViewIfNeeded();
  const zoomOverflow = await zoomPage.getByRole('dialog').evaluate(d => d.scrollWidth - d.clientWidth);
  assert.ok(zoomOverflow <= 1);
  await zoomPage.screenshot({ path: path.join(artifacts, 'preview-200-percent.png') });
  await zoomContext.close();
  await page.keyboard.press('Escape');
  for (const state of ['legacy', 'omitted', 'expired']) {
    await open(state); assert.equal(await page.getByRole('button', { name: 'View output', exact: true }).count(), 0);
    assert.ok((await page.getByRole('dialog').innerText()).includes(state === 'legacy' ? 'before output previews' : state === 'expired' ? 'has expired' : 'No output preview'));
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const filter of ['&client=web', '&connection=synthetic-connection']) {
    await open('retained', filter);
    await page.getByRole('button', { name: 'View output', exact: true }).click();
    await page.locator('pre').waitFor();
    await page.keyboard.press('Escape');
  }
  // Closing during a held reveal and switching entries discards late output.
  let releaseReply;
  await page.route('**/api/audit/' + ids.retained + '/output', async route => {
    const response = await route.fetch();
    releaseReply = () => route.fulfill({ response }).catch(() => {});
  });
  await open('retained'); await page.getByRole('button', { name: 'View output', exact: true }).click();
  await page.getByText('Loading output preview…').waitFor();
  const heldUntil = Date.now() + 3000;
  while (!releaseReply) { if (Date.now() > heldUntil) throw Error('Reveal was not held'); await new Promise(r => setTimeout(r, 10)); }
  await page.keyboard.press('Escape');
  await open('legacy'); await releaseReply();
  assert.equal(await page.locator('pre').count(), 0);
  await page.keyboard.press('Escape');
  await page.unroute('**/api/audit/' + ids.retained + '/output');
  // Failed load, Retry and a failed status check clear immediately.
  let fail = true;
  await page.route('**/api/audit/' + ids.retained + '/output', async route => { if (fail) await route.fulfill({ status: 500, json: { error: 'synthetic' } }); else await route.continue(); });
  await open('retained'); await page.getByRole('button', { name: 'View output', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); assert.equal(await page.locator('pre').count(), 0);
  fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.locator('pre').waitFor();
  await page.route('**/output/status', route => route.fulfill({ status: 503, json: { error: 'synthetic' } }));
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await page.locator('pre').count(), 0);
  await page.unroute('**/output/status');
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.locator('pre').waitFor();
  // An unresponsive status request cannot extend the last display grant.
  await page.clock.install();
  await page.route('**/output/status', () => {});
  await page.clock.fastForward(16000);
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await page.locator('pre').count(), 0);
  await page.unroute('**/output/status');
  await page.clock.resume();
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.locator('pre').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('pre').count(), 0);
  await page.getByRole('button', { name: 'View output', exact: true }).click(); await page.locator('pre').waitFor();
  // A second client disables retention using the real admin confirmation.
  const adminPage = await context.newPage(); await adminPage.emulateMedia({ colorScheme: 'dark' }); await adminPage.goto(base + '/admin/activity-retention');
  await adminPage.getByLabel('Output preview retention').fill('1');
  await adminPage.getByRole('button', { name: 'Save changes' }).click();
  await adminPage.getByRole('button', { name: 'Shorten retention', exact: true }).click();
  await adminPage.getByText('Output preview retention saved.').waitFor();
  await page.getByText('This output preview has expired.').waitFor({ timeout: 7000 });
  await page.keyboard.press('Escape');
  await open('fresh'); await page.getByRole('button', { name: 'View output', exact: true }).click(); await page.locator('pre').waitFor();
  await adminPage.getByLabel('Output preview retention').fill('0');
  await adminPage.getByRole('button', { name: 'Save changes' }).click();
  await adminPage.getByRole('dialog').waitFor();
  await adminPage.setViewportSize({ width: 320, height: 700 });
  const confirmOverflow = await adminPage.getByRole('dialog').evaluate(d => d.scrollWidth - d.clientWidth);
  assert.ok(confirmOverflow <= 1);
  await adminPage.screenshot({ path: path.join(artifacts, 'retention-confirm-320.png') });
  await adminPage.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
  await adminPage.getByRole('button', { name: 'Disable output previews', exact: true }).click();
  await adminPage.getByText('Output preview retention saved.').waitFor();
  await page.getByText('This output preview has expired.').waitFor({ timeout: 7000 });
  assert.equal(await page.locator('pre').count(), 0);
  await adminPage.setViewportSize({ width: 320, height: 700 });
  await adminPage.screenshot({ path: path.join(artifacts, 'retention-320-dark.png') });
  await adminPage.getByLabel('Output preview retention').fill('-1');
  await adminPage.getByRole('button', { name: 'Save changes' }).click();
  assert.equal(await adminPage.getByLabel('Output preview retention').getAttribute('aria-invalid'), 'true');
  assert.equal(await adminPage.locator(':focus').getAttribute('id'), 'output-hours');
  console.log('PASS browser: on-demand fetch, keyboard reveal/hide/Escape/focus return, legacy/omitted/expired, failed-load Retry, failed status clearing, two-client shortening/disable, delayed reveal disposal, hung-check display bound, pagehide clearing, Cancel-first confirmation, validation, 320px dark and 200% captures');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
