import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CDP, findBrowser } from '../server/authentication-browser.ts';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'browser-pipe-rehearsal-'));
const browser=new CDP(await findBrowser(undefined,'edge'),profile,{headless:true});
try { const version=await browser.call('Browser.getVersion');assert.ok(version.product); const page=await browser.page('data:text/html,<title>Synthetic</title>');assert.ok(page);console.log('PASS: installed browser accepts private control pipes'); }
finally {await browser.close();fs.rmSync(profile,{recursive:true,force:true});}
