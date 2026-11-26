import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertOwnedPreviewStore, canonical, invalidatePreviews, openPreviewStore } from '../shared/activity-preview-store.ts';
import type { Settings } from './engine.ts';

type Run = (file: string, args: string[]) => Promise<string>;
type Save = (file: string, value: unknown) => void;
interface StoreBinding { kind: 'compose' | 'checkout'; location: string; storeId: string; mountpoint?: string; retired?: boolean }
interface PreviewControl { instance: string; epoch: string; stores: StoreBinding[] }
function controlFile(s: Settings) { return path.join(s.stateDir, 'activity-preview-control.json'); }
function control(s: Settings, save: Save): PreviewControl {
  const file = controlFile(s);
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!/^[a-f0-9-]{36}$/.test(value.instance) || !/^[a-f0-9-]{36}$/.test(value.epoch) || !Array.isArray(value.stores)) throw Error('Invalid preview controller identity');
    return value;
  }
  const value = { instance: randomUUID(), epoch: randomUUID(), stores: [] };
  save(file, value); return value;
}
export function validatePreviewVolumeBacking(volumes: any[]) {
  const names = new Set<string>(), locations: string[] = [];
  for (const volume of volumes) {
    if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length || !path.posix.isAbsolute(volume.Mountpoint ?? '')) throw Error('Preview isolation requires default local volumes without driver options');
    const location = path.posix.normalize(volume.Mountpoint);
    if (names.has(volume.Name) || locations.some(p => p === location || p.startsWith(location + '/') || location.startsWith(p + '/'))) throw Error('Preview volume backing storage overlaps managed data');
    names.add(volume.Name); locations.push(location);
  }
}
export async function verifyComposePreviewBacking(s: Settings, run: Run) {
  const c = s.compose!;
  if (!c.previewVolume || !c.dataVolume || !c.stateVolume) throw Error('Capture requires dedicated local named data, state and preview volumes');
  const volumes = JSON.parse(await run('docker', ['volume', 'inspect', c.previewVolume, c.dataVolume, c.stateVolume]));
  validatePreviewVolumeBacking(volumes);
  return volumes.find((v: any) => v.Name === c.previewVolume).Mountpoint as string;
}
async function composeStore(s: Settings, image: string, run: Run, instance: string, volume: string, operation: 'open' | 'retire', expected?: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume) || !/^sha256:[a-f0-9]{64}$|^ghcr\.io\/tader\/switchboard@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Fixed preview volume and immutable helper image required');
  // Current controller-owned code, including when the selected rollback image is older.
  const source = fs.readFileSync(path.join(import.meta.dirname, '../shared/activity-preview-store.ts'), 'utf8');
  const script = [
    "const fs=await import('node:fs');const {stripTypeScriptTypes}=await import('node:module');",
    "const [source,instance,operation,expected]=process.argv.slice(1);const m=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));",
    "const root='/activity-previews',excluded=['/data','/state','/app'];",
    "if(fs.readdirSync(root).length){const id=m.assertOwnedPreviewStore(root,excluded,instance);if(expected&&id.storeId!==expected)throw Error('Store binding changed');}else{if(expected)throw Error('Bound store is missing');fs.chmodSync(root,448);fs.chownSync(root,1000,1000);}",
    "process.setgid(1000);process.setuid(1000);m.openPreviewStore(root,excluded,instance);if(operation==='retire')m.invalidatePreviews(root,excluded,instance);console.log(JSON.stringify(m.assertOwnedPreviewStore(root,excluded,instance)));",
  ].join('');
  return JSON.parse(await run('docker', ['run', '--rm', '--network=none', '--read-only', '--user', '0:0', '--entrypoint', 'node', '--mount', 'type=volume,src=' + volume + ',dst=/activity-previews', image, '--input-type=module', '-e', script, source, instance, operation, expected ?? '']));
}
export class PreviewStoreSwitchError extends Error {}
async function retireBinding(binding: StoreBinding, s: Settings, image: string | undefined, state: PreviewControl, excluded: string[], run: Run) {
  if (binding.kind === 'checkout') {
    if (assertOwnedPreviewStore(binding.location, excluded, state.instance).storeId !== binding.storeId) throw Error('Bound preview store changed');
    invalidatePreviews(binding.location, excluded, state.instance);
  } else if (binding.kind === 'compose') {
    if (!image) throw Error('Immutable helper image required');
    const inspected = JSON.parse(await run('docker', ['volume', 'inspect', binding.location]));
    validatePreviewVolumeBacking(inspected);
    if (inspected[0].Mountpoint !== binding.mountpoint) throw Error('Bound preview backing changed');
    await composeStore(s, image, run, state.instance, binding.location, 'retire', binding.storeId);
  } else throw Error('Invalid preview store binding');
}
export async function provisionPreviews(s: Settings, release: string, excluded: string[], run: Run, save: Save): Promise<Record<string, string>> {
  const state = control(s, save);
  let binding: StoreBinding;
  if (s.mode === 'compose' && s.compose?.previewVolume) {
    for (const previous of state.stores) {
      if ((previous.kind === 'compose' && previous.location === s.compose.previewVolume) || previous.retired) continue;
      try {
        await retireBinding(previous, s, release, state, excluded, run);
        previous.retired = true;
        save(controlFile(s), state); // Acknowledge only physical deletion in the previous store.
      } catch {
        throw new PreviewStoreSwitchError('Previous preview storage could not be retired; activation remains closed until storage recovers.');
      }
    }
  }
  if (s.mode === 'checkout') {
    const root = s.stateDir + '.activity-previews';
    const old = state.stores.find(v => v.kind === 'checkout' && v.location === canonical(root));
    if (old && assertOwnedPreviewStore(root, excluded, state.instance).storeId !== old.storeId) throw Error('Bound preview store changed');
    openPreviewStore(root, excluded, state.instance);
    binding = { kind: 'checkout', location: canonical(root), storeId: assertOwnedPreviewStore(root, excluded, state.instance).storeId };
  } else if (s.mode === 'compose' && s.compose?.previewVolume) {
    const mountpoint = await verifyComposePreviewBacking(s, run), volume = s.compose.previewVolume;
    const old = state.stores.find(v => v.kind === 'compose' && v.location === volume);
    if (old && old.mountpoint !== mountpoint) throw Error('Bound preview backing changed');
    const identity = await composeStore(s, release, run, state.instance, volume, 'open', old?.storeId);
    binding = { kind: 'compose', location: volume, storeId: identity.storeId, mountpoint };
  } else return {};
  const existing = state.stores.find(v => v.kind === binding.kind && v.location === binding.location);
  if (existing) existing.retired = false;
  else state.stores.push({ ...binding, retired: false });
  save(controlFile(s), state); // Bind the active store before enabling any writer.
  return {
    SWITCHBOARD_ACTIVITY_PREVIEW_ROOT: s.mode === 'compose' ? '/activity-previews' : binding.location,
    SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE: state.instance,
    SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH: state.epoch,
    SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID: binding.storeId,
    SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '1',
    SWITCHBOARD_ACTIVITY_PREVIEW_EXCLUDED_ROOTS: JSON.stringify(excluded),
  };
}
export function boundPreviewEnvironment(s: Settings, excluded: string[]): Record<string, string> {
  if (!fs.existsSync(controlFile(s))) return { SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '0' };
  const state = JSON.parse(fs.readFileSync(controlFile(s), 'utf8')) as PreviewControl;
  const location = s.mode === 'compose' ? s.compose?.previewVolume : canonical(s.stateDir + '.activity-previews');
  const binding = state.stores.find(v => v.kind === s.mode && v.location === location);
  if (!binding || binding.retired || state.stores.some(v => v !== binding && !v.retired)) return { SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '0' };
  return {
    SWITCHBOARD_ACTIVITY_PREVIEW_ROOT: s.mode === 'compose' ? '/activity-previews' : binding.location,
    SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE: state.instance,
    SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH: state.epoch,
    SWITCHBOARD_ACTIVITY_PREVIEW_STORE_ID: binding.storeId,
    SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE: '1',
    SWITCHBOARD_ACTIVITY_PREVIEW_EXCLUDED_ROOTS: JSON.stringify(excluded),
  };
}
export async function retirePreviewStores(s: Settings, image: string | undefined, excluded: string[], run: Run, save: Save) {
  const state = control(s, save);
  // Durable, independent of the restored DB and of current preview-volume settings.
  state.epoch = randomUUID(); save(controlFile(s), state);
  for (const binding of state.stores) {
    if (binding.retired) continue;
    await retireBinding(binding, s, image, state, excluded, run);
    binding.retired = true; save(controlFile(s), state);
  }
}
