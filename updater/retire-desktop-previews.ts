/** Called by the native manager while it owns both installation leases. */
import path from 'node:path';
import { assertPreviewIsolation } from '../shared/activity-preview-store.ts';
import { hasLivePreviewStores, localPreviewRoot, retirePreviewStores } from './activity-previews.ts';
import { atomic, command, type Settings } from './engine.ts';

const [dataDir, stateDir, initialRelease, ...destinations] = process.argv.slice(2);
if (!dataDir || !stateDir || !initialRelease || destinations.length !== 0 && destinations.length !== 2
  || ![dataDir, stateDir, initialRelease, ...destinations].every(p => path.isAbsolute(p))) {
  throw Error('Absolute installation paths are required');
}
const settings: Settings = { instance: 'local-manager', mode: 'runtime', dataDir, stateDir, initialRelease, appUrl: 'http://localhost', env: {} };
const excluded = [dataDir, stateDir, initialRelease, ...destinations];
assertPreviewIsolation(localPreviewRoot(stateDir), excluded);
if (destinations.length) assertPreviewIsolation(localPreviewRoot(destinations[1]), excluded);
if (hasLivePreviewStores(settings)) await retirePreviewStores(settings, undefined, excluded, command, atomic);
