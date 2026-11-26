import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
function readJson(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 4096) throw Error('Invalid preview marker');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function assertOwnedPreviewStore(root: string, excluded: string[], instance = canonical(excluded[0])): PreviewIdentity {
  assertPreviewIsolation(root, excluded);
  const stat = fs.statSync(root), marker = path.join(root, 'store.json');
  const identity = readJson(marker) as PreviewIdentity;
  if (stat.mode & 0o077 || fs.lstatSync(marker).uid !== stat.uid || identity.version !== 1 || identity.instance !== instance || identity.location !== canonical(root) || !/^[a-f0-9-]{36}$/.test(identity.storeId)) throw Error('Preview store identity mismatch');
  return identity;
}
export function previewGeneration(root: string, excluded: string[], instance = canonical(excluded[0])) {
  const identity = assertOwnedPreviewStore(root, excluded, instance);
  const state = readJson(path.join(root, 'generation.json'));
  if (state.storeId !== identity.storeId || !/^[a-f0-9-]{36}$/.test(state.generation)) throw Error('Invalid preview generation');
  return { ...state, identity } as { generation: string; retiring?: boolean; identity: PreviewIdentity };
}
function generationFile(root: string, identity: PreviewIdentity, value: { generation: string; retiring?: boolean }) {
  const temp = path.join(root, 'generation.tmp');
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ ...value, storeId: identity.storeId })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, path.join(root, 'generation.json')); syncDirectory(root);
}
/** Only recognized regular files in a verified store are ours to remove. Never recurse. */
export function removePreviewFile(root: string, name: string, excluded: string[], instance = canonical(excluded[0])) {
  const identity = assertOwnedPreviewStore(root, excluded, instance);
  if (!(previewFilePattern.test(name) && name.startsWith('preview-' + identity.storeId + '-')) && name !== 'generation.tmp') throw Error('Unrecognized preview file');
  const file = path.join(root, name);
  try {
    if (!fs.lstatSync(file).isFile()) throw Error('Preview file is not a regular file');
    fs.unlinkSync(file);
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}
function retire(root: string, excluded: string[], instance: string) {
  const identity = assertOwnedPreviewStore(root, excluded, instance);
  const generation = randomUUID();
  generationFile(root, identity, { generation, retiring: true });
  for (const name of fs.readdirSync(root)) if (previewFilePattern.test(name) && name.startsWith('preview-' + identity.storeId + '-')) removePreviewFile(root, name, excluded, instance);
  syncDirectory(root);
  generationFile(root, identity, { generation });
  return generation;
}
export function openPreviewStore(root: string, excluded: string[], instance = canonical(excluded[0])): string {
  assertPreviewIsolation(root, excluded);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(root);
  if (process.platform === 'win32' || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw Error('Owner-private preview storage required');
  const marker = path.join(root, 'store.json');
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw Error('Refusing to adopt a nonempty unrecognized preview directory');
    const identity: PreviewIdentity = { version: 1, instance, location: canonical(root), storeId: randomUUID() };
    const fd = fs.openSync(marker, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(identity)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(root);
  }
  assertOwnedPreviewStore(root, excluded, instance);
  if (!fs.existsSync(path.join(root, 'generation.json'))) return retire(root, excluded, instance);
  const state = previewGeneration(root, excluded, instance);
  return state.retiring ? retire(root, excluded, instance) : state.generation;
}
/** Writer stopped; verified identity required before retirement, including interrupted restores. */
export function invalidatePreviews(root: string, excluded: string[], instance = canonical(excluded[0])) {
  openPreviewStore(root, excluded, instance);
  return retire(root, excluded, instance);
}
