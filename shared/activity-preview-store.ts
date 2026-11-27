import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withPreviewIO, type PreviewIO } from './activity-preview-io.ts';

export interface PreviewIdentity { version: 1; instance: string; location: string; storeId: string }
const uuid = '[a-f0-9-]{36}';
export const previewFilePattern = new RegExp('^preview-(' + uuid + ')-(' + uuid + ')\\.enc(?:\\.tmp)?$');
export function canonical(p: string): string {
  const resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.join(canonical(path.dirname(p)), path.basename(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function assertPreviewIsolation(root: string, excluded: string[]) {
  if (!path.isAbsolute(root) || !excluded.length) throw Error('Isolated preview paths required');
  const r = canonical(root);
  for (const p of excluded) {
    const other = canonical(p);
    if (r === other || r.startsWith(other + path.sep) || other.startsWith(r + path.sep)) throw Error('Preview storage overlaps managed data');
  }
}
export function syncDirectory(root: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function identityIn(io: PreviewIO, root: string, instance: string): PreviewIdentity {
  const identity = JSON.parse(io.read('store.json', 4096)) as PreviewIdentity;
  if (identity.version !== 1 || identity.instance !== instance || identity.location !== canonical(root) || !/^[a-f0-9-]{36}$/.test(identity.storeId)) throw Error('Preview store identity mismatch');
  return identity;
}
function owned<T>(root: string, excluded: string[], instance: string, operation: (io: PreviewIO, identity: PreviewIdentity) => T): T {
  assertPreviewIsolation(root, excluded);
  return withPreviewIO(root, false, io => operation(io, identityIn(io, root, instance)));
}
export function assertOwnedPreviewStore(root: string, excluded: string[], instance = canonical(excluded[0])): PreviewIdentity {
  return owned(root, excluded, instance, (_io, identity) => identity);
}
export function previewGeneration(root: string, excluded: string[], instance = canonical(excluded[0])) {
  return owned(root, excluded, instance, (io, identity) => {
    const state = JSON.parse(io.read('generation.json', 4096));
    if (state.storeId !== identity.storeId || !/^[a-f0-9-]{36}$/.test(state.generation)) throw Error('Invalid preview generation');
    return { ...state, identity } as { generation: string; retiring?: boolean; identity: PreviewIdentity };
  });
}
function generationFile(io: PreviewIO, identity: PreviewIdentity, value: { generation: string; retiring?: boolean }) {
  io.write('generation.tmp', 'generation.json', JSON.stringify({ ...value, storeId: identity.storeId }), true);
}
function recognized(name: string, identity: PreviewIdentity) {
  if (!(previewFilePattern.test(name) && name.startsWith('preview-' + identity.storeId + '-')) && name !== 'generation.tmp') throw Error('Unrecognized preview file');
}
/** Every Windows operation holds the verified directory and file handles until completion. */
export function readPreviewFile(root: string, name: string, excluded: string[], instance: string, storeId: string, limit: number) {
  return owned(root, excluded, instance, (io, identity) => {
    if (identity.storeId !== storeId) throw Error('Preview store binding changed');
    recognized(name, identity); return io.read(name, limit);
  });
}
export function writePreviewFile(root: string, name: string, value: string, excluded: string[], instance: string, storeId: string) {
  return owned(root, excluded, instance, (io, identity) => {
    if (identity.storeId !== storeId) throw Error('Preview store binding changed');
    recognized(name, identity); io.write(name + '.tmp', name, value);
  });
}
export function listPreviewFiles(root: string, excluded: string[], instance: string) {
  return owned(root, excluded, instance, io => io.list());
}
export function previewFileExists(root: string, name: string, excluded: string[], instance: string) {
  return owned(root, excluded, instance, (io, identity) => { recognized(name, identity); return io.exists(name); });
}
/** Only recognized regular files in a verified store are ours to remove. Never recurse. */
export function removePreviewFile(root: string, name: string, excluded: string[], instance = canonical(excluded[0])) {
  return owned(root, excluded, instance, (io, identity) => { recognized(name, identity); io.remove(name); });
}
function retireIn(io: PreviewIO, identity: PreviewIdentity) {
  const generation = randomUUID();
  generationFile(io, identity, { generation, retiring: true });
  for (const name of io.list()) if (previewFilePattern.test(name) && name.startsWith('preview-' + identity.storeId + '-')) io.remove(name);
  generationFile(io, identity, { generation });
  return generation;
}
export function openPreviewStore(root: string, excluded: string[], instance = canonical(excluded[0])): string {
  assertPreviewIsolation(root, excluded);
  return withPreviewIO(root, true, io => {
    if (!io.exists('store.json')) {
      if (io.list().length) throw Error('Refusing to adopt a nonempty unrecognized preview directory');
      const identity: PreviewIdentity = { version: 1, instance, location: canonical(root), storeId: randomUUID() };
      io.write('store.tmp', 'store.json', JSON.stringify(identity));
    }
    const identity = identityIn(io, root, instance);
    if (!io.exists('generation.json')) return retireIn(io, identity);
    const state = JSON.parse(io.read('generation.json', 4096));
    if (state.storeId !== identity.storeId || !/^[a-f0-9-]{36}$/.test(state.generation)) throw Error('Invalid preview generation');
    return state.retiring ? retireIn(io, identity) : state.generation;
  });
}
/** Writer stopped; verified identity required before retirement, including interrupted restores. */
export function invalidatePreviews(root: string, excluded: string[], instance = canonical(excluded[0])) {
  openPreviewStore(root, excluded, instance);
  return owned(root, excluded, instance, (io, identity) => retireIn(io, identity));
}
