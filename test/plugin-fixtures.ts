import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

// Frozen migration baseline, never used by the server or production installs.
export const fixturePluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-plugin-fixtures-'));
tar.x({ sync: true, file: path.join(import.meta.dirname, 'fixtures/extracted-plugins.tgz'), cwd: fixturePluginsDir });
process.on('exit', () => fs.rmSync(fixturePluginsDir, { recursive: true, force: true }));

export function installFixturePlugins(dataDir: string, ids = fs.readdirSync(fixturePluginsDir)) {
  for (const id of ids) {
    fs.cpSync(path.join(fixturePluginsDir, id), path.join(dataDir, 'plugins', id), { recursive: true });
    // Adapt the frozen pre-peer API baseline without modifying its historical archive.
    if (id === 'shell-command') {
      const entry = path.join(dataDir, 'plugins', id, 'index.ts');
      fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replaceAll('ctx.satellite', 'ctx.peer'));
    }
  }
}
