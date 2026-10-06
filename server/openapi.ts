import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { config } from './config.ts';
import { sha256 } from './crypto.ts';
import { badRequest } from './http.ts';
import type { Connection, ServiceDefinition } from './plugins/api.ts';
import { resolveBaseUrl } from './connections.ts';
import { allowedHosts, hostAllowed } from './proxy.ts';

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  type?: string;
  enum?: string[];
  example?: string;
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tag: string;
  deprecated?: boolean;
  params: Param[];
  body?: { contentType: string; example?: string; required: boolean };
}

export interface ApiDescription {
  title?: string;
  version?: string;
  server: string;
  operations: Operation[];
}

const TTL = 24 * 3600_000;
const memory = new Map<string, { at: number; doc: any }>();
/** Parsed once per document; `server` is resolved per connection. */
const processed = new WeakMap<object, ApiDescription & { templated: boolean }>();

async function loadDoc(src: string | object, refresh: boolean): Promise<any> {
  if (typeof src !== 'string') return src;
  const hit = memory.get(src);
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.doc;
  const dir = path.join(config.dataDir, 'cache', 'openapi');
  const file = path.join(dir, `${sha256(src)}.json`);
  if (!refresh && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < TTL) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    memory.set(src, { at: Date.now(), doc });
    return doc;
  }
  const res = await fetch(src, { headers: { accept: 'application/json, application/yaml;q=0.9, */*;q=0.5', 'user-agent': 'switchboard' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw badRequest(`Could not fetch the API description (${res.status})`);
  const text = await res.text();
  let doc: any;
  try {
    doc = text.trimStart().startsWith('{') ? JSON.parse(text) : YAML.parse(text, { maxAliasCount: -1 });
  } catch (e: any) {
    throw badRequest(`Could not parse the API description: ${e.message}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
  memory.set(src, { at: Date.now(), doc });
  return doc;
}

export async function describe(service: ServiceDefinition, conn: Connection, refresh = false): Promise<ApiDescription | null> {
  const src = typeof service.openapi === 'function' ? await service.openapi(conn) : service.openapi;
  if (!src) return null;
  const doc = await loadDoc(src, refresh);
  if (refresh) processed.delete(doc);
  let d = processed.get(doc);
  if (!d) {
    d = process(doc);
    processed.set(doc, d);
  }
  const { templated, ...desc } = d;
  return { ...desc, server: serverFor(d.server, templated, service, conn) };
}

/** Specs often name a placeholder server (your-domain.atlassian.net, {host}:{port}); then use the connection's base URL. */
function serverFor(server: string, templated: boolean, service: ServiceDefinition, conn: Connection): string {
  const base = resolveBaseUrl(service, conn)?.replace(/\/+$/, '');
  if (!base) return server;
  let url: URL | undefined;
  try {
    url = new URL(server);
  } catch {}
  if (url && !templated && hostAllowed(url.host, allowedHosts(service, conn))) return server;
  const path = (url ? url.pathname : server.startsWith('/') ? server : '').replace(/\/+$/, '');
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  // Avoid doubling a path the base URL already has (e.g. https://petstore3.swagger.io/api/v3 + /api/v3).
  return basePath && basePath.endsWith(path) ? base : base + path;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function process(doc: any): ApiDescription & { templated: boolean } {
  if (!doc || typeof doc !== 'object' || !doc.paths) throw badRequest('Not an OpenAPI document');
  const swagger2 = typeof doc.swagger === 'string';
  const resolve = makeResolver(doc);

  let server = '';
  let templated = false;
  if (swagger2) {
    server = doc.host ? `${doc.schemes?.includes('https') || !doc.schemes ? 'https' : doc.schemes[0]}://${doc.host}${doc.basePath ?? ''}` : doc.basePath ?? '';
  } else if (doc.servers?.[0]?.url) {
    let u: string = doc.servers[0].url;
    templated = /\{[^}]+\}/.test(u);
    for (const [k, v] of Object.entries<any>(doc.servers[0].variables ?? {})) u = u.split(`{${k}}`).join(String(v.default ?? ''));
    server = u;
  }
  server = server.replace(/\/+$/, '');

  const operations: Operation[] = [];
  for (const [p, rawItem] of Object.entries<any>(doc.paths)) {
    const item = resolve(rawItem) ?? {};
    const shared = (item.parameters ?? []).map(resolve);
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = new Map<string, Param>();
      let body: Operation['body'];
      for (const raw of [...shared, ...(op.parameters ?? []).map(resolve)]) {
        if (!raw?.name) continue;
        if (raw.in === 'body') {
          body = { contentType: 'application/json', required: !!raw.required, example: exampleJson(raw.schema, resolve) };
          continue;
        }
        if (raw.in === 'formData') {
          body = { contentType: op.consumes?.[0] ?? 'application/x-www-form-urlencoded', required: false };
          continue;
        }
        if (!['path', 'query', 'header'].includes(raw.in)) continue;
        const schema = resolve(raw.schema) ?? raw;
        params.set(`${raw.in}:${raw.name}`, {
          name: raw.name,
          in: raw.in,
          required: raw.in === 'path' || !!raw.required,
          description: trim(raw.description),
          type: schema?.type,
          enum: Array.isArray(schema?.enum) ? schema.enum.map(String) : undefined,
          example: raw.example !== undefined ? String(raw.example) : schema?.default !== undefined ? String(schema.default) : undefined,
        });
      }
      if (op.requestBody) {
        const rb = resolve(op.requestBody) ?? {};
        const types = Object.keys(rb.content ?? {});
        const contentType = types.find((t) => t.includes('json')) ?? types[0] ?? 'application/json';
        const media = rb.content?.[contentType] ?? {};
        let example: string | undefined;
        if (media.example !== undefined) example = JSON.stringify(media.example, null, 2);
        else if (media.examples) {
          const first = resolve(Object.values<any>(media.examples)[0]);
          if (first?.value !== undefined) example = JSON.stringify(first.value, null, 2);
        }
        if (example === undefined && contentType.includes('json')) example = exampleJson(media.schema, resolve);
        body = { contentType, required: !!rb.required, example };
      }
      operations.push({
        id: op.operationId ?? `${m} ${p}`,
        method: m.toUpperCase(),
        path: p,
        summary: trim(op.summary, 200),
        description: trim(op.description),
        tag: op.tags?.[0] ?? (p.split('/').filter(Boolean)[0] || 'default'),
        deprecated: op.deprecated || undefined,
        params: [...params.values()],
        body,
      });
    }
  }
  return { title: doc.info?.title, version: doc.info?.version, server, templated, operations };
}

function trim(s: unknown, max = 2000): string | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function makeResolver(doc: any) {
  return function resolve(node: any, depth = 0): any {
    while (node && typeof node === 'object' && typeof node.$ref === 'string' && depth++ < 20) {
      const ref: string = node.$ref;
      if (!ref.startsWith('#/')) return undefined;
      node = ref
        .slice(2)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((o, k) => (o == null ? o : o[decodeURIComponent(k)]), doc);
    }
    return node;
  };
}

function exampleJson(schema: any, resolve: (n: any) => any): string | undefined {
  const value = sample(schema, resolve, 0, new Set());
  return value === undefined ? undefined : JSON.stringify(value, null, 2);
}

function sample(schema: any, resolve: (n: any) => any, depth: number, seen: Set<any>): any {
  const s = resolve(schema);
  if (!s || typeof s !== 'object' || depth > 6 || seen.has(s)) return undefined;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const next = new Set(seen).add(s);
  const variant = s.allOf ?? s.oneOf ?? s.anyOf;
  if (Array.isArray(variant)) {
    if (s.allOf) return Object.assign({}, ...variant.map((v: any) => sample(v, resolve, depth + 1, next) ?? {}));
    return sample(variant[0], resolve, depth + 1, next);
  }
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) {
      const r = resolve(v);
      if (r?.readOnly) continue;
      const val = sample(v, resolve, depth + 1, next);
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  if (type === 'array') {
    const item = sample(s.items, resolve, depth + 1, next);
    return item === undefined ? [] : [item];
  }
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'string') {
    if (s.format === 'date-time') return new Date(0).toISOString();
    if (s.format === 'date') return '1970-01-01';
    return '';
  }
  return undefined;
}
