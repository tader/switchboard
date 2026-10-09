import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, History, RefreshCw, Search, X } from 'lucide-react';
import { api, type Connection } from '../api';
import { JsonView } from '../components/JsonView';
import { Alert, Badge, Button, Card, CopyField, Dialog, Empty, Input, PageHeader, Select, Spinner, Switch } from '../components/ui';
import { ActivityChart, type Breakdown } from '../components/ActivityChart';
import { METHOD_COLORS, ago, bytes, cx, useResource } from '../lib';

interface Entry {
  id: number;
  at: number;
  upstream: { id: string; name: string; userId: string } | null;
  source: 'proxy' | 'call' | 'saved-call' | 'console' | 'token' | 'mcp' | 'plugin';
  connection: { id: string; name: string; serviceId: string } | null;
  client: { tokenId: string; name: string } | null;
  savedCall: string | null;
  method: string | null;
  mcpOperation: string | null;
  mcpTarget: string | null;
  mcpOutcome: string | null;
  url: string | null;
  host: string | null;
  status: number | null;
  durationMs: number | null;
  requestSize: number | null;
  responseSize: number | null;
  responseType: string | null;
  retried: boolean;
  error: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestHeaders?: { name: string; value: string; byHub: boolean }[];
  requestBody?: string | null;
}

interface Page {
  items: Entry[];
  total: number;
  limit: number;
  offset: number;
}

interface Facets {
  connections: { id: string; name: string; serviceId: string; count: number }[];
  clients: { id: string; name: string; count: number }[];
  methods: string[];
}

const PAGE = 50;
const RANGES: Record<string, { label: string; ms?: number }> = {
  '1h': { label: 'Last hour', ms: 3600_000 },
  '24h': { label: 'Last 24 hours', ms: 86400_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 86400_000 },
  '30d': { label: 'Last 30 days', ms: 30 * 86400_000 },
  all: { label: 'All time' },
};
const SOURCES: Record<Entry['source'], string> = {
  proxy: 'Proxy',
  call: 'Call API',
  'saved-call': 'Saved call',
  console: 'Console',
  token: 'Token handed out',
  plugin: 'Plugin installer',
  mcp: 'MCP',
};

type SortKey = 'time' | 'status' | 'duration' | 'size';

function statusTone(e: Entry) {
  if (e.error || (e.status ?? 0) >= 500) return 'text-rose-700 bg-rose-50 ring-rose-200 dark:text-rose-300 dark:bg-rose-500/10 dark:ring-rose-500/20';
  if ((e.status ?? 0) >= 400) return 'text-amber-700 bg-amber-50 ring-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/20';
  if ((e.status ?? 0) >= 300) return 'text-sky-700 bg-sky-50 ring-sky-200 dark:text-sky-300 dark:bg-sky-500/10 dark:ring-sky-500/20';
  return 'text-emerald-700 bg-emerald-50 ring-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:ring-emerald-500/20';
}

function customLabel(from: string, to: string) {
  const fmt = (v: string) => new Date(Number(v)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return from && to ? `${fmt(from)} – ${fmt(to)}` : 'Custom range';
}

function splitUrl(url: string | null): { host?: string; path: string } {
  if (!url) return { path: '' };
  try {
    const u = new URL(url);
    return { host: u.host, path: decodeURI(u.pathname + u.search) };
  } catch {
    return { path: url };
  }
}

export function Activity() {
  const [params, setParams] = useSearchParams();
  const f = {
    q: params.get('q') ?? '',
    connection: params.get('connection') ?? '',
    client: params.get('client') ?? '',
    status: params.get('status') ?? '',
    method: params.get('method') ?? '',
    source: params.get('source') ?? '',
    range: params.get('range') ?? '7d',
    /** With range "custom": a zoomed-in period, in ms. */
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    by: (params.get('by') ?? 'connection') as Breakdown,
    sort: (params.get('sort') ?? 'time') as SortKey,
    order: params.get('order') ?? 'desc',
    offset: Number(params.get('offset') ?? 0),
  };
  const set = (patch: Partial<Record<keyof typeof f, string | number>>, keepOffset = false) => {
    const next = { ...f, ...(keepOffset ? {} : { offset: 0 }), ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      const defaults: Record<string, unknown> = { range: '7d', sort: 'time', order: 'desc', offset: 0, by: 'connection' };
      if ((k === 'from' || k === 'to') && next.range !== 'custom') continue;
      if (v !== '' && v !== defaults[k]) p.set(k, String(v));
    }
    setParams(p, { replace: true });
  };

  // Search applies after typing stops.
  const [search, setSearch] = useState(f.q);
  useEffect(() => setSearch(f.q), [f.q]);
  useEffect(() => {
    if (search === f.q) return;
    const t = setTimeout(() => set({ q: search }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // The filters both the chart and the table use.
  const filterQuery = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ['q', 'connection', 'client', 'status', 'method', 'source'] as const) if (f[k]) p.set(k, f[k]);
    if (f.range === 'custom') {
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', f.to);
    } else {
      const r = RANGES[f.range];
      if (r?.ms) p.set('from', String(Date.now() - r.ms));
    }
    return p.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.q, f.connection, f.client, f.status, f.method, f.source, f.range, f.from, f.to]);
  const query = useMemo(() => {
    const p = new URLSearchParams(filterQuery);
    for (const k of ['sort', 'order'] as const) if (f[k]) p.set(k, f[k]);
    p.set('limit', String(PAGE));
    p.set('offset', String(f.offset));
    return p.toString();
  }, [filterQuery, f.sort, f.order, f.offset]);

  // Zooming in from the chart; each step can be undone.
  const [zoomStack, setZoomStack] = useState<{ range: string; from: string; to: string }[]>([]);
  const zoom = (from: number, to: number) => {
    setZoomStack((s) => [...s, { range: f.range, from: f.from, to: f.to }]);
    set({ range: 'custom', from: String(from), to: String(to) });
  };
  const zoomOut = () => {
    const prev = zoomStack.at(-1);
    setZoomStack((s) => s.slice(0, -1));
    set(prev ?? { range: '7d' });
  };
  const [refresh, setRefresh] = useState(0);
  const pick = (key: string) => {
    if (f.by === 'connection') set({ connection: key });
    else if (f.by === 'client') set({ client: key });
    else if (f.by === 'method') set({ method: key });
    else if (f.by === 'status') set({ status: key === 'failed' ? 'error' : key });
  };

  const page = useResource(() => api<Page>(`/audit?${query}`), [query]);
  const facets = useResource(() => api<Facets>('/audit/facets'));
  const connections = useResource(() => api<Connection[]>('/connections'));
  const [selected, setSelected] = useState<number | null>(null);

  // Live mode refreshes the newest page, to watch agents as they work.
  const [live, setLive] = useState(false);
  const liveOk = f.sort === 'time' && f.order === 'desc' && f.offset === 0 && f.range !== 'custom';
  const seen = useRef(new Set<number>());
  const [fresh, setFresh] = useState(new Set<number>());
  useEffect(() => {
    if (!live || !liveOk) return;
    const t = setInterval(() => {
      page.reload();
      facets.reload();
      setRefresh((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, liveOk, query]);
  useEffect(() => {
    if (!page.data) return;
    const added = page.data.items.filter((e) => seen.current.size && !seen.current.has(e.id)).map((e) => e.id);
    page.data.items.forEach((e) => seen.current.add(e.id));
    if (added.length) {
      setFresh(new Set(added));
      const t = setTimeout(() => setFresh(new Set()), 2000);
      return () => clearTimeout(t);
    }
  }, [page.data]);
  useEffect(() => {
    seen.current = new Set();
  }, [query]);

  // Filter options: what appears in the trail, plus current connections, by name.
  const connectionOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of facets.data?.connections ?? []) m.set(c.id, c.name);
    for (const c of connections.data ?? []) m.set(c.id, c.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [facets.data, connections.data]);

  const filtered = !!(f.q || f.connection || f.client || f.status || f.method || f.source);
  const sortBy = (key: SortKey) => set({ sort: key, order: f.sort === key && f.order === 'desc' ? 'asc' : 'desc' });
  const data = page.data;

  const SortHeader = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cx('px-3 py-2 font-medium', className)}>
      <button type="button" onClick={() => sortBy(k)} className={cx('inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100', f.sort === k && 'text-zinc-900 dark:text-zinc-100')}>
        {children}
        {f.sort === k && (f.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Activity"
        actions={
          <>
            <label className={cx('flex items-center gap-2 text-[13px]', !liveOk && 'opacity-50')} title={liveOk ? undefined : f.range === 'custom' ? 'Live shows the newest entries; zoom out first' : 'Live shows the newest entries; sort by newest first'}>
              <Switch checked={live && liveOk} onChange={setLive} disabled={!liveOk} label="Live" />
              Live
            </label>
            <Button icon={<RefreshCw className={cx('size-4', page.loading && 'animate-spin')} />} onClick={() => (page.reload(), facets.reload(), setRefresh((n) => n + 1))}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search URL, error or saved call" className="pl-9" />
        </div>
        <Select value={f.connection} onChange={(e) => set({ connection: e.target.value })} className="w-44" aria-label="Connection">
          <option value="">All connections</option>
          {connectionOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Select value={f.client} onChange={(e) => set({ client: e.target.value })} className="w-44" aria-label="Client">
          <option value="">All clients</option>
          <option value="web">Web console</option>
          {facets.data?.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={f.status} onChange={(e) => set({ status: e.target.value })} className="w-36" aria-label="Status">
          <option value="">Any status</option>
          <option value="2xx">2xx Success</option>
          <option value="3xx">3xx Redirect</option>
          <option value="4xx">4xx Client error</option>
          <option value="5xx">5xx Server error</option>
          <option value="error">All failures</option>
        </Select>
        <Select value={f.method} onChange={(e) => set({ method: e.target.value })} className="w-32" aria-label="Method">
          <option value="">Any method</option>
          {(facets.data?.methods ?? []).map((m) => (
            <option key={m} value={m}>
              {m === 'TOKEN' ? 'Token' : m}
            </option>
          ))}
        </Select>
        <Select value={f.source} onChange={(e) => set({ source: e.target.value })} className="w-40" aria-label="Source">
          <option value="">Any source</option>
          {Object.entries(SOURCES).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          value={f.range}
          onChange={(e) => {
            setZoomStack([]);
            set({ range: e.target.value });
          }}
          className={f.range === 'custom' ? 'w-80' : 'w-40'}
          aria-label="Time range"
        >
          {f.range === 'custom' && <option value="custom">{customLabel(f.from, f.to)}</option>}
          {Object.entries(RANGES).map(([v, r]) => (
            <option key={v} value={v}>
              {r.label}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            icon={<X className="size-4" />}
            onClick={() => set({ q: '', connection: '', client: '', status: '', method: '', source: '' })}
          >
            Clear
          </Button>
        )}
      </div>

      <ActivityChart
        query={filterQuery}
        by={f.by}
        onBy={(by) => set({ by }, true)}
        onZoom={zoom}
        canZoomOut={f.range === 'custom'}
        onZoomOut={zoomOut}
        onPick={pick}
        refresh={refresh}
      />

      {page.error ? (
        <Alert>{page.error.message}</Alert>
      ) : !data ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : !data.items.length ? (
        <Empty icon={<History className="size-5" />} title={filtered || f.range !== 'all' ? 'Nothing matches' : 'No activity yet'}>
          {filtered || f.range !== 'all' ? 'Try other filters or a longer time range.' : 'Requests through your connections show up here.'}
        </Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[56rem] table-fixed text-left text-[13px]">
              <colgroup>
                <col className="w-32" />
                <col className="w-36" />
                <col className="w-36" />
                <col />
                <col className="w-20" />
                <col className="w-24" />
                <col className="w-20" />
              </colgroup>
              <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <SortHeader k="time">Time</SortHeader>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Connection</th>
                  <th className="px-3 py-2 font-medium">Request</th>
                  <SortHeader k="status">Status</SortHeader>
                  <SortHeader k="duration" className="text-right">
                    Time taken
                  </SortHeader>
                  <SortHeader k="size" className="text-right">
                    Size
                  </SortHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.items.map((e) => {
                  const { host, path } = splitUrl(e.url);
                  return (
                    <tr
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={cx('cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40', fresh.has(e.id) && 'bg-indigo-50/70 dark:bg-indigo-500/10')}
                    >
                      <td className="whitespace-nowrap px-3 py-2 text-zinc-500" title={new Date(e.at).toLocaleString()}>
                        {ago(e.at)}
                      </td>
                      <td className="truncate px-3 py-2">{e.client ? e.client.name : <span className="text-zinc-500">Web console</span>}</td>
                      <td className="truncate px-3 py-2 font-mono text-[12px]">{e.connection?.name ?? '—'}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className={cx('w-11 shrink-0 font-mono text-[11px] font-bold', e.method === 'TOKEN' ? 'text-violet-600 dark:text-violet-400' : METHOD_COLORS[e.method ?? ''])}>
                            {e.method}
                          </span>
                          <span className="min-w-0 truncate font-mono text-[12px]" title={e.url ?? undefined}>
                            {e.mcpOperation ? `${e.mcpOperation}${e.mcpTarget ? ` · ${e.mcpTarget}` : ''}` : path}
                          </span>
                          {e.savedCall && <Badge className="max-w-40 shrink-0 truncate">{e.savedCall}</Badge>}
                        </div>
                        {host && <div className="truncate pl-13 text-[11px] text-zinc-400">{host}</div>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className={cx('rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset', statusTone(e))} title={e.error ?? undefined}>
                          {e.mcpOutcome === 'tool-error' ? 'Tool error' : e.status ?? '—'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-500">{e.durationMs != null ? `${e.durationMs} ms` : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-500">{e.responseSize != null ? bytes(e.responseSize) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            <span>
              {data.offset + 1}–{data.offset + data.items.length} of {data.total.toLocaleString()}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-3.5" />} disabled={data.offset === 0} onClick={() => set({ offset: Math.max(0, data.offset - PAGE) }, true)}>
                Newer
              </Button>
              <Button size="sm" variant="ghost" disabled={data.offset + PAGE >= data.total} onClick={() => set({ offset: data.offset + PAGE }, true)}>
                Older
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </Card>
      )}
      <EntryDialog id={selected} onClose={() => setSelected(null)} onFilter={(patch) => (setSelected(null), set(patch))} />
    </>
  );
}

function EntryDialog({ id, onClose, onFilter }: { id: number | null; onClose: () => void; onFilter: (p: Record<string, string>) => void }) {
  const entry = useResource(async () => (id ? api<Entry>(`/audit/${id}`) : null), [id]);
  const e = entry.data;
  const body = useMemo(() => {
    if (!e?.requestBody) return undefined;
    try {
      return { json: JSON.parse(e.requestBody) };
    } catch {
      return { text: e.requestBody };
    }
  }, [e]);
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
  const link = (label: string, patch: Record<string, string>) => (
    <button type="button" className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => onFilter(patch)}>
      {label}
    </button>
  );
  return (
    <Dialog open={id !== null} onClose={onClose} size="lg" title={e ? (e.method === 'TOKEN' ? 'Access token handed out' : `${e.method} request`) : 'Request'} description={e && new Date(e.at).toLocaleString()}>
      {!e ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5 text-[13px]">
          {e.url && e.method !== 'TOKEN' && <CopyField value={e.url} />}
          {e.error && <Alert>{e.error}</Alert>}
          {e.method === 'TOKEN' && !e.error && (
            <Alert tone="amber">The raw access token was handed out. Requests made with it go to the service directly and are not in this trail.</Alert>
          )}
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
            {e.mcpOperation && <><Row label="Operation">{e.mcpOperation}</Row><Row label="Target">{e.mcpTarget ?? '—'}</Row><Row label="Outcome">{e.mcpOutcome}</Row></>}
            <Row label="Status">
              {e.status ?? '—'}
              {e.retried && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">retried after 401 with refreshed credentials</span>}
            </Row>
            {e.upstream && <Row label="Upstream">{e.upstream.name} · user {e.upstream.userId}</Row>}
            <Row label="Client">{e.client ? link(e.client.name, { client: e.client.tokenId }) : link('Web console', { client: 'web' })}</Row>
            <Row label="Connection">{e.connection ? link(e.connection.name, { connection: e.connection.id }) : '—'}</Row>
            <Row label="Through">{SOURCES[e.source]}{e.savedCall && <> · {link(e.savedCall, { q: e.savedCall })}</>}</Row>
            <Row label="Time taken">{e.durationMs != null ? `${e.durationMs} ms` : '—'}</Row>
            {e.method !== 'TOKEN' && (
              <Row label="Size">
                {bytes(e.requestSize ?? 0)} sent · {e.responseSize != null ? `${bytes(e.responseSize)} received` : 'unknown received'}
                {e.responseType && <span className="text-zinc-500"> ({e.responseType.split(';')[0]})</span>}
              </Row>
            )}
            <Row label="From">
              {e.ip ?? '—'}
              {e.userAgent && <span className="block truncate text-xs text-zinc-500">{e.userAgent}</span>}
            </Row>
          </dl>
          {!!e.requestHeaders?.length && (
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Request headers</div>
              <table className="w-full text-[12.5px]">
                <tbody>
                  {e.requestHeaders.map((h, i) => (
                    <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                      <td className="whitespace-nowrap py-1.5 pr-4 align-top font-mono text-zinc-500">{h.name}</td>
                      <td className="break-all py-1.5 font-mono">
                        {h.value}
                        {h.byHub && (
                          <Badge tone="indigo" className="ml-2 align-middle font-sans">
                            Added by Switchboard
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {body && (
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Request body</div>
              {body.json !== undefined ? <JsonView value={body.json} /> : <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px]">{body.text}</pre>}
            </section>
          )}
          <p className="text-xs text-zinc-400">Secrets are masked before anything is stored. Request bodies are kept up to 4 KB; response bodies are not kept.</p>
        </div>
      )}
    </Dialog>
  );
}
