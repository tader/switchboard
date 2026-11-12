import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Target } from '../server/updates/releases.ts';

export interface RuntimeManifest { origin: 'tader/switchboard'; version: string; revision: string; protocol: 1; platform: 'darwin'; arch: 'arm64' | 'x64'; archive: string; sha256: string }
export function validateManifest(m: RuntimeManifest, t: Pick<Target, 'version' | 'revision'>, arch = process.arch) {
  if (m.origin !== 'tader/switchboard' || m.version !== t.version || m.revision !== t.revision || m.protocol !== 1 || m.platform !== 'darwin' || m.arch !== arch || !['arm64', 'x64'].includes(m.arch) || m.archive !== `switchboard-runtime-darwin-${m.arch}.tar.gz` || !/^[a-f0-9]{64}$/.test(m.sha256)) throw Error('Incompatible prepared runtime');
}
export function safeEntry(name: string, type: string) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || !['File', 'Directory', 'OldFile'].includes(type)) throw Error('Unsafe runtime archive');
}
export function inspectArchive(archive: Buffer) {
  const bytes = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 });
  const names = new Set<string>();
  const string = (start: number, size: number) => bytes.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= bytes.length;) {
    if (bytes.subarray(at, at + 512).every(b => b === 0)) return;
    const prefix = string(at + 345, 155), name = (prefix ? prefix + '/' : '') + string(at, 100);
    const type = string(at + 156, 1); safeEntry(name, type === '5' ? 'Directory' : type === '0' || !type ? 'File' : 'Unsafe');
    if (names.has(name)) throw Error('Duplicate archive entry'); names.add(name);
    const sizeText = string(at + 124, 12).trim(); if (!/^[0-7]+$/.test(sizeText)) throw Error('Invalid archive size');
    const size = parseInt(sizeText, 8); const next = at + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw Error('Truncated archive'); at = next;
  }
  throw Error('Missing archive terminator');
}
export async function prepareRuntime(t: Target, stateDir: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || t.channel !== 'stable') throw Error('Prepared runtimes require a stable macOS release');
  const base = `https://github.com/tader/switchboard/releases/download/v${t.version}/`;
  const get = async (name: string) => { const r = await fetcher(base + name, { signal: AbortSignal.timeout(300_000) }); if (!r.ok) throw Error('Prepared runtime is not published yet'); if (r.url && !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(new URL(r.url).hostname)) throw Error('Untrusted runtime origin'); return r; };
  const m = await (await get(`runtime-darwin-${process.arch}.json`)).json() as RuntimeManifest; validateManifest(m, t);
  if (t.runtime && (t.runtime.sha256 !== m.sha256 || t.runtime.arch !== m.arch || t.runtime.revision !== m.revision)) throw Error('Selected runtime identity changed');
  const release = path.join(stateDir, 'releases', t.revision);
  if (fs.existsSync(path.join(release, '.prepared'))) { const saved = JSON.parse(fs.readFileSync(path.join(release, 'runtime.json'), 'utf8')); validateManifest(saved, t); if (saved.sha256 !== m.sha256) throw Error('Runtime identity changed'); return release; }
  const staging = `${release}.partial`; fs.mkdirSync(path.dirname(release), { recursive: true, mode: 0o700 }); fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { mode: 0o700 });
  const archive = `${staging}.tar.gz`;
  try {
    const r = await get(m.archive); const fd = fs.openSync(archive, 'w', 0o600); const hash = createHash('sha256'); let size = 0;
    try { for await (const chunk of r.body as any) { size += chunk.length; if (size > 512 * 1024 * 1024) throw Error('Runtime exceeds download limit'); hash.update(chunk); fs.writeFileSync(fd, chunk); } } finally { fs.closeSync(fd); }
    if (hash.digest('hex') !== m.sha256) throw Error('Runtime checksum mismatch');
    inspectArchive(fs.readFileSync(archive));
    await promisify(execFile)('/usr/bin/tar', ['-xzf', archive, '-C', staging], { timeout: 120_000 });
    const b = JSON.parse(fs.readFileSync(path.join(staging, 'build-info.json'), 'utf8')); const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    if (b.version !== t.version || b.revision !== t.revision || pkg.version !== t.version || pkg.managedUpgradeProtocol !== 1 || !fs.existsSync(path.join(staging, 'bin/node'))) throw Error('Runtime build identity mismatch');
    fs.writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify(m), { mode: 0o600 }); fs.writeFileSync(path.join(staging, '.prepared'), '', { mode: 0o600 }); fs.rmSync(release, { recursive: true, force: true }); fs.renameSync(staging, release); return release;
  } finally { fs.rmSync(archive, { force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
