import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
function generationFile(root: string, value: { generation: string; retiring?: boolean }) {
  const temp = path.join(root, 'generation.tmp');
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, path.join(root, 'generation.json')); syncDirectory(root);
}
/** Must run with the writer stopped, BEFORE replacing any application data. */
export function invalidatePreviews(root: string) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const generation = randomUUID();
  // A durable tombstone prevents an interrupted restore from reopening old files.
  generationFile(root, { generation, retiring: true });
  for (const n of fs.readdirSync(root)) if (n !== 'generation.json') fs.rmSync(path.join(root, n), { recursive: true, force: true });
  syncDirectory(root);
  generationFile(root, { generation });
  return generation;
}
export function openPreviewStore(root: string, excluded: string[]): string {
  assertPreviewIsolation(root, excluded);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = fs.statSync(root);
  if (process.platform === 'win32' || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw Error('Owner-private preview storage required');
  const file = path.join(root, 'generation.json');
  if (!fs.existsSync(file)) return invalidatePreviews(root);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.retiring) return invalidatePreviews(root);
  if (!/^[a-f0-9-]{36}$/.test(state.generation)) throw Error('Invalid preview generation');
  return state.generation;
}
