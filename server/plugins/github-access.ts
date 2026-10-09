import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { listConnections, loadConnection } from '../connections.ts';
import { execute } from '../proxy.ts';
import type { Caller } from '../audit.ts';
import type { User } from '../users.ts';
import { HttpError, badRequest } from '../http.ts';

export interface RepoRef { repo: string; ref?: string; path?: string }
export interface GithubContext {
  user?: User;
  caller?: Caller;
  githubConnectionId?: string | null;
  preferredConnectionId?: string;
}
interface Credential { connectionId?: string; configured?: boolean }

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

function credentials(ctx: GithubContext): Credential[] {
  const requested = connectionOption(ctx.githubConnectionId);
  if (requested) {
    if (!ctx.user) throw badRequest('A signed-in administrator is required to select a GitHub connection');
    const { row, conn } = loadConnection(ctx.user.id, requested);
    if (row.peer_id || conn.kind !== 'http' || conn.serviceId !== 'github') throw badRequest('Select a local GitHub connection');
    return [{ connectionId: conn.id }];
  }
  const connections = ctx.user ? listConnections(ctx.user.id).filter((c) => c.serviceId === 'github' && c.kind === 'http' && !c.peer && c.status !== 'unavailable') : [];
  const preferred = requested === null ? undefined : ctx.preferredConnectionId;
  connections.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [{}, ...(config.githubToken ? [{ configured: true }] : []), ...connections.map((c) => ({ connectionId: c.id }))];
}

async function request(url: string, accept: string, credential: Credential, ctx: GithubContext): Promise<Response> {
  const headers: Record<string, string> = { accept, 'user-agent': 'switchboard', 'x-github-api-version': '2022-11-28' };
  if (credential.connectionId) {
    return (await execute(ctx.user!, credential.connectionId, { method: 'GET', url, headers: Object.entries(headers) }, undefined, ctx.caller)).response;
  }
  if (credential.configured) headers.authorization = `Bearer ${config.githubToken}`;
  try { return await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(120_000) }); }
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
      // A broken stored sign-in must not prevent automatic mode trying another account.
      if (credential.connectionId && !ctx.githubConnectionId && e instanceof HttpError && e.message.startsWith('Could not authenticate with')) { error = e; continue; }
      throw e;
    }
    if (res.ok) return (await res.text()).trim();
    const retry = accessFailure(res);
    error = await githubError(res, repo);
    if (!retry) throw error;
  }
  throw error ?? badRequest('No usable GitHub credentials');
}

export interface RepositoryArchive { dir: string; commit: string; githubConnectionId?: string; access: GithubContext }

/** Resolve and download using one credential. Auth is never forwarded to codeload. */
export async function repositoryArchive(input: RepoRef, ctx: GithubContext = {}): Promise<RepositoryArchive> {
  let error: Error | undefined;
  for (const credential of credentials(ctx)) {
    let resolved: Response;
    try { resolved = await resolveWith(input.repo, input.ref, credential, ctx); }
    catch (e) {
      if (credential.connectionId && !ctx.githubConnectionId && e instanceof HttpError && e.message.startsWith('Could not authenticate with')) { error = e; continue; }
      throw e;
    }
    if (!resolved.ok) {
      const retry = accessFailure(resolved);
      error = await githubError(resolved, input.repo);
      if (retry) continue;
      throw error;
    }
    const commit = (await resolved.text()).trim();
    let archive = await request(`https://api.github.com/repos/${input.repo}/tarball/${commit}`, 'application/vnd.github+json', credential, ctx);
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
