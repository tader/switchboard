import fs from 'node:fs';
import { mcpOAuth } from '../mcp-auth.ts';
import { connectionChanged } from '../connection-events.ts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { callbackUrl, config } from '../config.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { all, now, one, run } from '../db.ts';
import { badRequest, notFound } from '../http.ts';
import type { Field, Logger, PluginContext, PluginInstance, PluginManifest, ServiceDefinition } from './api.ts';

export type PluginStatus = 'active' | 'error' | 'disabled' | 'blocked';

export interface GithubSource {
  type: 'github';
  repo: string;
  ref?: string;
  path: string;
  commit: string;
}

export interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  dir: string;
  origin: 'builtin' | 'installed';
  /** An installed plugin that replaces a built-in one with the same id. */
  overridesBuiltin: boolean;
  source?: GithubSource;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  manifestError?: string;
  instance?: PluginInstance;
  services: ServiceDefinition[];
  loadedAt?: number;
  logs: { at: number; level: string; message: string }[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const installedDir = () => path.join(config.dataDir, 'plugins');
const runtimeDir = () => path.join(config.dataDir, 'runtime');

class PluginManager {
  plugins = new Map<string, PluginRecord>();
  /** serviceId -> { service, pluginId } of active plugins. */
  services = new Map<string, { service: ServiceDefinition; pluginId: string }>();
  private loadCounter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private watchers: fs.FSWatcher[] = [];
  private pendingWatch = new Map<string, NodeJS.Timeout>();
  private quietUntil = new Map<string, number>();
  private stopped = false;

  async start() {
    fs.mkdirSync(installedDir(), { recursive: true });
    fs.rmSync(runtimeDir(), { recursive: true, force: true });
    fs.mkdirSync(runtimeDir(), { recursive: true });
    await this.serial(async () => {
      this.discover();
      await this.loadMany([...this.plugins.keys()]);
    });
    if (config.watchPlugins) this.watch();
  }

  /** Runs plugin operations one at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // --- discovery ---

  private readManifest(dir: string): PluginManifest {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
    validateManifest(manifest);
    return manifest;
  }

  private scan(root: string, origin: 'builtin' | 'installed') {
    const found = new Map<string, { dir: string; manifest?: PluginManifest; error?: string }>();
    if (!fs.existsSync(root)) return found;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
      try {
        const manifest = this.readManifest(dir);
        found.set(manifest.id, { dir, manifest });
      } catch (e: any) {
        found.set(entry.name, { dir, error: `${origin} plugin.json: ${e.message}` });
      }
    }
    return found;
  }

  /**
   * Syncs the plugin table with disk. Records of plugins in `refresh` (or all, when omitted)
   * are rebuilt from their manifest; others keep their runtime state. Returns new ids.
   */
  private discover(refresh?: Set<string>): string[] {
    const builtin = this.scan(config.builtinPluginsDir, 'builtin');
    const installed = this.scan(installedDir(), 'installed');
    const rows = new Map(all('SELECT * FROM plugins').map((r) => [r.id, r]));
    const ids = new Set([...builtin.keys(), ...installed.keys()]);
    const added: string[] = [];

    for (const id of [...this.plugins.keys()]) {
      if (!ids.has(id) && !this.plugins.get(id)!.instance) this.plugins.delete(id);
    }
    for (const id of ids) {
      const prev = this.plugins.get(id);
      if (prev && refresh && !refresh.has(id)) continue;
      if (!prev) added.push(id);
      const inst = installed.get(id);
      const found = inst ?? builtin.get(id)!;
      const row = rows.get(id);
      this.plugins.set(id, {
        id,
        manifest: found.manifest ?? { id, name: id, version: '?' },
        manifestError: found.error,
        dir: found.dir,
        origin: inst ? 'installed' : 'builtin',
        overridesBuiltin: !!inst && builtin.has(id),
        source: inst && row?.source ? JSON.parse(row.source) : undefined,
        enabled: row ? !!row.enabled : true,
        status: prev?.status ?? 'disabled',
        error: prev?.error,
        instance: prev?.instance,
        services: prev?.services ?? [],
        loadedAt: prev?.loadedAt,
        logs: prev?.logs ?? [],
      });
    }
    return added;
  }

  // --- dependency graph ---

  private dependents(id: string): Set<string> {
    const out = new Set<string>();
    const visit = (target: string) => {
      for (const p of this.plugins.values()) {
        if (!out.has(p.id) && p.manifest.dependencies?.includes(target)) {
          out.add(p.id);
          visit(p.id);
        }
      }
    };
    visit(id);
    return out;
  }

  /** Dependencies before dependents. Cycles end up last and fail to load. */
  private order(ids: Iterable<string>): string[] {
    const wanted = new Set(ids);
    const out: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string) => {
      if (state.get(id) === 'done' || state.get(id) === 'visiting') return;
      state.set(id, 'visiting');
      for (const dep of this.plugins.get(id)?.manifest.dependencies ?? []) if (wanted.has(dep)) visit(dep);
      state.set(id, 'done');
      out.push(id);
    };
    for (const id of [...wanted].sort()) visit(id);
    return out;
  }

  // --- loading ---

  private async loadMany(ids: string[]) {
    for (const id of this.order(ids)) await this.load(id);
  }

  private async unloadMany(ids: Iterable<string>) {
    for (const id of this.order(ids).reverse()) await this.unload(id);
  }

  private async unload(id: string) {
    const p = this.plugins.get(id);
    if (!p?.instance) return;
    if (p.services.some(s => s.kind === 'mcp')) connectionChanged();
    for (const s of p.services) {
      if (this.services.get(s.id)?.pluginId === id) this.services.delete(s.id);
    }
    try {
      await p.instance.dispose?.();
    } catch (e: any) {
      this.log(p, 'error', `dispose failed: ${e.message}`);
    }
    p.instance = undefined;
    p.services = [];
    p.status = 'disabled';
  }

  private async load(id: string) {
    const p = this.plugins.get(id);
    if (!p) return;
    p.error = undefined;
    if (p.manifestError) {
      p.status = 'error';
      p.error = p.manifestError;
      return;
    }
    if (!p.enabled) {
      p.status = 'disabled';
      return;
    }
    for (const dep of p.manifest.dependencies ?? []) {
      const d = this.plugins.get(dep);
      if (!d) return this.block(p, `Requires plugin "${dep}", which is not installed`);
      if (d.status !== 'active') return this.block(p, `Requires plugin "${dep}", which is not active`);
    }

    try {
      const entry = this.entryFile(p);
      // ESM modules cannot be unloaded, so every load imports a fresh copy of the plugin
      // directory. Relative imports inside the plugin then resolve to fresh modules too.
      const copy = path.join(runtimeDir(), `${id}-${++this.loadCounter}`);
      fs.cpSync(p.dir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('.git') });
      const mod = await import(pathToFileURL(path.join(copy, path.relative(p.dir, entry))).href);
      const setup = typeof mod.default === 'function' ? mod.default : mod.default?.setup ?? mod.setup;
      if (typeof setup !== 'function') throw new Error('The entry module must export a setup function as default');

      const ctx = this.context(p);
      const instance: PluginInstance = (await withTimeout(Promise.resolve(setup(ctx)), 15_000, 'setup timed out')) ?? {};
      const services = instance.services ?? [];
      for (const s of services) {
        validateService(s);
        const taken = this.services.get(s.id);
        if (taken && taken.pluginId !== id) throw new Error(`Service id "${s.id}" is already provided by plugin "${taken.pluginId}"`);
      }
      for (const s of services) {
        s.icon = resolveIcon(s.icon, p.dir);
        this.services.set(s.id, { service: s, pluginId: id });
      }
      p.instance = instance;
      p.services = services;
      p.status = 'active';
      p.loadedAt = now();
      this.log(p, 'info', `loaded ${p.manifest.version}${services.length ? ` (${services.map((s) => s.id).join(', ')})` : ''}`);
    } catch (e: any) {
      p.status = 'error';
      p.error = e?.message ?? String(e);
      this.log(p, 'error', p.error!);
    }
  }

  private block(p: PluginRecord, reason: string) {
    p.status = 'blocked';
    p.error = reason;
  }

  private entryFile(p: PluginRecord) {
    const candidates = p.manifest.main ? [p.manifest.main] : ['index.ts', 'index.js', 'index.mjs'];
    for (const c of candidates) {
      const f = path.resolve(p.dir, c);
      if (!f.startsWith(p.dir + path.sep)) throw new Error('main must be inside the plugin directory');
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`Entry module not found (${candidates.join(', ')})`);
  }

  private context(p: PluginRecord): PluginContext {
    const dataDir = path.join(config.dataDir, 'plugin-data', p.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const log: Logger = {
      info: (...a) => this.log(p, 'info', fmt(a)),
      warn: (...a) => this.log(p, 'warn', fmt(a)),
      error: (...a) => this.log(p, 'error', fmt(a)),
    };
    return {
      manifest: p.manifest,
      settings: this.settingsWithDefaults(p),
      require: (dep: string) => {
        if (!p.manifest.dependencies?.includes(dep)) throw new Error(`"${dep}" is not listed in dependencies`);
        return this.plugins.get(dep)?.instance?.exports as any;
      },
      log,
      publicUrl: config.publicUrl,
      callbackUrl,
      dir: p.dir,
      dataDir,
      satellite: !!(config.satelliteCentralUrl && config.satelliteToken),
      mcp: { oauth: mcpOAuth },
    };
  }

  log(p: PluginRecord, level: string, message: string) {
    p.logs.push({ at: now(), level, message });
    if (p.logs.length > 200) p.logs.splice(0, p.logs.length - 200);
    const line = `[plugin:${p.id}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  // --- public operations ---

  /** Reloads plugins and everything that depends on them. */
  reload(ids: string[]) {
    return this.serial(() => this.reloadNow(ids));
  }

  /** Serializes disk changes with reloads. The callback's reload does not enqueue again. */
  mutate<T>(fn: (reload: (ids: string[]) => Promise<void>) => Promise<T>): Promise<T> {
    return this.serial(() => fn((ids) => this.reloadNow(ids)));
  }

  private async reloadNow(ids: string[]) {
    const affected = new Set(ids);
    for (const id of ids) for (const d of this.dependents(id)) affected.add(d);
    await this.unloadMany(affected);
    for (const id of this.discover(affected)) affected.add(id);
    // Plugins that were waiting for a dependency get another chance.
    for (const p of this.plugins.values()) if (p.status === 'blocked') affected.add(p.id);
    for (const id of [...affected]) if (!this.plugins.has(id)) affected.delete(id);
    await this.loadMany([...affected]);
  }

  async setEnabled(id: string, enabled: boolean) {
    const p = this.get(id);
    upsertRow(id);
    run('UPDATE plugins SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
    p.enabled = enabled;
    await this.reload([id]);
  }

  get(id: string): PluginRecord {
    const p = this.plugins.get(id);
    if (!p) throw notFound(`Plugin "${id}" not found`);
    return p;
  }

  service(id: string) {
    return this.services.get(id)?.service;
  }

  /** Settings for the admin UI: secrets are never returned, only whether they are set. */
  settingsForAdmin(id: string) {
    const p = this.get(id);
    const stored = this.storedSettings(id);
    const values: Record<string, any> = {};
    const secretsSet: string[] = [];
    for (const f of p.manifest.settings ?? []) {
      if (f.type === 'secret') {
        if (stored[f.key]) secretsSet.push(f.key);
      } else if (stored[f.key] !== undefined) values[f.key] = stored[f.key];
    }
    return { fields: p.manifest.settings ?? [], values, secretsSet };
  }

  /** Secret fields that are missing from `values` keep their stored value. */
  async saveSettings(id: string, values: Record<string, any>) {
    const p = this.get(id);
    const stored = this.storedSettings(id);
    const next: Record<string, any> = {};
    for (const f of p.manifest.settings ?? []) {
      const v = values[f.key];
      if (f.type === 'secret' && (v === undefined || v === null)) {
        if (stored[f.key] !== undefined) next[f.key] = stored[f.key];
      } else if (v !== undefined && v !== '') {
        next[f.key] = f.type === 'boolean' ? !!v : String(v);
      }
    }
    upsertRow(id);
    run('UPDATE plugins SET settings_enc = ? WHERE id = ?', encrypt(next), id);
    await this.reload([id]);
  }

  private storedSettings(id: string): Record<string, any> {
    const row = one('SELECT settings_enc FROM plugins WHERE id = ?', id);
    return (row?.settings_enc && decrypt(row.settings_enc)) || {};
  }

  private settingsWithDefaults(p: PluginRecord) {
    const stored = this.storedSettings(p.id);
    const out: Record<string, any> = {};
    for (const f of p.manifest.settings ?? []) {
      if (stored[f.key] !== undefined) out[f.key] = stored[f.key];
      else if (f.default !== undefined) out[f.key] = f.default;
    }
    return out;
  }

  /** Suppresses the file watcher for a plugin while Switchboard itself writes its files. */
  quiet(id: string, ms = 3000) {
    this.quietUntil.set(id, Date.now() + ms);
  }

  // --- watching ---

  private watch() {
    for (const root of [config.builtinPluginsDir, installedDir()]) this.watchRoot(root);
  }

  private watchRoot(root: string) {
    if (this.stopped || !fs.existsSync(root)) return;
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const top = filename.toString().split(path.sep)[0];
        if (!top || top.startsWith('.')) return;
        this.onFileChange(root, top);
      });
      // Node's recursive watcher errors when a directory disappears while it scans it (e.g. a
      // plugin folder being removed). Unhandled, that would crash Switchboard; start over instead.
      w.on('error', (e) => {
        console.warn(`[plugins] watcher for ${root} failed (${(e as NodeJS.ErrnoException).code ?? e.message}), restarting it`);
        w.close();
        this.watchers = this.watchers.filter((x) => x !== w);
        setTimeout(() => {
          this.watchRoot(root);
          // Changes during the gap are not seen; rescan what is on disk.
          this.reloadChanged().catch((err) => console.error(err));
        }, 500);
      });
      this.watchers.push(w);
    } catch (e: any) {
      console.warn(`Not watching ${root}: ${e.message}`);
    }
  }

  /** Reloads plugins that appeared or disappeared on disk. */
  private reloadChanged() {
    const onDisk = new Set<string>();
    for (const root of [config.builtinPluginsDir, installedDir()]) {
      if (!fs.existsSync(root)) continue;
      for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) onDisk.add(path.join(root, e.name));
    }
    const gone = [...this.plugins.values()].filter((p) => !onDisk.has(p.dir)).map((p) => p.id);
    const known = new Set([...this.plugins.values()].map((p) => p.dir));
    const added = [...onDisk].filter((d) => !known.has(d) && fs.existsSync(path.join(d, 'plugin.json')));
    if (!gone.length && !added.length) return Promise.resolve();
    return this.reload(gone);
  }

  private onFileChange(root: string, dirName: string) {
    const key = `${root}/${dirName}`;
    clearTimeout(this.pendingWatch.get(key));
    this.pendingWatch.set(
      key,
      setTimeout(() => {
        this.pendingWatch.delete(key);
        const dir = path.join(root, dirName);
        let id = dirName;
        try {
          id = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).id ?? dirName;
        } catch {}
        const known = [...this.plugins.values()].find((p) => p.dir === dir);
        if (known) id = known.id;
        if ((this.quietUntil.get(id) ?? 0) > Date.now()) return;
        console.log(`[plugins] ${dirName} changed on disk, reloading ${id}`);
        this.reload([id]).catch((e) => console.error(e));
      }, 400),
    );
  }

  async stop() {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    await this.serial(() => this.unloadMany([...this.plugins.keys()]));
  }
}

export function upsertRow(id: string) {
  run('INSERT INTO plugins (id, enabled) VALUES (?, 1) ON CONFLICT (id) DO NOTHING', id);
}

export function validateManifest(m: PluginManifest) {
  if (!m || typeof m !== 'object') throw new Error('not an object');
  if (!ID.test(m.id ?? '')) throw new Error('"id" must be lowercase letters, digits and dashes');
  if (!m.name) throw new Error('"name" is required');
  if (!m.version) throw new Error('"version" is required');
  if (m.dependencies && !Array.isArray(m.dependencies)) throw new Error('"dependencies" must be an array');
  if (m.settings) validateFields(m.settings, 'settings');
}

function validateFields(fields: Field[], where: string) {
  if (!Array.isArray(fields)) throw new Error(`${where} must be an array`);
  for (const f of fields) if (!f.key || !f.label) throw new Error(`${where}: every field needs "key" and "label"`);
}

function validateService(s: ServiceDefinition) {
  if (!s?.id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s.id)) throw new Error(`Invalid service id "${s?.id}"`);
  if (s.kind !== undefined && s.kind !== 'http' && s.kind !== 'mcp') throw new Error(`Invalid connection kind for service ${s.id}`);
  if (!s.name) throw new Error(`Service "${s.id}" needs a name`);
  if (!Array.isArray(s.authMethods) || !s.authMethods.length) throw new Error(`Service "${s.id}" needs at least one auth method`);
  const ids = new Set<string>();
  for (const m of s.authMethods) {
    if (!m.id || ids.has(m.id)) throw new Error(`Service "${s.id}": auth method ids must be unique`);
    ids.add(m.id);
    if (typeof m.connect !== 'function' || typeof m.authorize !== 'function') {
      throw new Error(`Service "${s.id}", method "${m.id}": connect() and authorize() are required`);
    }
    if (m.fields) validateFields(m.fields, `${s.id}.${m.id}.fields`);
  }
}

function resolveIcon(icon: string | undefined, dir: string): string | undefined {
  if (!icon || icon.startsWith('<') || icon.startsWith('data:') || /^https?:\/\//.test(icon)) return icon;
  const file = path.resolve(dir, icon);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return undefined;
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ');

export const plugins = new PluginManager();

export function pluginIcon(p: PluginRecord): string | undefined {
  if (p.manifest.icon) return resolveIcon(p.manifest.icon, p.dir);
  return p.services.find((s) => s.icon)?.icon;
}

export function assertPluginId(id: string) {
  if (!ID.test(id)) throw badRequest('Invalid plugin id');
}
