import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { now, run } from '../db.ts';
import { badRequest } from '../http.ts';
import type { PluginManifest } from './api.ts';
import { type GithubSource, installedDir, plugins, upsertRow, validateManifest } from './manager.ts';

export interface RepoRef {
  repo: string;
  ref?: string;
  path?: string;
}

/** Accepts "owner/repo", "https://github.com/owner/repo", ".../tree/<ref>/<path>" and "owner/repo@ref". */
export function parseRepo(input: string, ref?: string, subpath?: string): RepoRef {
  let s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let parsedRef: string | undefined;
  let parsedPath: string | undefined;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/);
  if (url) {
    s = `${url[1]}/${url[2]}`;
    parsedRef = url[3];
    parsedPath = url[4];
  } else {
    const at = s.match(/^([^/@\s]+\/[^/@\s]+)@(.+)$/);
    if (at) {
      s = at[1];
      parsedRef = at[2];
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) throw badRequest('Use owner/repo or a github.com URL');
  const p = (subpath?.trim() || parsedPath || '').replace(/^\/+|\/+$/g, '');
  if (p.split('/').includes('..')) throw badRequest('Invalid path');
  return { repo: s, ref: ref?.trim() || parsedRef || undefined, path: p || undefined };
}

async function gh(url: string, accept = 'application/vnd.github+json') {
  const headers: Record<string, string> = { accept, 'user-agent': 'switchboard', 'x-github-api-version': '2022-11-28' };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 404) throw badRequest(`Not found on GitHub: ${url.replace('https://api.github.com/repos/', '')}`);
    throw badRequest(`GitHub responded ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

export async function resolveCommit(repo: string, ref?: string): Promise<string> {
  const target = ref ? encodeURIComponent(ref) : 'HEAD';
  const res = await gh(`https://api.github.com/repos/${repo}/commits/${target}`, 'application/vnd.github.sha');
  return (await res.text()).trim();
}

/** Downloads a commit and returns the directory it was extracted to. */
async function download(repo: string, commit: string): Promise<string> {
  const dir = path.join(config.dataDir, 'tmp', randomToken(8));
  fs.mkdirSync(dir, { recursive: true });
  const res = await gh(`https://api.github.com/repos/${repo}/tarball/${commit}`, 'application/vnd.github+json');
  await pipeline(Readable.fromWeb(res.body as any), tar.x({ cwd: dir, strip: 1 }));
  return dir;
}

/** Plugin directories in an extracted repository, relative to its root. */
function findPlugins(root: string, sub?: string): string[] {
  const base = sub ? path.join(root, sub) : root;
  if (!base.startsWith(root) || !fs.existsSync(base)) throw badRequest(`Path "${sub}" does not exist in the repository`);
  if (fs.existsSync(path.join(base, 'plugin.json'))) return [path.relative(root, base)];
  const out: string[] = [];
  for (const parent of [base, path.join(base, 'plugins')]) {
    if (!fs.existsSync(parent)) continue;
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(parent, e.name, 'plugin.json'))) out.push(path.relative(root, path.join(parent, e.name)));
    }
  }
  if (!out.length) throw badRequest('No plugin.json found in the repository');
  return out;
}

function place(extracted: string, rel: string, source: Omit<GithubSource, 'path'>): string {
  const src = path.join(extracted, rel);
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'plugin.json'), 'utf8')) as PluginManifest;
  try {
    validateManifest(manifest);
  } catch (e: any) {
    throw badRequest(`${rel || 'plugin.json'}: ${e.message}`);
  }
  const dest = path.join(installedDir(), manifest.id);
  plugins.quiet(manifest.id, 10_000);
  const staging = `${dest}.new-${randomToken(4)}`;
  fs.cpSync(src, staging, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  upsertRow(manifest.id);
  const full: GithubSource = { ...source, path: rel.split(path.sep).join('/') };
  run('UPDATE plugins SET source = ?, installed_at = COALESCE(installed_at, ?), updated_at = ? WHERE id = ?', JSON.stringify(full), now(), now(), manifest.id);
  return manifest.id;
}

export async function install(input: RepoRef): Promise<string[]> {
  const commit = await resolveCommit(input.repo, input.ref);
  const extracted = await download(input.repo, commit);
  try {
    const ids = findPlugins(extracted, input.path).map((rel) =>
      place(extracted, rel, { type: 'github', repo: input.repo, ref: input.ref, commit }),
    );
    await plugins.reload(ids);
    return ids;
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

export async function checkUpdates() {
  const installed = [...plugins.plugins.values()].filter((p) => p.source?.type === 'github');
  const latest = new Map<string, Promise<string>>();
  return Promise.all(
    installed.map(async (p) => {
      const s = p.source!;
      const key = `${s.repo}@${s.ref ?? ''}`;
      if (!latest.has(key)) latest.set(key, resolveCommit(s.repo, s.ref));
      try {
        const commit = await latest.get(key)!;
        return { id: p.id, current: s.commit, latest: commit, updateAvailable: commit !== s.commit };
      } catch (e: any) {
        return { id: p.id, current: s.commit, error: e.message, updateAvailable: false };
      }
    }),
  );
}

export async function update(id: string): Promise<{ id: string; from: string; to: string }> {
  const p = plugins.get(id);
  const s = p.source;
  if (s?.type !== 'github') throw badRequest('Only plugins installed from GitHub can be updated');
  const commit = await resolveCommit(s.repo, s.ref);
  const extracted = await download(s.repo, commit);
  try {
    const rel = s.path.split('/').join(path.sep);
    if (!fs.existsSync(path.join(extracted, rel, 'plugin.json'))) throw badRequest(`The repository no longer contains ${s.path || 'plugin.json'}`);
    const newId = place(extracted, rel, { type: 'github', repo: s.repo, ref: s.ref, commit });
    if (newId !== id) throw badRequest(`The plugin at ${s.repo}/${s.path} now has id "${newId}"`);
    await plugins.reload([id]);
    return { id, from: s.commit, to: commit };
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

export async function uninstall(id: string) {
  const p = plugins.get(id);
  if (p.origin !== 'installed') throw badRequest('Built-in plugins cannot be removed; disable them instead');
  plugins.quiet(id);
  fs.rmSync(p.dir, { recursive: true, force: true });
  run('UPDATE plugins SET source = NULL, installed_at = NULL, updated_at = NULL WHERE id = ?', id);
  await plugins.reload([id]);
}
