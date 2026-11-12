import fs from 'node:fs';
import path from 'node:path';
import { Controller, atomic, readJson, acquireController, type Settings } from './engine.ts';
const directory = process.env.SWITCHBOARD_BUNDLE_DIR!;
const project = process.env.SWITCHBOARD_COMPOSE_PROJECT ?? 'switchboard';
const file = '/state/settings.json';
if (!directory || !path.isAbsolute(directory)) throw Error('Bundle directory required');
if (!fs.existsSync(file)) atomic(file, { instance: project, mode: 'compose', dataDir: '/data', stateDir: '/state', appUrl: 'http://switchboard:8770', env: {}, compose: { directory, project, service: 'switchboard', files: [path.join(directory, 'compose.yaml')], privateNetwork: true, dataVolume: `${project}-app-data`, stateVolume: `${project}-updater-state`, sourceBuild: process.env.SWITCHBOARD_SOURCE_BUILD === 'true' } } satisfies Settings);
if (['backup', 'restore'].includes(process.argv[2])) {
  const s = readJson<Settings>(file)!; const unlock = acquireController(s);
  try {
    const c = new Controller(s);
    if (process.argv[2] === 'backup') {
      const image = await c.identifyCurrent(); await c.api('drain', {}); await c.stop();
      const id = `manual-${Date.now()}`, dir = `/state/backups/${id}`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); await c.dataHelper('snapshot', dir, image);
      atomic(`${dir}.json`, { image }); await c.start(image, false); console.log(`Backup saved: ${id}`);
    } else {
      const id = process.argv[3]; if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? '')) throw Error('Supply a backup ID');
      const dir = `/state/backups/${id}`;
      const saved = readJson<{ image: string }>(`${dir}.json`);
      const history = readJson<{ previous: string; backup: string }>(`/state/history/${id}.json`);
      const image = saved?.image ?? (history?.backup === dir ? history.previous : undefined);
      if (!image || !fs.existsSync(dir)) throw Error('Backup not found; use an ID printed by backup or recorded in history');
      await c.stop();
      const preserved = `/state/failed-data-manual-${Date.now()}`; fs.mkdirSync(preserved, { mode: 0o700 });
      await c.dataHelper('snapshot', preserved, image); await c.dataHelper('restore', dir, image);
      if (c.journal) { atomic(`/state/history/recovered-${Date.now()}.json`, c.journal); fs.rmSync('/state/journal.json'); }
      atomic('/state/current.json', { release: image }); c.override(image, false); await c.start(image, false);
      console.log('Backup restored. Current data was preserved separately. Enroll the updater again from Admin → Updates if needed.');
    }
  } finally { unlock(); }
} else {
  while (!readJson<Settings>(file)?.token) await new Promise(r => setTimeout(r, 2000));
  process.argv = [process.argv[0], process.argv[1], 'run', file]; await import('./main.ts');
}
