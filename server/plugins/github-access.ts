import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { getConnectionRow, listConnections, loadConnection, toView, type ConnectionView } from '../connections.ts';
import { execute } from '../proxy.ts';
import type { Caller } from '../audit.ts';
import type { User } from '../users.ts';
import { HttpError, badRequest } from '../http.ts';

export type ReleaseChannel = 'latest' | 'release' | 'branch';
export interface RepoRef { repo: string; ref?: string; path?: string; channel?: ReleaseChannel }
export interface GithubContext {
  user?: User;
  caller?: Caller;
  githubConnectionId?: string | null;
  preferredConnectionId?: string;
}
interface Credential { connectionId?: string; configured?: boolean; peer?: boolean }

export function connectionOption(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw badRequest('githubConnectionId must be a connection id or null');
  return value.trim();
}

/** Accepts owner/repo, GitHub folder URLs, and owner/repo@ref. */
export function parseRepo(input: string, ref?: string, subpath?: string): RepoRef {
  if (typeof input !== 'string' || (ref !== undefined && typeof ref !== 'string') || (subpath !== undefined && typeof subpath !== 'string')) throw badRequest('repo, ref and path must be strings');
  let s = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  let parsedRef: string | undefined;
  let parsedPath: string | undefined;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/);
  if (url) { s = `${url[1]}/${url[2]}`; parsedRef = url[3]; parsedPath = url[4]; }
  else {
    const at = s.match(/^([^/@\s]+\/[^/@\s]+)@(.+)$/);
    if (at) { s = at[1]; parsedRef = at[2]; }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) || s.split('/').some((p) => p === '.' || p === '..')) throw badRequest('Use owner/repo or a github.com URL');
  const p = (subpath?.trim() || parsedPath || '').replace(/^\/+|\/+$/g, '');
  if (p.split('/').some((part) => part === '..' || part === '.') || /[\\\x00-\x1f\x7f]/.test(p)) throw badRequest('Invalid path');
  const r = ref?.trim() || parsedRef || undefined;
  if (r && /[\x00-\x20\x7f]/.test(r)) throw badRequest('Invalid branch, tag or commit');
  return { repo: s, ref: r, path: p || undefined };
}

function isGithubConnection(connection: ConnectionView): boolean {
  return connection.kind === 'http' && (connection.peer
    ? /^(?:peer\/[A-Za-z0-9_-]+\/)+github$/.test(connection.serviceId)
    : connection.serviceId === 'github');
}

/** Validate the acting user's handle without loading credentials from another instance. */
export function githubConnection(userId: string, ref: string): ConnectionView {
  const row = getConnectionRow(userId, ref);
  const connection = toView(row);
  if (!isGithubConnection(connection)) throw badRequest('Select a GitHub HTTP connection');
  if (connection.status === 'unavailable') throw new HttpError(503, connection.statusMessage ?? 'The GitHub connection is unavailable');
  if (!row.peer_id) loadConnection(userId, row.id);
  return connection;
}

function retryCredential(error: unknown, credential: Credential, ctx: GithubContext): error is HttpError {
  return !!credential.connectionId && !ctx.githubConnectionId && error instanceof HttpError
    && (error.message.startsWith('Could not authenticate with') || (!!credential.peer && [403, 404, 503, 504].includes(error.status)));
}

function credentials(ctx: GithubContext): Credential[] {
  const requested = connectionOption(ctx.githubConnectionId);
  if (requested) {
    if (!ctx.user) throw badRequest('A signed-in administrator is required to select a GitHub connection');
    const connection = githubConnection(ctx.user.id, requested);
    return [{ connectionId: connection.id, peer: !!connection.peer }];
  }
  const connections = ctx.user ? listConnections(ctx.user.id).filter((c) => isGithubConnection(c) && c.status !== 'unavailable') : [];
  const preferred = requested === null ? undefined : ctx.preferredConnectionId;
  connections.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [{}, ...(config.githubToken ? [{ configured: true }] : []), ...connections.map((c) => ({ connectionId: c.id, peer: !!c.peer }))];
}

async function request(url: string, accept: string, credential: Credential, ctx: GithubContext, fresh = false): Promise<Response> {
  const headers: Record<string, string> = { accept, 'user-agent': 'switchboard', 'x-github-api-version': '2022-11-28' };
  if (fresh) headers['cache-control'] = 'no-cache';
  if (credential.connectionId) {
    return (await execute(ctx.user!, credential.connectionId, { method: 'GET', url, headers: Object.entries(headers) }, undefined, ctx.caller)).response;
  }
  if (credential.configured) headers.authorization = `Bearer ${config.githubToken}`;
  try { return await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(fresh ? 10_000 : 120_000), ...(fresh ? { cache: 'no-store' as const } : {}) }); }
  catch { throw badRequest('Could not reach GitHub; try again later'); }
}

async function githubError(res: Response, repo: string): Promise<Error> {
  await res.body?.cancel();
  if (res.status === 404) return badRequest(`Repository or ref ${repo} was not found or is inaccessible. Check the ref, GitHub connection and repository permissions.`);
  if (res.status === 401) return badRequest('GitHub rejected the credentials; reconnect the account');
  if (res.status === 403 || res.status === 429) {
    const limited = res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
    return badRequest(limited ? 'GitHub rate limit reached; try again later or choose another GitHub connection' : 'GitHub denied access; check repository permissions and organization authorization');
  }
  return badRequest(`GitHub responded ${res.status}; try again later`);
}

const accessFailure = (res: Response) => [401, 403, 404, 429].includes(res.status);

/** Fetch a fresh file through the same user-scoped credential fallback as installs. */
export async function repositoryFile(input: RepoRef & { path: string }, ctx: GithubContext = {}): Promise<Response> {
  let error: Error | undefined;
  const url = `https://api.github.com/repos/${input.repo}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.ref ?? 'HEAD')}`;
  for (const credential of credentials(ctx)) {
    let res: Response;
    try { res = await request(url, 'application/vnd.github.raw+json', credential, ctx, true); }
    catch (e) {
      if (retryCredential(e, credential, ctx)) { error = e; continue; }
      throw e;
    }
    if (res.ok) return res;
    const retry = accessFailure(res);
    error = await githubError(res, input.repo);
    if (!retry) throw error;
  }
  throw error ?? badRequest('No usable GitHub credentials');
}

async function resolveWith(repo: string, ref: string | undefined, credential: Credential, ctx: GithubContext) {
  const res = await request(`https://api.github.com/repos/${repo}/commits/${ref ? encodeURIComponent(ref) : 'HEAD'}`, 'application/vnd.github.sha', credential, ctx);
  return res;
}

export async function resolveCommit(repo: string, ref?: string, ctx: GithubContext = {}): Promise<string> {
  let error: Error | undefined;
  for (const credential of credentials(ctx)) {
    let res: Response;
    try { res = await resolveWith(repo, ref, credential, ctx); }
    catch (e) {
      // A broken stored sign-in or unavailable peer must not prevent trying another account.
      if (retryCredential(e, credential, ctx)) { error = e; continue; }
      throw e;
    }
    if (res.ok) return (await res.text()).trim();
    const retry = accessFailure(res);
    error = await githubError(res, repo);
    if (!retry) throw error;
  }
  throw error ?? badRequest('No usable GitHub credentials');
}

export interface PluginRelease { tag: string; name: string; prerelease: boolean; publishedAt: string; url: string }

/** Published releases only; never infer a release from a branch or an unassociated tag. */
export async function repositoryReleases(input: RepoRef, ctx: GithubContext = {}): Promise<PluginRelease[]> {
  let error: Error | undefined;
  for (const credential of credentials(ctx)) {
    const releases: PluginRelease[] = [];
    let denied = false;
    for (let page = 1; ; page++) {
      let res: Response;
      try { res = await request(`https://api.github.com/repos/${input.repo}/releases?per_page=100&page=${page}`, 'application/vnd.github+json', credential, ctx); }
      catch (e) {
        if (retryCredential(e, credential, ctx)) { error = e; denied = true; break; }
        throw e;
      }
      if (!res.ok) {
        const retry = accessFailure(res);
        error = await githubError(res, input.repo);
        if (!retry) throw error;
        denied = true; break;
      }
      const items = await res.json();
      if (!Array.isArray(items)) throw badRequest('GitHub returned an invalid release list');
      for (const r of items) if (!r.draft && r.published_at && typeof r.tag_name === 'string') {
        releases.push({ tag: r.tag_name, name: r.name || r.tag_name, prerelease: !!r.prerelease, publishedAt: r.published_at, url: `https://github.com/${input.repo}/releases/tag/${encodeURIComponent(r.tag_name)}` });
      }
      if (items.length < 100) break;
      if (page === 100) throw badRequest('Too many releases to list; choose a repository with fewer releases');
    }
    if (denied) continue;
    // release-please supports both repository-wide v1.2.3 and component-v1.2.3 tags.
    const component = input.path?.split('/').at(-1);
    let scoped = component ? releases.filter((r) => r.tag.startsWith(`${component}-v`)) : [];
    // A migrated plugin can keep its ID/tag prefix while living in a shorter folder
    // (e.g. plugins/teams contains teams-web, released as teams-web-v0.12.2).
    if (!scoped.length && input.path && releases.some((r) => /^[a-z][a-z0-9-]*-v\d/.test(r.tag))) {
      const file = [...input.path.split('/'), 'plugin.json'].map(encodeURIComponent).join('/');
      const ref = input.channel === 'release' && input.ref ? input.ref : 'HEAD';
      let res: Response;
      try { res = await request(`https://api.github.com/repos/${input.repo}/contents/${file}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw+json', credential, ctx, true); }
      catch (e) { if (retryCredential(e, credential, ctx)) { error = e; continue; } throw e; }
      if (res.status === 404) await res.body?.cancel(); // Preserve repository-wide releases for non-plugin folders.
      else if (!res.ok) {
        const retry = accessFailure(res);
        error = await githubError(res, input.repo);
        if (retry) continue;
        throw error;
      } else {
        let manifest: { id?: unknown };
        try { manifest = await res.json(); } catch { throw badRequest('GitHub returned an invalid plugin manifest'); }
        if (!manifest || typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id)) throw badRequest('GitHub returned an invalid plugin manifest');
        scoped = releases.filter((r) => r.tag.startsWith(`${manifest.id}-v`));
      }
    }
    const result = scoped.length ? scoped : releases.filter((r) => !/^[a-z][a-z0-9-]*-v\d/.test(r.tag));
    return result;
  }
  throw error ?? badRequest('No usable GitHub credentials');
}

/** Honor GitHub's designated latest release for repositories with one release stream. */
async function latestReleaseTag(repo: string, ctx: GithubContext): Promise<string> {
  let error: Error | undefined;
  for (const credential of credentials(ctx)) {
    let res: Response;
    try { res = await request(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json', credential, ctx); }
    catch (e) {
      if (retryCredential(e, credential, ctx)) { error = e; continue; }
      throw e;
    }
    if (res.ok) {
      const release = await res.json();
      if (release.draft || release.prerelease || !release.published_at || typeof release.tag_name !== 'string') throw badRequest('GitHub returned an invalid latest release');
      return release.tag_name;
    }
    const retry = accessFailure(res);
    error = await githubError(res, repo);
    if (!retry) throw error;
  }
  throw error ?? badRequest('No usable GitHub credentials');
}

export function releaseChannel(input: RepoRef): ReleaseChannel {
  return input.channel ?? (input.ref ? 'branch' : 'latest');
}

/** Resolve the selected policy to a published tag, leaving the policy intact. */
export async function releaseRef(input: RepoRef, ctx: GithubContext = {}): Promise<RepoRef> {
  const channel = releaseChannel(input);
  if (channel === 'branch') return { ...input, channel };
  const releases = await repositoryReleases(input, ctx);
  let release = channel === 'release' ? releases.find((r) => r.tag === input.ref) : releases.find((r) => !r.prerelease);
  if (channel === 'latest' && release && !/^[a-z][a-z0-9-]*-v\d/.test(release.tag)) {
    const tag = await latestReleaseTag(input.repo, ctx);
    release = releases.find((r) => r.tag === tag && !r.prerelease);
  }
  if (!release) throw badRequest(channel === 'release' ? 'The selected version is not a published release for this plugin' : 'No stable release is published for this plugin. Choose a development branch explicitly.');
  return { ...input, channel, ref: release.tag };
}

export interface RepositoryArchive { dir: string; commit: string; githubConnectionId?: string; access: GithubContext }

/** Resolve and download using one credential. Auth is never forwarded to codeload. */
export async function repositoryArchive(input: RepoRef, ctx: GithubContext = {}): Promise<RepositoryArchive> {
  let error: Error | undefined;
  for (const credential of credentials(ctx)) {
    let resolved: Response;
    try { resolved = await resolveWith(input.repo, input.ref, credential, ctx); }
    catch (e) {
      if (retryCredential(e, credential, ctx)) { error = e; continue; }
      throw e;
    }
    if (!resolved.ok) {
      const retry = accessFailure(resolved);
      error = await githubError(resolved, input.repo);
      if (retry) continue;
      throw error;
    }
    const commit = (await resolved.text()).trim();
    let archive: Response;
    try { archive = await request(`https://api.github.com/repos/${input.repo}/tarball/${commit}`, 'application/vnd.github+json', credential, ctx); }
    catch (e) {
      if (retryCredential(e, credential, ctx)) { error = e; continue; }
      throw e;
    }
    if (accessFailure(archive)) { error = await githubError(archive, input.repo); continue; }
    if (archive.status === 302) {
      const location = archive.headers.get('location');
      await archive.body?.cancel();
      if (!location) throw badRequest('GitHub did not supply an archive URL');
      const url = new URL(location);
      if (url.protocol !== 'https:' || url.hostname !== 'codeload.github.com' || url.port || url.username || url.password) throw badRequest('GitHub supplied an unexpected archive host');
      try { archive = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
      catch { throw badRequest('Could not download the GitHub archive; try again later'); }
    }
    if (!archive.ok) throw await githubError(archive, input.repo);
    const dir = path.join(config.dataDir, 'tmp', `plugin-download-${randomToken(8)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      await pipeline(Readable.fromWeb(archive.body as any), tar.x({ cwd: dir, strip: 1, strict: true, filter: (_name, entry) => 'type' in entry && (entry.type === 'File' || entry.type === 'Directory') }));
      return { dir, commit, githubConnectionId: credential.connectionId, access: ctx };
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  }
  throw error ?? badRequest('No usable GitHub credentials');
}
