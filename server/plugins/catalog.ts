import { HttpError } from '../http.ts';
import { parseRepo } from './github-access.ts';

export const CATALOG_URL = 'https://api.github.com/repos/tader/switchboard-plugins/contents/plugins.json?ref=main';
export interface CommunityPlugin {
  id: string;
  name: string;
  description: string;
  icon?: string;
  repo: string;
  path?: string;
  ref?: string;
}
export interface PluginCatalog { schemaVersion: 1; plugins: CommunityPlugin[] }

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

export async function communityCatalog(): Promise<PluginCatalog> {
  try {
    // The Contents API reads main directly; raw.githubusercontent.com's CDN can
    // retain an older branch response even with cache-busting query parameters.
    const res = await fetch(CATALOG_URL, { headers: { accept: 'application/vnd.github.raw+json', 'user-agent': 'Switchboard', 'cache-control': 'no-cache' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
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
  } catch { throw new HttpError(502, 'The community plugin catalog is unavailable or invalid. Try again later.'); }
}
