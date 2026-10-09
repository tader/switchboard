import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lt, satisfies, valid } from 'semver';
import { randomToken } from '../crypto.ts';
import { now, one, run } from '../db.ts';
import { HttpError, badRequest } from '../http.ts';
import type { PluginManifest } from './api.ts';
import { type GithubSource, installedDir, plugins, upsertRow, validateManifest } from './manager.ts';
import { communityCatalog, type PluginCatalog } from './catalog.ts';
import { connectionOption, parseRepo, repositoryArchive, resolveCommit, type GithubContext, type RepoRef, type RepositoryArchive } from './github-access.ts';

export { parseRepo, resolveCommit };
export type { RepoRef, GithubContext };
export interface UpdateOptions { ref?: string | null; githubConnectionId?: string | null }
export interface UpdateRequest extends UpdateOptions { id: string }
export interface PlanChange {
  id: string; name: string; fromVersion: string | null; version: string;
  action: 'install' | 'update'; dependency: boolean; source: GithubSource;
}
export interface PluginPlan {
  planId: string; expiresAt: number; changes: PlanChange[];
  affectedDependents: string[]; requiresReview: boolean;
}
interface Candidate { manifest: PluginManifest; archive: RepositoryArchive; source: GithubSource; rel: string; explicit: boolean }
interface StoredPlan {
  view: PluginPlan; owner: string; snapshot: string; candidates: Candidate[];
  archives: RepositoryArchive[]; timer: NodeJS.Timeout;
}
const plans = new Map<string, StoredPlan>();
const owner = (ctx: GithubContext) => ctx.user?.id ?? 'internal';
const stale = () => new HttpError(409, 'Plugin state changed or the preview expired. Review a new preview before applying.');

function cleanup(plan: StoredPlan) {
  clearTimeout(plan.timer);
  plans.delete(plan.view.planId);
  for (const a of plan.archives) fs.rmSync(a.dir, { recursive: true, force: true });
}

/** Include code and settings, not just versions: local hot reloads also invalidate previews. */
function snapshot(): string {
  const hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const file = path.join(dir, e.name);
      hash.update(file);
      if (e.isDirectory()) visit(file);
      else if (e.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else if (e.isFile()) hash.update(fs.readFileSync(file));
    }
  };
  for (const p of [...plugins.plugins.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(JSON.stringify([p.id, p.manifest, p.source, p.enabled, p.status, one('SELECT settings_enc FROM plugins WHERE id = ?', p.id)]));
    visit(p.dir);
  }
  return hash.digest('hex');
}

function findPlugins(root: string, sub?: string): string[] {
  const base = sub ? path.resolve(root, sub) : root;
  if (base !== root && !base.startsWith(root + path.sep)) throw badRequest('Invalid plugin path');
  if (!fs.existsSync(base)) throw badRequest(`Path "${sub}" does not exist in the repository`);
  if (fs.existsSync(path.join(base, 'plugin.json'))) return [path.relative(root, base)];
  const out = pluginFolders(base).map((rel) => path.relative(root, path.join(base, rel)));
  if (!out.length) throw badRequest('No plugin.json found in the repository');
  return out;
}

/** Dependency discovery also scans helpers beside a repository-root plugin. */
function pluginFolders(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, 'plugin.json'))) out.push('');
  for (const parent of [root, path.join(root, 'plugins')]) {
    if (!fs.existsSync(parent)) continue;
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(parent, e.name, 'plugin.json'))) out.push(path.relative(root, path.join(parent, e.name)));
    }
  }
  return out;
}

function candidate(archive: RepositoryArchive, input: RepoRef, rel: string, explicit: boolean, expectedId?: string): Candidate {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(archive.dir, rel, 'plugin.json'), 'utf8'));
    validateManifest(manifest);
  } catch (e: any) { throw badRequest(`${input.repo}/${rel || 'plugin.json'}: ${e.message}`); }
  if (expectedId && manifest.id !== expectedId) throw badRequest(`The plugin at ${input.repo}/${rel} now has id "${manifest.id}"; expected "${expectedId}"`);
  return { manifest, archive, rel, explicit, source: { type: 'github', repo: input.repo, ref: input.ref, path: rel.split(path.sep).join('/'), commit: archive.commit, githubConnectionId: archive.githubConnectionId } };
}

function compatible(manifest: PluginManifest, range?: string): boolean {
  return !range || (!!valid(manifest.version) && satisfies(manifest.version, range));
}

export function updateOptions(input: unknown): UpdateOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Expected an object with an optional ref');
  const { ref, githubConnectionId } = input as { ref?: unknown; githubConnectionId?: unknown };
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || !ref.trim() || /[\x00-\x20\x7f]/.test(ref.trim()))) throw badRequest('ref must be a nonempty branch, tag or commit, or null for the default branch');
  const option = connectionOption(githubConnectionId);
  return { ref: typeof ref === 'string' ? ref.trim() : ref, ...(option !== undefined ? { githubConnectionId: option } : {}) };
}

export async function previewInstall(input: RepoRef, ctx: GithubContext = {}, expectedId?: string): Promise<PluginPlan> {
  const parsed = parseRepo(input.repo, input.ref, input.path);
  if (expectedId !== undefined && (typeof expectedId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expectedId))) throw badRequest('Invalid expected plugin id');
  return buildPlan({ input: parsed, expectedId }, [], ctx);
}

export async function previewUpdates(requests: UpdateRequest[], ctx: GithubContext = {}): Promise<PluginPlan> {
  if (!Array.isArray(requests) || !requests.length || requests.length > 100 || requests.some((r) => !r || typeof r.id !== 'string') || new Set(requests.map((r) => r.id)).size !== requests.length) throw badRequest('updates must contain 1–100 unique plugin ids');
  return buildPlan(undefined, requests.map((r) => ({ id: r.id, ...updateOptions(r) })), ctx);
}

async function buildPlanNow(installation: { input: RepoRef; expectedId?: string } | undefined, updates: UpdateRequest[], ctx: GithubContext): Promise<PluginPlan> {
  const before = snapshot();
  const archives: RepositoryArchive[] = [];
  const fetched = new Map<string, Promise<RepositoryArchive>>();
  const selected = new Map<string, Candidate>();
  let catalog: PluginCatalog | undefined;
  const fetchArchive = async (input: RepoRef, access = ctx) => {
    const key = JSON.stringify([input.repo, input.ref, access.githubConnectionId, access.preferredConnectionId]);
    if (!fetched.has(key)) fetched.set(key, repositoryArchive(input, access).then((a) => { archives.push(a); return a; }));
    return fetched.get(key)!;
  };
  const add = (c: Candidate) => {
    const existing = selected.get(c.manifest.id);
    if (existing && JSON.stringify(existing.source) !== JSON.stringify(c.source)) throw badRequest(`Conflicting sources for plugin ${c.manifest.id}`);
    selected.set(c.manifest.id, c);
  };
  try {
    if (installation) {
      const { input, expectedId } = installation;
      const a = await fetchArchive(input);
      const rels = findPlugins(a.dir, input.path);
      if (expectedId && rels.length !== 1) throw badRequest('A community listing must identify one plugin folder');
      for (const rel of rels) add(candidate(a, input, rel, true, expectedId));
    }
    for (const r of updates) {
      const p = plugins.get(r.id);
      const s = p.source;
      if (s?.type !== 'github') throw badRequest('Only plugins installed from GitHub can be updated');
      const input = { repo: s.repo, ref: r.ref === undefined ? s.ref : r.ref ?? undefined, path: s.path };
      const a = await fetchArchive(input, { ...ctx, githubConnectionId: r.githubConnectionId === undefined ? ctx.githubConnectionId : r.githubConnectionId, preferredConnectionId: s.githubConnectionId });
      if (!fs.existsSync(path.join(a.dir, s.path, 'plugin.json'))) throw badRequest(`The repository no longer contains ${s.path || 'plugin.json'}`);
      add(candidate(a, input, s.path, true, p.id));
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const ensure = async (manifest: PluginManifest, parent?: Candidate) => {
      if (visiting.has(manifest.id)) throw badRequest(`Dependency cycle involving ${manifest.id}`);
      if (done.has(manifest.id)) return;
      visiting.add(manifest.id);
      for (const id of manifest.dependencies ?? []) {
        const range = manifest.dependencyVersions?.[id];
        const installed = plugins.plugins.get(id);
        if (installed && !installed.enabled) throw badRequest(`Enable dependency ${id} before installing or updating ${manifest.id}`);
        let dep = selected.get(id);
        if (!dep && (!installed || !compatible(installed.manifest, range))) {
          if (installed) {
            const s = installed.source;
            if (!s) throw badRequest(`${manifest.id} requires ${id} ${range}; ${installed.manifest.version} is installed. ${installed.origin === 'builtin' ? 'Upgrade Switchboard' : 'Update the locally installed dependency'} first.`);
            const input = { repo: s.repo, ref: s.ref, path: s.path };
            const a = await fetchArchive(input, { ...(parent?.archive.access ?? ctx), preferredConnectionId: s.githubConnectionId });
            dep = candidate(a, input, s.path, false, id);
            if (valid(installed.manifest.version) && valid(dep.manifest.version) && lt(dep.manifest.version, installed.manifest.version)) throw badRequest(`Dependency ${id} would be downgraded; choose a compatible tracked ref first`);
          } else {
            // A dependency may be another folder in the requested repository.
            if (parent) {
              const matches = pluginFolders(parent.archive.dir).filter((rel) => {
                try { return JSON.parse(fs.readFileSync(path.join(parent.archive.dir, rel, 'plugin.json'), 'utf8')).id === id; } catch { return false; }
              });
              if (matches.length > 1) throw badRequest(`Multiple folders provide dependency ${id}`);
              if (matches.length) dep = candidate(parent.archive, parent.source, matches[0], false, id);
            }
            if (!dep) {
              catalog ??= await communityCatalog();
              const listing = catalog.plugins.find((p) => p.id === id);
              if (!listing) throw badRequest(`Dependency ${id} is not installed and has no community catalog listing`);
              const input = parseRepo(listing.repo, listing.ref, listing.path);
              const a = await fetchArchive(input, parent?.archive.access ?? ctx);
              const rels = findPlugins(a.dir, input.path);
              if (rels.length !== 1) throw badRequest(`Catalog dependency ${id} must identify one plugin folder`);
              dep = candidate(a, input, rels[0], false, id);
            }
          }
          done.delete(id);
          add(dep);
        }
        const actual = dep?.manifest ?? installed!.manifest;
        if (!compatible(actual, range)) throw badRequest(`${manifest.id} requires ${id} ${range}; candidate version is ${actual.version}. Choose a compatible tracked or catalog ref.`);
        await ensure(actual, dep ?? parent);
      }
      visiting.delete(manifest.id);
      done.add(manifest.id);
    };
    for (const c of selected.values()) if (plugins.plugins.get(c.manifest.id)?.enabled !== false) await ensure(c.manifest, c);
    // Check existing enabled dependents too, including requirements from multiple parents.
    const final = new Map([...plugins.plugins.values()].map((p) => [p.id, p.manifest]));
    for (const c of selected.values()) final.set(c.manifest.id, c.manifest);
    for (const [id, m] of final) {
      if (plugins.plugins.get(id)?.enabled === false) continue;
      for (const dep of m.dependencies ?? []) {
        const range = m.dependencyVersions?.[dep];
        if (selected.has(dep) && range && !compatible(final.get(dep)!, range)) throw badRequest(`Cannot upgrade ${dep}: ${id} requires ${range}, but the candidate is ${final.get(dep)!.version}`);
      }
    }
    const changed = new Set(selected.keys());
    const affected = new Set<string>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [id, m] of final) if (!changed.has(id) && !affected.has(id) && m.dependencies?.some((d) => changed.has(d) || affected.has(d))) { affected.add(id); expanded = true; }
    }
    if (snapshot() !== before) throw stale();
    const changes = [...selected.values()].map((c): PlanChange => {
      const previous = plugins.plugins.get(c.manifest.id);
      return { id: c.manifest.id, name: c.manifest.name, fromVersion: previous?.manifest.version ?? null, version: c.manifest.version, action: previous ? 'update' : 'install', dependency: !c.explicit, source: c.source };
    });
    const view: PluginPlan = { planId: randomToken(24), expiresAt: now() + 10 * 60_000, changes, affectedDependents: [...affected].sort(), requiresReview: changes.some((c) => c.dependency && c.action === 'update') };
    // Bound retained previews; another tab can simply request a new one.
    for (const p of [...plans.values()].filter((p) => p.owner === owner(ctx)).slice(0, -9)) cleanup(p);
    if (plans.size >= 100) cleanup(plans.values().next().value!);
    const timer = setTimeout(() => { const p = plans.get(view.planId); if (p) cleanup(p); }, 10 * 60_000);
    timer.unref();
    plans.set(view.planId, { view, owner: owner(ctx), snapshot: before, candidates: [...selected.values()], archives, timer });
    return view;
  } catch (e) { for (const a of archives) fs.rmSync(a.dir, { recursive: true, force: true }); throw e; }
}

function buildPlan(installation: { input: RepoRef; expectedId?: string } | undefined, updates: UpdateRequest[], ctx: GithubContext) {
  return plugins.serial(() => buildPlanNow(installation, updates, ctx));
}

function place(c: Candidate) {
  const id = c.manifest.id;
  const dest = path.join(installedDir(), id);
  const staging = path.join(installedDir(), `.${id}.new-${randomToken(4)}`);
  plugins.quiet(id, 10_000);
  try {
    fs.cpSync(path.join(c.archive.dir, c.rel), staging, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  upsertRow(id);
  run('UPDATE plugins SET source = ?, installed_at = COALESCE(installed_at, ?), updated_at = ? WHERE id = ?', JSON.stringify(c.source), now(), now(), id);
}

async function applyPlanNow(planId: string, ctx: GithubContext, reload: (ids: string[]) => Promise<void>) {
  if (typeof planId !== 'string') throw badRequest('planId is required');
  const plan = plans.get(planId);
  if (!plan || plan.owner !== owner(ctx)) throw stale();
  if (plan.view.expiresAt <= now() || snapshot() !== plan.snapshot) { cleanup(plan); throw stale(); }
  clearTimeout(plan.timer);
  const ids = plan.candidates.map((c) => c.manifest.id);
  const activeBefore = [...plugins.plugins.values()].filter((p) => p.status === 'active').map((p) => p.id);
  const changes = plan.candidates.map((c) => {
    const s = plugins.plugins.get(c.manifest.id)?.source;
    return { id: c.manifest.id, from: s?.commit ?? null, to: c.source.commit, fromRef: s?.ref ?? null, ref: c.source.ref ?? null };
  });
  const backups: { id: string; backup: string; existed: boolean; row: any }[] = [];
  let placed = false;
  try {
    // Recheck explicit/successful saved connections before code can be installed.
    for (const c of plan.candidates) if (c.source.githubConnectionId) {
      if (!ctx.user) throw badRequest('The GitHub connection is no longer accessible');
      const { conn } = await import('../connections.ts').then((m) => m.loadConnection(ctx.user!.id, c.source.githubConnectionId!));
      if (conn.serviceId !== 'github' || conn.kind !== 'http') throw badRequest('The GitHub connection is no longer accessible');
    }
    for (const id of ids) {
      const dest = path.join(installedDir(), id);
      const backup = path.join(installedDir(), `.${id}.previous-${randomToken(8)}`);
      const existed = fs.existsSync(dest);
      backups.push({ id, backup, existed, row: one('SELECT * FROM plugins WHERE id = ?', id) });
      if (existed) fs.cpSync(dest, backup, { recursive: true });
    }
    placed = true;
    for (const c of plan.candidates) place(c);
    await reload(ids);
    for (const id of new Set([...ids, ...activeBefore])) {
      const p = plugins.get(id);
      if (p.status === 'error' || (p.enabled && p.status !== 'active')) throw badRequest(`Could not activate ${id}: ${p.error ?? p.status}`);
    }
    return { ids, changes };
  } catch (e) {
    if (placed) {
      for (const b of backups) {
        plugins.quiet(b.id, 10_000);
        fs.rmSync(path.join(installedDir(), b.id), { recursive: true, force: true });
        if (b.existed) fs.renameSync(b.backup, path.join(installedDir(), b.id));
        if (b.row) run('UPDATE plugins SET enabled = ?, source = ?, settings_enc = ?, installed_at = ?, updated_at = ? WHERE id = ?', b.row.enabled, b.row.source, b.row.settings_enc, b.row.installed_at, b.row.updated_at, b.id);
        else run('DELETE FROM plugins WHERE id = ?', b.id);
      }
      await reload(ids);
    }
    throw e;
  } finally {
    for (const b of backups) fs.rmSync(b.backup, { recursive: true, force: true });
    cleanup(plan);
  }
}

export function applyPlan(planId: string, ctx: GithubContext = {}) {
  return plugins.mutate((reload) => applyPlanNow(planId, ctx, reload));
}

function requireReview(plan: PluginPlan) {
  if (plan.requiresReview) {
    const error = new HttpError(409, 'A shared dependency needs upgrading. Review the coordinated installation or update first.');
    Object.assign(error, { code: 'plugin_review_required', plan });
    throw error;
  }
}

export async function install(input: RepoRef, ctx: GithubContext = {}): Promise<string[]> {
  return plugins.mutate(async (reload) => {
    const plan = await buildPlanNow({ input: parseRepo(input.repo, input.ref, input.path) }, [], ctx);
    requireReview(plan);
    return (await applyPlanNow(plan.planId, ctx, reload)).ids;
  });
}

export async function update(id: string, options: UpdateOptions = {}, ctx: GithubContext = {}) {
  return plugins.mutate(async (reload) => {
    const plan = await buildPlanNow(undefined, [{ id, ...updateOptions(options) }], ctx);
    requireReview(plan);
    return (await applyPlanNow(plan.planId, ctx, reload)).changes.find((c) => c.id === id)!;
  });
}

export async function checkUpdates(ctx: GithubContext = {}) {
  const installed = [...plugins.plugins.values()].filter((p) => p.source?.type === 'github');
  const latest = new Map<string, Promise<string>>();
  return Promise.all(installed.map(async (p) => {
    const s = p.source!;
    const key = JSON.stringify([s.repo, s.ref, s.githubConnectionId, ctx.githubConnectionId]);
    try {
      if (!latest.has(key)) latest.set(key, resolveCommit(s.repo, s.ref, { ...ctx, preferredConnectionId: s.githubConnectionId }));
      const commit = await latest.get(key)!;
      return { id: p.id, ref: s.ref ?? null, current: s.commit, latest: commit, updateAvailable: commit !== s.commit };
    } catch (e: any) { return { id: p.id, ref: s.ref ?? null, current: s.commit, error: e.message, updateAvailable: false }; }
  }));
}

export async function uninstall(id: string) {
  return plugins.mutate(async (reload) => {
    const p = plugins.get(id);
    if (p.origin !== 'installed') throw badRequest('Built-in plugins cannot be removed; disable them instead');
    plugins.quiet(id);
    fs.rmSync(p.dir, { recursive: true, force: true });
    run('UPDATE plugins SET source = NULL, installed_at = NULL, updated_at = NULL WHERE id = ?', id);
    await reload([id]);
  });
}
