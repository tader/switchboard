import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { config } from '../config.ts';

export const UPSTREAM = 'tader/switchboard';
export const IMAGE = `ghcr.io/${UPSTREAM}`;
export type Channel = 'stable' | 'validated-main';
export interface Build { version: string; revision: string | null; mode: 'checkout' | 'compose' | 'runtime' | 'unmanaged'; custom: boolean }
export interface Target { version: string; revision: string; channel: Channel; notes: string; url: string; baseRevision?: string; protocol: 1; image?: string; runtime?: { origin: string; version: string; revision: string; protocol: number; platform: string; arch: string; archive: string; sha256: string } }
function detectBuild(): Build {
  const version = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
  try {
    const b = JSON.parse(fs.readFileSync(path.join(config.root, 'build-info.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(b.revision) || b.version !== version) throw Error();
    return { version, revision: b.revision, mode: process.env.SWITCHBOARD_INSTALL_MODE === 'runtime' ? 'runtime' : process.env.SWITCHBOARD_INSTALL_MODE === 'compose' ? 'compose' : 'checkout', custom: false };
  } catch { /* Ordinary checkout or an unidentifiable archive. */ }
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: config.root, encoding: 'utf8' }).trim();
    return { version, revision, mode: 'checkout', custom: !!dirty };
  } catch { return { version, revision: null, mode: process.env.SWITCHBOARD_INSTALL_MODE === 'compose' ? 'compose' : 'unmanaged', custom: true }; }
}
const identities = new Map<string, Build>();
/** Report the process's startup identity even if its checkout is moved without restarting. */
export function runningBuild(): Build {
  let build = identities.get(config.root);
  if (!build) { build = detectBuild(); identities.set(config.root, build); }
  let changed = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'));
    changed = pkg.version !== build.version;
    if (fs.existsSync(path.join(config.root, '.git'))) {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: config.root, encoding: 'utf8' }).trim().split('\n').filter(line => line && !/^\?\? (build-info\.json|\.prepared)$/.test(line)).join('\n');
      changed ||= revision !== build.revision || !!dirty;
    }
  } catch { changed = true; }
  return { ...build, custom: build.custom || changed };
}
export async function github(endpoint: string, fetcher: typeof fetch = fetch): Promise<any> {
  const r = await fetcher(`https://api.github.com/repos/${UPSTREAM}/${endpoint}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'switchboard-updates' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!r.ok) throw Error('Release service unavailable. Try again later.');
  return r.json();
}
export async function imageDigest(revision: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid revision');
  const auth = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${UPSTREAM}:pull`, { signal: AbortSignal.timeout(20_000) });
  if (!auth.ok) throw Error('Image is not ready');
  const { token } = await auth.json() as { token: string };
  const r = await fetcher(`https://ghcr.io/v2/${UPSTREAM}/manifests/sha-${revision}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  const digest = r.headers.get('docker-content-digest');
  if (!r.ok || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Published release image is not ready yet');
  return `${IMAGE}@${digest}`;
}
export function eligible(build: Build, target: Target): boolean {
  if (build.custom || !build.revision || !semver.valid(build.version) || !semver.valid(target.version)) return false;
  return target.protocol === 1 && target.baseRevision === build.revision && target.revision !== build.revision && (target.channel === 'stable' ? semver.gt(target.version, build.version) : semver.gte(target.version, build.version));
}
export async function selectTarget(channel: Channel, mode: Build['mode'], fetcher: typeof fetch = fetch, sourceBuild = false): Promise<Target> {
  if (mode === 'runtime' && channel !== 'stable') throw Error('Prepared runtimes require stable releases');
  let revision: string, version: string, notes = '', url: string;
  if (channel === 'stable') {
    const release = await github('releases/latest', fetcher);
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('No stable release is ready');
    const commit = await github(`commits/${release.tag_name}`, fetcher);
    revision = commit.sha; version = release.tag_name.slice(1); notes = String(release.body ?? '').slice(0, 40_000);
    url = `https://github.com/${UPSTREAM}/releases/tag/v${version}`;
  } else {
    const commit = await github('commits/main', fetcher); revision = commit.sha;
    // Require the complete workflow, including image publishing, for this exact revision.
    const runs = await github(`actions/workflows/check.yml/runs?head_sha=${revision}&event=push&status=success&per_page=10`, fetcher);
    if (!runs.workflow_runs?.some((r: any) => r.head_sha === revision && r.conclusion === 'success' && r.head_branch === 'main')) throw Error('Main has not completed validation');
    version = ''; url = `https://github.com/${UPSTREAM}/commit/${revision}`;
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid release revision');
  const file = await github(`contents/package.json?ref=${revision}`, fetcher);
  const pkg = JSON.parse(Buffer.from(file.content, 'base64').toString());
  if (pkg.managedUpgradeProtocol !== 1) throw Error('This release does not support gated managed startup; use a compatible release');
  if (!semver.valid(pkg.version) || (version && pkg.version !== version)) throw Error('Release version does not match its source');
  const target: Target = { version: pkg.version, revision, channel, notes, url, protocol: 1 };
  if (mode === 'runtime') {
    const response = await fetcher(`https://github.com/${UPSTREAM}/releases/download/v${target.version}/runtime-darwin-${process.arch}.json`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error('Prepared runtime is not ready');
    const m = await response.json() as NonNullable<Target['runtime']>;
    if (m.origin !== UPSTREAM || m.version !== target.version || m.revision !== target.revision || m.protocol !== 1 || m.platform !== 'darwin' || m.arch !== process.arch || !['arm64', 'x64'].includes(m.arch) || m.archive !== `switchboard-runtime-darwin-${m.arch}.tar.gz` || !/^[a-f0-9]{64}$/.test(m.sha256)) throw Error('Incompatible prepared runtime');
    target.runtime = m;
  }
  if (mode === 'compose' && !sourceBuild) target.image = await imageDigest(revision, fetcher);
  return target;
}

export async function bindTarget(build: Build, target: Target, fetcher: typeof fetch = fetch): Promise<Target> {
  if (!build.custom && build.revision && target.revision !== build.revision) {
    const comparison = await github(`compare/${build.revision}...${target.revision}`, fetcher);
    if (comparison.status !== 'ahead' || comparison.base_commit?.sha !== build.revision || comparison.merge_base_commit?.sha !== build.revision) throw Error('Target is not a verified descendant of the running build');
  }
  return { ...target, baseRevision: build.revision ?? undefined };
}
