import fs from 'node:fs';
import path from 'node:path';
import { Controller, acquireController, atomic, readJson, validateSettings, type Settings } from './engine.ts';

const [action, configFile, code] = process.argv.slice(2);
if (!['setup', 'enroll', 'run', 'launch'].includes(action) || !configFile || !path.isAbsolute(configFile)) {
  console.error('Usage: node updater/main.ts setup|enroll|run|launch /absolute/settings.json [one-time-code]'); process.exit(1);
}
try {
  const settings = readJson<Settings>(configFile); if (!settings) throw Error('Create the settings file using the setup guide'); validateSettings(settings);
  if (action === 'setup') {
    fs.mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 }); fs.chmodSync(configFile, 0o600);
    // Install a self-contained launcher outside every application release.
    const dest = path.join(settings.stateDir, 'launcher'); fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of ['main.ts', 'engine.ts', 'runtime.ts']) fs.copyFileSync(path.join(import.meta.dirname, name), path.join(dest, name));
    console.log('Launcher installed. Enroll it with a one-time code from Admin → Updates, then use launch (checkout) or run (Compose).');
  } else if (action === 'enroll') {
    if (!code) throw Error('Provide the one-time enrollment code');
    const r = await fetch(`${settings.appUrl.replace(/\/$/, '')}/api/updater/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, instance: settings.instance, mode: settings.mode, sourceBuild: settings.compose?.sourceBuild === true, protocol: 1 }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!r.ok) throw Error('Enrollment failed'); settings.token = (await r.json() as any).token; atomic(configFile, settings); console.log('Updater enrolled.');
  } else {
    if (!settings.token) throw Error('Enroll first');
    const release = acquireController(settings); process.once('exit', release);
    const controller = new Controller(settings); await controller.recover();
    if (action === 'launch' && settings.mode === 'checkout') {
      if (controller.journal?.phase === 'recovery-required') throw Error('Explicit owner recovery is required; automatic restart is disabled');
      try { const poll = await controller.verifyInstance(); if (poll.lifecycle === 'staged') await controller.api('open', {}); } catch { if (controller.childAlive()) throw Error('Managed child is still running but unreachable. Refusing concurrent launch.'); await controller.stop(); await controller.start(controller.current()); await controller.ready(); await controller.api('open', {}); }
    }
    let disconnected = false;
    while (true) {
      try {
        await controller.tick();
        if (disconnected) console.log('Updater polling resumed.');
        disconnected = false;
      } catch {
        if (!disconnected) console.error('Updater could not complete a polling cycle; check application connectivity and the owner-only updater state directory. Retrying in five seconds.');
        disconnected = true;
        // A normal child crash can restart the selected release; interrupted deployments use recover().
        if (action === 'launch' && settings.mode === 'checkout' && !controller.childAlive() && controller.journal?.phase !== 'recovery-required') {
          try { await controller.stop(); await controller.start(controller.current()); await controller.ready(); await controller.api('open', {}); } catch { /* Retry without touching data or replaying a job. */ }
        }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
} catch (e) { console.error(e instanceof Error ? e.message : 'Updater failed'); process.exitCode = 1; }
