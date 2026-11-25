import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CDP, findBrowser } from '../server/authentication-browser.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-pipe-rehearsal-'));
try {
  // Keep the two checks independent while Windows releases the first profile's handles.
  const directProfile = fs.mkdtempSync(path.join(root, 'direct-'));
  const direct = new CDP(await findBrowser(undefined, 'edge'), directProfile, {
    headless: true,
    spawnProcess: (file, args, options) => {
      const child = spawn(file, args, { ...options, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', () => {});
      child.on('exit', code => console.log('Synthetic direct browser exit:', code));
      return child;
    },
  });
  try {
    await direct.call('Browser.getVersion', {}, undefined, 60_000);
    console.log('PASS: direct Windows browser pipes');
  } finally {
    await direct.close();
  }

  const watchdogProfile = fs.mkdtempSync(path.join(root, 'watchdog-'));
  const browser = new CDP(await findBrowser(undefined, 'edge'), watchdogProfile, { headless: true });
  try {
    const version = await browser.call('Browser.getVersion', {}, undefined, 60_000);
    assert.ok(version.product);
    const page = await browser.page('data:text/html,<title>Synthetic</title>');
    assert.ok(page);
    console.log('PASS: installed browser accepts private control pipes');
  } finally {
    await browser.close();
  }
} finally {
  // Edge descendants and Windows scanners may briefly retain profile handles after exit.
  // Node retries transient EPERM/EBUSY/ENOTEMPTY errors; persistent failures still fail CI.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
