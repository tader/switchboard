import { one, run } from '../db.ts';
import { HttpError, badRequest } from '../http.ts';
import { parseRepo, repositoryFile, type GithubContext } from './github-access.ts';

export const CATALOG_URL = 'https://api.github.com/repos/tader/switchboard-plugins/contents/plugins.json?ref=main';
export interface CommunityPlugin {
  id: string;
  name: string;
  description: string;
  icon?: string;
  catalogSource?: string;
  repo: string;
  path?: string;
  ref?: string;
}
export interface CatalogSource { name: string; repo: string; path: string; ref: string }
export interface PluginCatalog { schemaVersion: 1; plugins: CommunityPlugin[]; sources?: CatalogSource[]; warnings?: string[] }
export const MAIN_CATALOG: CatalogSource = { name: 'Main community list', repo: 'tader/switchboard-plugins', path: 'plugins.json', ref: 'main' };
const sourceKey = (s: CatalogSource) => JSON.stringify([s.repo.toLowerCase(), s.path, s.ref]);
export function catalogSources(): CatalogSource[] {
  return [MAIN_CATALOG, ...JSON.parse(one<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'plugin-catalogs'")?.value ?? '[]')];
}
export function saveCatalogSources(input: unknown): CatalogSource[] {
  if (!Array.isArray(input) || input.length > 20) throw badRequest('Provide at most 20 additional curated lists');
  const seen = new Set([sourceKey(MAIN_CATALOG)]);
  const sources = input.map((s) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 100 || typeof s.repo !== 'string' || typeof s.path !== 'string' || !s.path || typeof s.ref !== 'string' || !s.ref || s.path.length > 500 || s.ref.length > 200) throw badRequest('Each curated list needs a name, GitHub repository, file path and ref');
    const parsed = parseRepo(s.repo, s.ref, s.path);
    if (parsed.repo !== s.repo || parsed.path !== s.path || parsed.ref !== s.ref) throw badRequest('Invalid curated list source');
    const source = { name: s.name.trim(), repo: s.repo, path: s.path, ref: s.ref };
    if (seen.has(sourceKey(source))) throw badRequest('This curated list is already configured');
    seen.add(sourceKey(source)); return source;
  });
  run("INSERT INTO instance_settings (key, value) VALUES ('plugin-catalogs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(sources));
  return catalogSources();
}

export function validateCatalog(input: unknown): PluginCatalog {
  const data = input as PluginCatalog;
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.plugins)) throw new Error('Unsupported plugin catalog format');
  const ids = new Set<string>();
  for (const p of data.plugins) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) || ids.has(p.id)) throw new Error('Catalog plugin ids must be valid and unique');
    if (typeof p.name !== 'string' || !p.name.trim() || typeof p.description !== 'string') throw new Error(`Invalid listing for ${p.id}`);
    if (p.icon !== undefined) {
      const icon = new URL(p.icon);
      if (icon.protocol !== 'https:' || icon.hostname !== 'raw.githubusercontent.com' || icon.username || icon.password || icon.port) throw new Error(`Invalid icon for ${p.id}`);
    }
    const parsed = parseRepo(p.repo, p.ref, p.path);
    if (parsed.repo !== p.repo || parsed.ref !== p.ref || parsed.path !== p.path) throw new Error(`Invalid source for ${p.id}`);
    ids.add(p.id);
  }
  // Return only the documented fields; catalog metadata is never executable markup.
  return { schemaVersion: 1, plugins: data.plugins.map(({ id, name, description, icon, repo, path, ref }) => ({ id, name, description, icon, repo, path, ref })) };
}

export async function communityCatalog(ctx: GithubContext = {}): Promise<PluginCatalog> {
  const sources = catalogSources();
  const results = await Promise.allSettled(sources.map((source) => fetchCatalog(source, ctx)));
  const plugins = new Map<string, CommunityPlugin>();
  const warnings: string[] = [];
  let loaded = 0;
  results.forEach((result, i) => {
    if (result.status === 'rejected') { warnings.push(`${sources[i].name}: ${result.reason.message}`); return; }
    loaded++;
    for (const plugin of result.value.plugins) {
      if (plugins.has(plugin.id)) { warnings.push(`${sources[i].name}: duplicate plugin ${plugin.id}; the earlier list takes precedence.`); continue; }
      plugins.set(plugin.id, { ...plugin, catalogSource: sourceKey(sources[i]) });
    }
  });
  if (!loaded) throw new HttpError(502, warnings.join(' '));
  return { schemaVersion: 1, plugins: [...plugins.values()], sources, warnings };
}

async function fetchCatalog(source: CatalogSource, ctx: GithubContext): Promise<PluginCatalog> {
  try {
    // The Contents API reads main directly; raw.githubusercontent.com's CDN can
    // retain an older branch response even with cache-busting query parameters.
    const res = await repositoryFile(source, ctx);
    if (!res.body) throw new Error('Empty response');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new Error('Catalog exceeds 1 MB');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return validateCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(502, `The community plugin catalog is unavailable. ${error.message}`);
    throw new HttpError(502, 'The community plugin catalog is unavailable or invalid. Try again later.');
  }
}
