import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  BookOpen, ChevronDown, ChevronRight, Download, FileCode2, MoreHorizontal, PanelLeft, Plug, RefreshCw, Save, Search, Send, Star, Trash2, X,
} from 'lucide-react';
import { api, type ApiDescription, type CallResult, type Connection, type Operation, type Pair, type SavedCall, type Service } from '../api';
import { useSession } from '../auth';
import { KeyValueEditor } from '../components/forms';
import { Alert, Badge, Button, CopyButton, Dialog, FormField, IconButton, Input, Menu, ServiceIcon, Spinner, Tabs, Textarea, useConfirm, useToast } from '../components/ui';
import { METHOD_COLORS, bytes, copy, cx, shellQuote, useResource } from '../lib';
import { JsonView } from '../components/JsonView';
import { McpConsole } from './McpConsole';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface Draft {
  method: string;
  url: string;
  pathParams: Record<string, string>;
  query: Pair[];
  headers: Pair[];
  body: string;
}

const emptyDraft = (): Draft => ({ method: 'GET', url: '', pathParams: {}, query: [], headers: [], body: '' });

const placeholders = (url: string) => [...new Set([...url.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]))];

const HEADER_SUGGESTIONS = ['Accept', 'Content-Type', 'If-None-Match', 'If-Match', 'Prefer', 'X-GitHub-Api-Version'];

export function Console() {
  const toast = useToast();
  const confirm = useConfirm();
  const { info } = useSession();
  const [params, setParams] = useSearchParams();
  const connections = useResource(() => api<Connection[]>('/connections'));
  const services = useResource(() => api<Service[]>('/services'));
  const saved = useResource(() => api<SavedCall[]>('/calls'));

  const usable = useMemo(() => (connections.data ?? []).filter((c) => c.status !== 'unavailable'), [connections.data]);
  // ?connection= takes an id or a name, like the rest of Switchboard; unknown ones fall back to the first.
  const wanted = params.get('connection');
  const connection = usable.find((c) => c.id === wanted || c.name === wanted) ?? usable[0];
  const connectionId = connection?.id ?? '';
  const setConnection = (id: string) => setParams((p) => ({ ...Object.fromEntries(p), connection: id }), { replace: true });

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [current, setCurrent] = useState<SavedCall | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>('params');
  const [side, setSide] = useState<'saved' | 'api'>('saved');
  const [sideOpen, setSideOpen] = useState(false);
  const [response, setResponse] = useState<CallResult | null>(null);
  const [callError, setCallError] = useState('');
  const [sending, setSending] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // API description of the selected connection
  const [descriptions, setDescriptions] = useState<Record<string, ApiDescription | Error | 'loading'>>({});
  const loadDescription = useCallback(
    async (c: Connection, refresh = false) => {
      setDescriptions((d) => ({ ...d, [c.id]: 'loading' }));
      try {
        const desc = await api<ApiDescription>(`/connections/${c.id}/openapi${refresh ? '?refresh=1' : ''}`);
        setDescriptions((d) => ({ ...d, [c.id]: desc }));
      } catch (e: any) {
        setDescriptions((d) => ({ ...d, [c.id]: e }));
      }
    },
    [],
  );
  useEffect(() => {
    if (connection?.hasOpenapi && side === 'api' && !descriptions[connection.id]) loadDescription(connection);
  }, [connection, side, descriptions, loadDescription]);

  // Load a saved call from the URL (?saved=)
  const savedParam = params.get('saved');
  useEffect(() => {
    if (!savedParam || !saved.data) return;
    const s = saved.data.find((x) => x.id === savedParam);
    if (s) loadSaved(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedParam, saved.data]);

  const loadSaved = (s: SavedCall) => {
    if (s.kind === 'mcp') { if (s.connectionId) setParams({ connection: s.connectionId, saved: s.id }, { replace: true }); return; }
    setDraft({ method: s.method, url: s.url, pathParams: s.pathParams, query: s.query, headers: s.headers, body: s.body });
    setCurrent(s);
    setOperation(null);
    setResponse(null);
    setCallError('');
    setSideOpen(false);
    if (s.connectionId && s.connectionId !== connectionId && usable.some((c) => c.id === s.connectionId)) setConnection(s.connectionId);
  };

  const description = connection ? descriptions[connection.id] : undefined;

  const loadOperation = (op: Operation, desc: ApiDescription) => {
    const base = (connection?.baseUrl ?? '').replace(/\/+$/, '');
    const server = desc.server.replace(/\/+$/, '');
    const prefix = base && server.startsWith(base) ? server.slice(base.length) : server;
    const pathParams: Record<string, string> = {};
    for (const p of op.params.filter((p) => p.in === 'path')) pathParams[p.name] = p.example ?? '';
    const query = op.params.filter((p) => p.in === 'query' && p.required).map((p) => ({ key: p.name, value: p.example ?? '', enabled: true }));
    const headers = op.body && op.body.contentType !== 'application/json' ? [{ key: 'Content-Type', value: op.body.contentType, enabled: true }] : [];
    if (op.body?.contentType === 'application/json') headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    setDraft({ method: op.method, url: prefix + op.path, pathParams, query, headers, body: op.body?.example ?? '' });
    setOperation(op);
    setCurrent(null);
    setResponse(null);
    setCallError('');
    setTab(op.body ? 'body' : 'params');
    setSideOpen(false);
  };

  const names = placeholders(draft.url);
  const isAbsolute = /^https?:\/\//i.test(draft.url);

  const send = async () => {
    if (!connection || sending) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSending(true);
    setCallError('');
    try {
      const pathParams = Object.fromEntries(names.map((n) => [n, draft.pathParams[n] ?? '']));
      const r = await api<CallResult>('/call', {
        body: { connection: connection.id, method: draft.method, url: draft.url, pathParams, query: draft.query, headers: draft.headers, body: draft.body },
        signal: ctrl.signal,
      });
      setResponse(r);
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setCallError(e.message);
        setResponse(null);
      }
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (connection?.kind === 'mcp') return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const curl = () => {
    if (!connection) return '';
    let path = draft.url;
    // Same as Switchboard: slashes in a value are path separators (e.g. Google's "notes/abc").
    for (const n of names) path = path.split(`{${n}}`).join((draft.pathParams[n] ?? '').split('/').map(encodeURIComponent).join('/'));
    const qs = new URLSearchParams(draft.query.filter((q) => q.key && q.enabled !== false).map((q) => [q.key, q.value])).toString();
    const target = `${info.publicUrl}/proxy/${connection.name}${isAbsolute ? '/' : ''}${path.startsWith('/') || isAbsolute || !path ? '' : '/'}${path}${qs ? `?${qs}` : ''}`;
    const parts = ['curl'];
    if (draft.method !== 'GET') parts.push('-X', draft.method);
    parts.push(shellQuote(target), '\\\n  -H "Authorization: Bearer $SWITCHBOARD_TOKEN"');
    for (const h of draft.headers.filter((h) => h.key && h.enabled !== false)) parts.push(`\\\n  -H ${shellQuote(`${h.key}: ${h.value}`)}`);
    if (draft.body && !['GET', 'HEAD'].includes(draft.method)) parts.push(`\\\n  --data ${shellQuote(draft.body)}`);
    return parts.join(' ');
  };

  const saveCall = async (name: string, asNew: boolean) => {
    const body = { name, connectionId: connection?.id ?? null, ...draft, pathParams: Object.fromEntries(names.map((n) => [n, draft.pathParams[n] ?? ''])) };
    const s = current && !asNew ? await api<SavedCall>(`/calls/${current.id}`, { method: 'PUT', body }) : await api<SavedCall>('/calls', { body });
    setCurrent(s);
    saved.reload();
    toast(current && !asNew ? 'Saved' : <>Saved as <b>{s.name}</b></>);
  };

  const deleteSaved = async (s: SavedCall) => {
    if (!(await confirm({ title: `Delete “${s.name}”?`, confirm: 'Delete', danger: true }))) return;
    await api(`/calls/${s.id}`, { method: 'DELETE' });
    if (current?.id === s.id) setCurrent(null);
    saved.reload();
  };

  if (connections.loading && !connections.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (!usable.length) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
          <Plug className="size-5" />
        </div>
        <h2 className="font-semibold">Nothing to call yet</h2>
        <p className="mt-1 text-[13px] text-zinc-500">Connect an account first.</p>
        <Link to="/connections" className="mt-5">
          <Button variant="primary">Go to connections</Button>
        </Link>
      </div>
    );
  }

  const service = services.data?.find((s) => s.id === connection?.serviceId);
  if (connection?.kind === 'mcp') return <McpConsole key={connection.id} connection={connection} connections={usable} onConnection={setConnection} />;
  const groups = new Map<string, Connection[]>();
  for (const c of usable) groups.set(c.serviceName, [...(groups.get(c.serviceName) ?? []), c]);

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
        <Menu
          block
          align="start"
          width={300}
          trigger={(p) => (
            <button
              {...p}
              className="flex w-full items-center gap-2.5 rounded-lg bg-white px-2.5 py-2 text-left ring-1 ring-zinc-200 hover:ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:ring-zinc-700"
            >
              <ServiceIcon icon={connection?.icon ?? service?.icon} name={connection?.serviceName ?? '?'} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{connection?.account?.label ?? connection?.name}</span>
                <span className="block truncate font-mono text-[11px] text-zinc-500">{connection?.name}</span>
              </span>
              <ChevronDown className="size-4 text-zinc-400" />
            </button>
          )}
          items={[...groups.entries()].flatMap(([serviceName, list]) => [
            { heading: serviceName },
            ...list.map((c) => ({
              label: (
                <span className="flex flex-col">
                  <span className="truncate">{c.account?.label ?? c.name}</span>
                  <span className="truncate font-mono text-[11px] text-zinc-500">{c.name}</span>
                </span>
              ),
              icon: <ServiceIcon icon={c.icon ?? services.data?.find((s) => s.id === c.serviceId)?.icon} name={c.serviceName} size="sm" />,
              onSelect: () => {
                setConnection(c.id);
                setOperation(null);
              },
            })),
          ])}
        />
      </div>
      <Tabs
        className="px-3 pt-2"
        value={side}
        onChange={setSide}
        tabs={[
          { value: 'saved', label: 'Saved' },
          { value: 'api', label: 'API reference' },
        ]}
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {side === 'saved' ? (
          <SavedList calls={(saved.data ?? []).filter(s => s.kind !== 'mcp')} connections={usable} currentId={current?.id} onPick={loadSaved} onDelete={deleteSaved} />
        ) : !connection?.hasOpenapi ? (
          <p className="p-4 text-[13px] text-zinc-500">{connection?.serviceName} has no API description.</p>
        ) : description === 'loading' || description === undefined ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : description instanceof Error ? (
          <div className="space-y-2 p-3">
            <Alert>{description.message}</Alert>
            <Button size="sm" onClick={() => loadDescription(connection, true)}>
              Try again
            </Button>
          </div>
        ) : (
          <OperationList description={description} selected={operation} onPick={(op) => loadOperation(op, description)} onRefresh={() => loadDescription(connection, true)} />
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-80 shrink-0 border-r border-zinc-200 bg-zinc-50/60 lg:block dark:border-zinc-800 dark:bg-zinc-900/30">{sidebar}</aside>
      {sideOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-950/40" onClick={() => setSideOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[min(20rem,90vw)] animate-pop bg-zinc-50 shadow-xl dark:bg-zinc-900">{sidebar}</aside>
        </div>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        {/* request line */}
        <div className="border-b border-zinc-200 p-3 sm:p-4 dark:border-zinc-800">
          <div className="mb-2.5 flex min-h-7 items-center gap-2">
            <IconButton label="Browse" className="lg:hidden" onClick={() => setSideOpen(true)}>
              <PanelLeft className="size-4" />
            </IconButton>
            <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-600 dark:text-zinc-300">
              {current ? (
                <span className="flex items-center gap-1.5">
                  <Star className="size-3.5 fill-amber-400 text-amber-400" />
                  {current.name}
                </span>
              ) : operation ? (
                operation.summary ?? operation.id
              ) : (
                'New request'
              )}
            </h1>
            <Button size="sm" variant="ghost" icon={<FileCode2 className="size-3.5" />} onClick={() => copy(curl()).then(() => toast('Copied as curl'))}>
              Copy as curl
            </Button>
            <Button size="sm" icon={<Save className="size-3.5" />} onClick={() => (current ? saveCall(current.name, false).catch((e) => toast(e.message, 'error')) : setSaveOpen(true))}>
              Save
            </Button>
            <Menu
              trigger={(p) => (
                <IconButton label="More" {...p} className="size-7">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              )}
              items={[
                { label: 'Save as new…', icon: <Save />, onSelect: () => setSaveOpen(true) },
                {
                  label: 'Copy run command',
                  icon: <FileCode2 />,
                  hidden: !current,
                  onSelect: () =>
                    copy(`curl -X POST -H "Authorization: Bearer $SWITCHBOARD_TOKEN" ${info.publicUrl}/api/calls/${current!.id}/run`).then(() => toast('Copied. POST a JSON body to override query, headers or body.')),
                },
                {
                  label: 'New request',
                  icon: <X />,
                  onSelect: () => {
                    setDraft(emptyDraft());
                    setCurrent(null);
                    setOperation(null);
                    setResponse(null);
                    setCallError('');
                  },
                },
              ]}
            />
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg bg-white ring-1 ring-inset ring-zinc-200 focus-within:ring-2 focus-within:ring-indigo-500 dark:bg-zinc-900 dark:ring-zinc-700/80">
              <select
                value={draft.method}
                onChange={(e) => setDraft({ ...draft, method: e.target.value })}
                aria-label="Method"
                className={cx('h-9 shrink-0 appearance-none border-r border-zinc-200 bg-transparent pl-3 pr-2 font-mono text-[12.5px] font-semibold outline-none dark:border-zinc-700/80', METHOD_COLORS[draft.method])}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m} className="text-zinc-900">
                    {m}
                  </option>
                ))}
              </select>
              {!isAbsolute && connection?.baseUrl && (
                <span className="hidden max-w-[40%] shrink-0 items-center truncate pl-3 font-mono text-[12.5px] text-zinc-400 sm:flex" title={connection.baseUrl}>
                  {connection.baseUrl.replace(/\/+$/, '')}
                </span>
              )}
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder={connection?.baseUrl ? '/path' : 'https://…'}
                spellCheck={false}
                aria-label="URL"
                className={cx('h-9 min-w-0 flex-1 bg-transparent pr-3 font-mono text-[12.5px] outline-none placeholder:text-zinc-400', !isAbsolute && connection?.baseUrl ? 'sm:pl-0.5 pl-3' : 'pl-3')}
              />
            </div>
            <Button type="submit" variant="primary" loading={sending} icon={<Send className="size-4" />} title="Send (Ctrl+Enter)">
              Send
            </Button>
          </form>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-2 xl:grid-rows-1">
          {/* request editor */}
          <div className="scrollbar-thin min-h-0 overflow-y-auto p-3 sm:p-4">
            {operation && <OperationDocs op={operation} />}
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'params', label: <>Params{count(draft.query) + names.length > 0 && <Count n={count(draft.query) + names.length} />}</> },
                { value: 'headers', label: <>Headers{count(draft.headers) > 0 && <Count n={count(draft.headers)} />}</> },
                { value: 'body', label: <>Body{draft.body && <span className="size-1.5 rounded-full bg-indigo-500" />}</> },
              ]}
            />
            <div className="pt-4">
              {tab === 'params' && (
                <div className="space-y-5">
                  {names.length > 0 && (
                    <div className="space-y-2">
                      <SectionLabel>Path</SectionLabel>
                      <div className="overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
                        {names.map((n, i) => {
                          const doc = operation?.params.find((p) => p.in === 'path' && p.name === n);
                          return (
                            <div key={n} className={cx('flex items-center', i > 0 && 'border-t border-zinc-100 dark:border-zinc-800')}>
                              <span className="w-2/5 shrink-0 truncate px-3 font-mono text-[12.5px] text-zinc-600 dark:text-zinc-300" title={doc?.description}>
                                {n}
                              </span>
                              <input
                                value={draft.pathParams[n] ?? ''}
                                onChange={(e) => setDraft({ ...draft, pathParams: { ...draft.pathParams, [n]: e.target.value } })}
                                placeholder={doc?.description ? doc.description.split(/[.\n]/)[0].slice(0, 80) : 'Value'}
                                spellCheck={false}
                                className="h-9 min-w-0 flex-1 border-l border-zinc-100 bg-transparent px-3 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-zinc-400 focus:bg-indigo-50/40 dark:border-zinc-800 dark:focus:bg-indigo-500/5"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    <SectionLabel>Query</SectionLabel>
                    <KeyValueEditor
                      pairs={draft.query}
                      onChange={(query) => setDraft({ ...draft, query })}
                      suggestions={operation?.params.filter((p) => p.in === 'query').map((p) => p.name)}
                    />
                    {operation && operation.params.some((p) => p.in === 'query') && <QueryHints op={operation} draft={draft} onAdd={(key) => setDraft({ ...draft, query: [...draft.query, { key, value: '', enabled: true }] })} />}
                  </div>
                </div>
              )}
              {tab === 'headers' && (
                <div className="space-y-2">
                  <KeyValueEditor pairs={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} keyPlaceholder="Header" suggestions={HEADER_SUGGESTIONS} />
                  <p className="text-xs text-zinc-500">Authentication headers are added by Switchboard.</p>
                </div>
              )}
              {tab === 'body' && <BodyEditor draft={draft} setDraft={setDraft} />}
            </div>
          </div>

          {/* response */}
          <div className="min-h-0 border-t border-zinc-200 xl:border-l xl:border-t-0 dark:border-zinc-800">
            <ResponseView response={response} error={callError} sending={sending} />
          </div>
        </div>
      </section>

      <SaveDialog
        open={saveOpen}
        initialName={current?.name ?? operation?.summary?.slice(0, 60) ?? ''}
        onClose={() => setSaveOpen(false)}
        onSave={async (name) => {
          await saveCall(name, true);
          setSaveOpen(false);
        }}
      />
    </div>
  );
}

const count = (p: Pair[]) => p.filter((x) => x.key && x.enabled !== false).length;

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-zinc-100 px-1.5 text-[10.5px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{n}</span>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{children}</div>;
}

function MethodTag({ method, className }: { method: string; className?: string }) {
  return <span className={cx('inline-block w-12 shrink-0 font-mono text-[10.5px] font-bold', METHOD_COLORS[method], className)}>{method === 'DELETE' ? 'DEL' : method}</span>;
}

function SavedList({
  calls, connections, currentId, onPick, onDelete,
}: { calls: SavedCall[]; connections: Connection[]; currentId?: string; onPick: (s: SavedCall) => void; onDelete: (s: SavedCall) => void }) {
  if (!calls.length) {
    return (
      <div className="p-5 text-center text-[13px] text-zinc-500">
        <Star className="mx-auto mb-2 size-5 text-zinc-300 dark:text-zinc-600" />
        Save requests to reuse them here and run them from scripts.
      </div>
    );
  }
  return (
    <ul className="p-2">
      {calls.map((s) => {
        const conn = connections.find((c) => c.id === s.connectionId);
        return (
          <li key={s.id} className="group relative">
            <button
              type="button"
              onClick={() => onPick(s)}
              className={cx(
                'flex w-full items-start gap-1 rounded-lg px-2.5 py-2 pr-8 text-left transition-colors',
                currentId === s.id ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
              )}
            >
              <MethodTag method={s.method} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block truncate text-[13px]">{s.name}</span>
                <span className="block truncate font-mono text-[11px] text-zinc-500">{conn?.name ?? 'No connection'}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(s)}
              aria-label={`Delete ${s.name}`}
              className="absolute right-1.5 top-2 rounded-md p-1 text-zinc-400 opacity-0 hover:bg-zinc-200 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-700"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OperationList({ description, selected, onPick, onRefresh }: { description: ApiDescription; selected: Operation | null; onPick: (op: Operation) => void; onRefresh: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const query = q.trim().toLowerCase();
  const tags = useMemo(() => {
    const m = new Map<string, Operation[]>();
    for (const op of description.operations) m.set(op.tag, [...(m.get(op.tag) ?? []), op]);
    return [...m.entries()];
  }, [description]);
  const filtered = useMemo(() => {
    if (!query) return null;
    const words = query.split(/\s+/);
    return description.operations
      .filter((op) => {
        const hay = `${op.method} ${op.path} ${op.summary ?? ''} ${op.id} ${op.tag}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 200);
  }, [query, description]);
  const collapsedByDefault = description.operations.length > 60;

  const item = (op: Operation) => (
    <li key={`${op.method} ${op.path}`}>
      <button
        type="button"
        onClick={() => onPick(op)}
        title={op.path}
        className={cx(
          'flex w-full items-start gap-1 rounded-lg px-2.5 py-1.5 text-left transition-colors',
          selected === op ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
          op.deprecated && 'opacity-50',
        )}
      >
        <MethodTag method={op.method} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block truncate text-[13px]">{op.summary ?? op.id}</span>
          <span className="block truncate font-mono text-[11px] text-zinc-500">{op.path}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div className="p-2">
      <div className="relative mb-2 px-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${description.operations.length} operations`} className="h-8 pl-8 text-[13px]" />
      </div>
      {filtered ? (
        filtered.length ? <ul>{filtered.map(item)}</ul> : <p className="p-3 text-[13px] text-zinc-500">No operations match.</p>
      ) : (
        <div>
          {tags.map(([tag, ops]) => {
            const isOpen = open[tag] ?? (!collapsedByDefault || tags.length === 1);
            return (
              <div key={tag}>
                <button
                  type="button"
                  onClick={() => setOpen({ ...open, [tag]: !isOpen })}
                  className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-[12px] font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
                >
                  <ChevronRight className={cx('size-3.5 text-zinc-400 transition-transform', isOpen && 'rotate-90')} />
                  <span className="flex-1 truncate">{tag}</span>
                  <span className="text-[11px] font-normal text-zinc-400">{ops.length}</span>
                </button>
                {isOpen && <ul className="mb-1">{ops.map(item)}</ul>}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-200 px-1.5 pt-2 text-[11px] text-zinc-400 dark:border-zinc-800">
        <span className="truncate">
          {description.title} {description.version}
        </span>
        <button type="button" onClick={onRefresh} className="flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200" title="Reload the API description">
          <RefreshCw className="size-3" />
        </button>
      </div>
    </div>
  );
}

function OperationDocs({ op }: { op: Operation }) {
  const [expanded, setExpanded] = useState(false);
  const text = op.description && op.description.trim() !== op.summary?.trim() ? op.description : undefined;
  if (!text && !op.deprecated) return null;
  return (
    <div className="mb-4 rounded-lg bg-zinc-50 px-3 py-2.5 text-[13px] ring-1 ring-zinc-200 dark:bg-zinc-900/60 dark:ring-zinc-800">
      <div className="flex items-start gap-2">
        <BookOpen className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          {op.deprecated && (
            <Badge tone="amber" className="mb-1">
              Deprecated
            </Badge>
          )}
          {text && <p className={cx('whitespace-pre-line leading-relaxed text-zinc-600 dark:text-zinc-300', !expanded && 'line-clamp-2')}>{text}</p>}
          {text && text.length > 140 && (
            <button type="button" onClick={() => setExpanded(!expanded)} className="mt-1 text-xs font-medium text-indigo-600 dark:text-indigo-400">
              {expanded ? 'Less' : 'More'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function QueryHints({ op, draft, onAdd }: { op: Operation; draft: Draft; onAdd: (key: string) => void }) {
  const used = new Set(draft.query.map((q) => q.key));
  const available = op.params.filter((p) => p.in === 'query' && !used.has(p.name));
  if (!available.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-xs text-zinc-500">Add:</span>
      {available.slice(0, 24).map((p) => (
        <button
          key={p.name}
          type="button"
          title={p.description}
          onClick={() => onAdd(p.name)}
          className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 hover:bg-indigo-50 hover:text-indigo-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-indigo-500/15 dark:hover:text-indigo-300"
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

const CONTENT_TYPES = [
  { label: 'JSON', value: 'application/json' },
  { label: 'Form', value: 'application/x-www-form-urlencoded' },
  { label: 'Text', value: 'text/plain' },
];

function BodyEditor({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const ctIndex = draft.headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && h.enabled !== false);
  const ct = ctIndex >= 0 ? draft.headers[ctIndex].value : '';
  const setCt = (value: string) => {
    const headers = draft.headers.filter((_, i) => i !== ctIndex);
    setDraft({ ...draft, headers: value ? [...headers, { key: 'Content-Type', value, enabled: true }] : headers });
  };
  let jsonError = '';
  if (ct.includes('json') && draft.body.trim()) {
    try {
      JSON.parse(draft.body);
    } catch (e: any) {
      jsonError = e.message;
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {CONTENT_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setCt(ct === t.value ? '' : t.value)}
            className={cx(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors',
              ct === t.value ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            {t.label}
          </button>
        ))}
        {ct && !CONTENT_TYPES.some((t) => t.value === ct) && <code className="px-2 font-mono text-xs text-zinc-500">{ct}</code>}
        <span className="flex-1" />
        {ct.includes('json') && draft.body.trim() && !jsonError && (
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, body: JSON.stringify(JSON.parse(draft.body), null, 2) })}>
            Format
          </Button>
        )}
      </div>
      <Textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        rows={14}
        spellCheck={false}
        placeholder={['GET', 'HEAD'].includes(draft.method) ? `${draft.method} requests have no body` : 'Request body'}
        className="min-h-48 resize-y font-mono text-[12.5px] leading-relaxed"
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            const v = t.value.slice(0, a) + '  ' + t.value.slice(b);
            setDraft({ ...draft, body: v });
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
      />
      {jsonError && <p className="text-xs text-amber-600 dark:text-amber-400">Not valid JSON: {jsonError}</p>}
    </div>
  );
}

function statusTone(s: number) {
  if (s < 300) return 'text-emerald-700 bg-emerald-50 ring-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:ring-emerald-500/20';
  if (s < 400) return 'text-sky-700 bg-sky-50 ring-sky-200 dark:text-sky-300 dark:bg-sky-500/10 dark:ring-sky-500/20';
  if (s < 500) return 'text-amber-700 bg-amber-50 ring-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/20';
  return 'text-rose-700 bg-rose-50 ring-rose-200 dark:text-rose-300 dark:bg-rose-500/10 dark:ring-rose-500/20';
}

function ResponseView({ response: r, error, sending }: { response: CallResult | null; error: string; sending: boolean }) {
  const [tab, setTab] = useState<'body' | 'headers' | 'request'>('body');
  const [raw, setRaw] = useState(false);
  const type = r?.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  const parsed = useMemo(() => {
    if (!r || r.bodyEncoding !== 'utf8' || !r.body) return undefined;
    if (!type.includes('json') && !/^\s*[[{]/.test(r.body)) return undefined;
    try {
      return { value: JSON.parse(r.body) };
    } catch {
      return undefined;
    }
  }, [r, type]);

  if (sending && !r) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-[13px] text-zinc-400">
        <Send className="mb-1 size-5" />
        <p>Send a request to see the response.</p>
        <p className="text-xs">
          <kbd className="rounded border border-zinc-200 px-1 font-sans dark:border-zinc-700">Ctrl</kbd> +{' '}
          <kbd className="rounded border border-zinc-200 px-1 font-sans dark:border-zinc-700">Enter</kbd>
        </p>
      </div>
    );
  }

  const download = () => {
    const bin = r.bodyEncoding === 'base64' ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(r.body);
    const url = URL.createObjectURL(new Blob([bin], { type: type || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = new URL(r.url).pathname.split('/').pop() || 'response';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={cx('flex h-full min-h-0 flex-col', sending && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 sm:px-4">
        <span className={cx('rounded-md px-2 py-0.5 font-mono text-xs font-semibold ring-1 ring-inset', statusTone(r.status))}>
          {r.status} {r.statusText}
        </span>
        <span className="text-xs text-zinc-500">{r.durationMs} ms</span>
        <span className="text-xs text-zinc-500">{bytes(r.size)}</span>
        <span className="flex-1" />
        {r.bodyEncoding === 'utf8' && r.body && <CopyButton text={r.body} label="Copy body" className="size-7" />}
        <IconButton label="Download" className="size-7" onClick={download}>
          <Download className="size-4" />
        </IconButton>
      </div>
      <Tabs
        className="px-3 pt-2 sm:px-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'body', label: 'Body' },
          { value: 'headers', label: <>Headers <Count n={r.headers.length} /></> },
          { value: 'request', label: 'Request' },
        ]}
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {tab === 'request' ? (
          <SentRequest request={r.request} />
        ) : tab === 'headers' ? (
          <table className="w-full text-[12.5px]">
            <tbody>
              {r.headers.map(([k, v], i) => (
                <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="whitespace-nowrap py-1.5 pr-4 align-top font-mono text-zinc-500">{k}</td>
                  <td className="break-all py-1.5 font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : r.bodyEncoding === 'base64' ? (
          type.startsWith('image/') ? (
            <img src={`data:${type};base64,${r.body}`} alt="Response" className="max-w-full rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800" />
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-[13px] text-zinc-500">
              Binary response ({type || 'unknown type'}, {bytes(r.size)})
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>
                Download
              </Button>
            </div>
          )
        ) : !r.body ? (
          <p className="text-[13px] text-zinc-400">Empty body</p>
        ) : parsed && !raw ? (
          <>
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setRaw(true)} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                Raw
              </button>
            </div>
            <JsonView value={parsed.value} />
          </>
        ) : (
          <>
            {parsed && (
              <div className="mb-2 flex justify-end">
                <button type="button" onClick={() => setRaw(false)} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                  Pretty
                </button>
              </div>
            )}
            <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed">{r.body}</pre>
          </>
        )}
      </div>
    </div>
  );
}

function SentRequest({ request: q }: { request: CallResult['request'] }) {
  const type = q.headers.find((h) => h.name === 'content-type')?.value ?? '';
  const parsed = useMemo(() => {
    if (q.bodyEncoding !== 'utf8' || !q.body || q.truncated) return undefined;
    if (!type.includes('json') && !/^\s*[[{]/.test(q.body)) return undefined;
    try {
      return { value: JSON.parse(q.body) };
    } catch {
      return undefined;
    }
  }, [q, type]);
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionLabel>URL</SectionLabel>
        <div className="flex items-start gap-2 rounded-lg bg-zinc-50 py-1 pl-3 pr-1 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <span className={cx('py-1 font-mono text-[12.5px] font-semibold', METHOD_COLORS[q.method])}>{q.method}</span>
          <code className="min-w-0 flex-1 break-all py-1 font-mono text-[12.5px]">{q.url}</code>
          <CopyButton text={q.url} label="Copy URL" className="size-7" />
        </div>
        {q.retried && <p className="text-xs text-amber-600 dark:text-amber-400">The first attempt got 401 Unauthorized; this is the retry with refreshed credentials.</p>}
      </section>
      <section className="space-y-2">
        <SectionLabel>Headers</SectionLabel>
        {q.headers.length ? (
          <table className="w-full text-[12.5px]">
            <tbody>
              {q.headers.map((h, i) => (
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
        ) : (
          <p className="text-[13px] text-zinc-400">None</p>
        )}
        <p className="text-xs text-zinc-400">Standard headers such as User-Agent and Accept-Encoding are added when sending.</p>
      </section>
      <section className="space-y-2">
        <SectionLabel>Body</SectionLabel>
        {!q.size ? (
          <p className="text-[13px] text-zinc-400">No body</p>
        ) : q.bodyEncoding === 'base64' ? (
          <p className="text-[13px] text-zinc-500">Binary body ({type || 'unknown type'}, {bytes(q.size)})</p>
        ) : parsed ? (
          <JsonView value={parsed.value} />
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed">{q.body}</pre>
        )}
        {q.truncated && <p className="text-xs text-zinc-400">Showing the first 1 MB of {bytes(q.size)}.</p>}
      </section>
    </div>
  );
}

function SaveDialog({ open, initialName, onClose, onSave }: { open: boolean; initialName: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initialName);
      setError('');
    }
  }, [open, initialName]);
  return (
    <Dialog open={open} onClose={onClose} title="Save request" size="sm">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(name);
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="Name" htmlFor="save-name" description="Scripts can run it by name or id.">
          <Input id="save-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
