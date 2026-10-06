// In-app documentation: the hub's own guides (docs/guides and docs/plugins.md) and guides that
// plugins ship in their docs/ folder. Guides are Markdown with optional front matter:
//
//   ---
//   title: Connecting Google Keep
//   services: [google-keep]      # services the guide is for (default: the plugin's own)
//   dependents: true             # also for services of plugins that depend on this one
//   excludeServices: [google-keep]
//   order: 1
//   ---
//
// {{publicUrl}}, {{mcpUrl}} and {{callbackUrl}} are replaced with this hub's addresses;
// write \{{publicUrl}} to show the placeholder itself.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { callbackUrl, config } from './config.ts';
import { notFound } from './http.ts';
import { openapiDocument } from './hub-openapi.ts';
import { plugins } from './plugins/manager.ts';

export interface DocInfo {
  id: string;
  title: string;
  section: string;
  order: number;
  /** "hub" or the plugin id. */
  source: string;
  sourceName: string;
  services: string[];
  adminOnly: boolean;
}

interface Doc extends DocInfo {
  file?: string;
  generate?: () => string;
}

const GUIDES = path.join(config.root, 'docs');

function parse(text: string): { meta: Record<string, any>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  let meta: Record<string, any> = {};
  try {
    meta = YAML.parse(m[1]) ?? {};
  } catch {}
  return { meta, body: text.slice(m[0].length) };
}

const titleOf = (body: string, fallback: string) => body.match(/^#\s+(.+)$/m)?.[1].trim() ?? fallback;

/** Fills in the hub's addresses; `\{{name}}` stays literal. */
function fill(md: string) {
  const ESC = '\u0000';
  return md
    .replaceAll('\\{{', ESC)
    .replaceAll('{{publicUrl}}', config.publicUrl)
    .replaceAll('{{mcpUrl}}', `${config.publicUrl}/mcp`)
    .replaceAll('{{callbackUrl}}', callbackUrl)
    .replaceAll(ESC, '{{');
}

function readDoc(file: string, base: Omit<Doc, 'title' | 'order' | 'services' | 'adminOnly'> & { defaultServices: string[] }): Doc & { dependents: boolean; exclude: string[] } {
  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  return {
    ...base,
    file,
    title: String(meta.title ?? titleOf(body, path.basename(file, '.md'))),
    order: Number(meta.order ?? 100),
    services: Array.isArray(meta.services) ? meta.services.map(String) : base.defaultServices,
    adminOnly: !!meta.adminOnly,
    dependents: !!meta.dependents,
    exclude: Array.isArray(meta.excludeServices) ? meta.excludeServices.map(String) : [],
  };
}

function collect(): Doc[] {
  const docs: (Doc & { dependents?: boolean })[] = [];
  const hub = { source: 'hub', sourceName: 'Hub', defaultServices: [] };
  for (const f of fs.existsSync(path.join(GUIDES, 'guides')) ? fs.readdirSync(path.join(GUIDES, 'guides')).sort() : []) {
    if (f.endsWith('.md')) docs.push(readDoc(path.join(GUIDES, 'guides', f), { ...hub, id: `hub/${f.slice(0, -3)}`, section: 'Using Hub' }));
  }
  docs.push({ id: 'hub/api-reference', title: 'API reference', section: 'Using Hub', order: 31, source: 'hub', sourceName: 'Hub', services: [], adminOnly: false, generate: apiReference });
  if (fs.existsSync(path.join(GUIDES, 'plugins.md'))) {
    docs.push(readDoc(path.join(GUIDES, 'plugins.md'), { ...hub, id: 'hub/plugins', section: 'Administration' }));
  }

  const pluginDocs: (Doc & { dependents: boolean; exclude: string[] })[] = [];
  for (const p of plugins.plugins.values()) {
    if (p.status !== 'active') continue;
    const dir = path.join(p.dir, 'docs');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      pluginDocs.push(
        readDoc(path.join(dir, f), {
          id: `${p.id}/${f.slice(0, -3)}`,
          section: 'Services',
          source: p.id,
          sourceName: p.manifest.name,
          defaultServices: p.services.map((s) => s.id),
        }),
      );
    }
  }
  // A guide marked `dependents` (e.g. Google sign-in setup) also applies to services built on its plugin.
  for (const d of pluginDocs) {
    if (!d.dependents) continue;
    for (const p of plugins.plugins.values()) {
      if (p.status === 'active' && p.manifest.dependencies?.includes(d.source)) d.services = [...new Set([...d.services, ...p.services.map((s) => s.id)])];
    }
  }
  for (const d of pluginDocs) d.services = d.services.filter((s) => !d.exclude.includes(s));
  return [...docs, ...pluginDocs];
}

const info = ({ id, title, section, order, source, sourceName, services, adminOnly }: Doc): DocInfo => ({ id, title, section, order, source, sourceName, services, adminOnly });

export function listDocs(admin: boolean): DocInfo[] {
  const order = ['Using Hub', 'Services', 'Administration'];
  return collect()
    .filter((d) => admin || !d.adminOnly)
    .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.order - b.order || a.title.localeCompare(b.title))
    .map(info);
}

export function getDoc(id: string, admin: boolean) {
  const d = collect().find((x) => x.id === id && (admin || !x.adminOnly));
  if (!d) throw notFound('Guide not found');
  const markdown = d.generate ? d.generate() : parse(fs.readFileSync(d.file!, 'utf8')).body;
  return { ...info(d), markdown: fill(markdown) };
}

/** Guides for each service, for links in the connect dialog. */
export function guidesByService(): Map<string, { id: string; title: string }[]> {
  const m = new Map<string, { id: string; title: string }[]>();
  for (const d of collect()) for (const s of d.services) m.set(s, [...(m.get(s) ?? []), { id: d.id, title: d.title }]);
  return m;
}

/** The API reference, generated from the hub's OpenAPI description so it cannot drift. */
function apiReference(): string {
  const doc: any = openapiDocument();
  const byTag = new Map<string, string[]>();
  for (const [p, item] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      const tag = op.tags?.[0] ?? 'Other';
      const lines = [`### \`${method.toUpperCase()} ${p}\``, '', op.summary ?? ''];
      if (op.description) lines.push('', op.description);
      if (op.parameters?.length) {
        lines.push('', '| Parameter | In | Description |', '|---|---|---|');
        for (const prm of op.parameters) lines.push(`| \`${prm.name}\`${prm.required ? '' : ' (optional)'} | ${prm.in} | ${prm.description ?? ''} |`);
      }
      const body = op.requestBody?.content?.['application/json'];
      if (body) {
        const props = body.schema?.properties;
        if (props) {
          lines.push('', '| Field | Description |', '|---|---|');
          for (const [k, v] of Object.entries<any>(props)) {
            const desc = [v.description, v.enum ? `One of ${v.enum.map((e: string) => `\`${e}\``).join(', ')}` : '', v.default !== undefined ? `Default \`${v.default}\`` : ''].filter(Boolean).join('. ');
            lines.push(`| \`${k}\`${body.schema.required?.includes(k) ? '' : ' (optional)'} | ${desc} |`);
          }
        }
        if (body.example !== undefined) lines.push('', '```json', JSON.stringify(body.example, null, 2), '```');
      }
      byTag.set(tag, [...(byTag.get(tag) ?? []), lines.join('\n')]);
    }
  }
  const parts = [
    '# API reference',
    '',
    `All endpoints are under \`${config.publicUrl}\` and take a hub token: \`Authorization: Bearer hub_…\`. Errors are JSON: \`{"error": "…"}\` with a 4xx or 5xx status. See [Hub API](/docs/hub/api) for an introduction. The machine-readable description is at [\`/api/openapi.json\`](${config.publicUrl}/api/openapi.json).`,
  ];
  for (const [tag, ops] of byTag) parts.push('', `## ${tag}`, '', ops.join('\n\n'));
  return parts.join('\n');
}
