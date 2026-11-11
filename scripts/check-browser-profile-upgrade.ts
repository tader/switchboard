// Upgrade rehearsal on a throwaway database and synthetic browser profiles only.
// Usage: node scripts/check-browser-profile-upgrade.ts <microsoft checkout> <idm checkout>
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [ms, idm] = process.argv.slice(2); if (!ms || !idm) throw Error('Pass plugin checkout paths');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swb-profile-upgrade-'));
const previous = path.join(temp, 'previous'), data = path.join(temp, 'data');
await fs.mkdir(previous); await fs.mkdir(data);
const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: path.resolve(import.meta.dirname, '..'), maxBuffer: 64*1024*1024 });
execFileSync('tar', ['-xf', '-', '-C', previous], { input: archive });
await fs.symlink(path.resolve(import.meta.dirname, '../node_modules'), path.join(previous, 'node_modules'));
const ids = [randomUUID(), randomUUID()];
const seed = `const {initKey,encrypt}=await import('./server/crypto.ts');const {initDb,run}=await import('./server/db.ts');const {createUser}=await import('./server/users.ts');initKey();initDb();const u=createUser('fixture','user');for(const [i,service] of ['microsoft-authentication','idm'].entries())run('INSERT INTO connections(id,user_id,name,service_id,method_id,config_enc,credentials_enc,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)','old-'+i,u.id,service,service,'browser',encrypt({}),encrypt({profile:${JSON.stringify(ids)}[i]}),Date.now(),Date.now());`;
execFileSync(process.execPath, ['--input-type=module', '-e', seed], { cwd: previous, env: { ...process.env, SWITCHBOARD_DATA_DIR: data } });
process.env.SWITCHBOARD_DATA_DIR = data;
const { CDP, findBrowser } = await import('../server/authentication-browser.ts');
const sourceDirs = [path.join(data, 'plugin-data/microsoft-authentication/profiles', ids[0], 'auth-browser'), path.join(data, 'plugin-data/idm/profiles', ids[1], 'browser')];
const digest = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const before: string[] = [];
for (const [i, dir] of sourceDirs.entries()) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const browser = new CDP(await findBrowser(undefined,i===1?'chrome':undefined), dir, { headless: true });
  try { await browser.call('Storage.setCookies', { cookies: [{ name: 'upgrade-fixture', value: 'synthetic-' + i, domain: 'fixture.invalid', path: '/', secure: true, expires: Math.floor(Date.now()/1000)+3600 }] }); } finally { await browser.close(); }
  before.push(await digest(path.join(dir, 'Default/Cookies')));
}
const { initKey } = await import('../server/crypto.ts'); const { initDb, all } = await import('../server/db.ts');
initKey();initDb();
const core = await import('../server/browser-profiles.ts');
const setupMicrosoft = (await import(pathToFileURL(path.join(ms, 'plugins/microsoft-authentication/index.ts')).href)).default;
const setupIdm = (await import(pathToFileURL(path.join(idm, 'index.js')).href)).default;
const microsoftPlugin = setupMicrosoft({ dataDir: path.join(data, 'plugin-data/microsoft-authentication'), settings: {}, browserProfiles: {}, capabilities: { deviceBrowser: true } });
const idmPlugin = await setupIdm({ dataDir: path.join(data, 'plugin-data/idm'), settings: {}, browserProfiles: {}, capabilities: { deviceBrowser: true } });
try {
  for (const [i, row] of all('SELECT * FROM connections ORDER BY id').entries()) {
    const method = (i === 0 ? microsoftPlugin : idmPlugin).services[0].authMethods[0];
    const id = core.registerBrowserProfile(row, method, i === 0 ? 'microsoft-authentication' : 'idm')!;
    assert.equal(await digest(path.join(sourceDirs[i], 'Default/Cookies')), before[i], 'registration must not change legacy sign-in');
    const lease = await core.reserveBrowserProfile(row.user_id, 'fixture', 'reuse-' + i, undefined, id);
    await lease.run({ headless: true }, async browser => {
      const { cookies } = await browser.call('Storage.getCookies');
      assert.equal(cookies.find((c: any) => c.name === 'upgrade-fixture')?.value, 'synthetic-' + i);
    });
    assert.equal(await digest(path.join(sourceDirs[i], 'Default/Cookies')), before[i], 'migration must retain the original untouched');
    await core.releaseBrowserFlow('reuse-' + i);
  }
  assert.equal(all('SELECT * FROM browser_profiles').length, 2);
  console.log('PASS: previous HEAD database → current migration, Microsoft and IDM legacy directories independently registered and copied, real browser sign-ins retained, originals unchanged.');
} finally { await core.stopBrowserProfiles(); await microsoftPlugin.dispose(); await idmPlugin.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
