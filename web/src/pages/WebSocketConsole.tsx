import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Connection, type SavedCall } from '../api';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, PageHeader, Select, Textarea, useToast } from '../components/ui';
import { JsonView } from '../components/JsonView';
import { useResource } from '../lib';

type Operation = { id: string; title: string; description?: string; mode: 'command' | 'subscription'; inputSchema: unknown; outputSchema?: unknown; eventSchema?: unknown; readOnlyHint?: boolean };
type Subscription = { id: string; operationId: string; status: string; reason?: string; expiresAt: number };
type Event = { sequence: number; time: number; value: unknown };
type Page = Subscription & { events: Event[]; nextCursor: number; gap?: { from: number; to: number } };

export function WebSocketConsole({ connection, connections, onConnection, onHttp }: { connection: Connection; connections: Connection[]; onConnection(id: string): void; onHttp(): void }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const root = `/connections/${connection.id}/websocket`;
  const [query, setQuery] = useState('');
  const [operations, setOperations] = useState<Operation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | undefined>();
  const [operation, setOperation] = useState<Operation>();
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [events, setEvents] = useState<Record<string, Event[]>>({});
  const [gaps, setGaps] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(!document.hidden);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const cursors = useRef<Record<string, number>>({});
  const started = useRef(new Set<string>());
  const abort = useRef<AbortController | null>(null);
  const loadedSaved = useRef('');
  const saved = useResource(() => api<SavedCall[]>('/calls'), [connection.id]);
  async function load(offset = 0, signal?: AbortSignal) {
    setLoading(true);
    try {
      const page = await api<{ operations: Operation[]; nextOffset?: number }>(`${root}/operations?query=${encodeURIComponent(query)}&limit=100&offset=${offset}`, { signal });
      setOperations(old => offset ? [...old, ...page.operations] : page.operations); setNextOffset(page.nextOffset);
    } catch (e: any) { if (e.name !== 'AbortError') setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(0, controller.signal); return () => controller.abort(); }, [connection.id, query]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ subscriptions: Subscription[] }>(`${root}/subscriptions`, { signal: controller.signal }).then(page => setSubs(page.subscriptions)).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort(); abort.current?.abort(); document.removeEventListener('visibilitychange', visibility);
      for (const id of started.current) void api(`${root}/subscriptions/${id}`, { method: 'DELETE' }).catch(() => {});
    };
  }, [connection.id]);
  useEffect(() => {
    const id = params.get('saved');
    const call = saved.data?.find(call => call.id === id && call.kind === 'websocket' && call.connectionId === connection.id);
    if (!call?.websocketRequest || loadedSaved.current === id) return;
    loadedSaved.current = id!;
    const request = call.websocketRequest;
    api<{ operation: Operation }>(`${root}/operations/${encodeURIComponent(request.operationId)}`).then(value => { setOperation(value.operation); setArgs(JSON.stringify(request.arguments, null, 2)); }).catch(e => setError(e.message));
  }, [params, saved.data, connection.id]);
  const liveIds = subs.filter(s => s.status === 'active').map(s => s.id).join(',');
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    for (const id of liveIds.split(',').filter(Boolean)) {
      const poll = async () => {
        try {
          while (!controller.signal.aborted) {
            const page = await api<Page>(`${root}/subscriptions/${id}/read`, { body: { cursor: cursors.current[id] ?? 0, waitMs: 25000 }, signal: controller.signal });
            cursors.current[id] = page.nextCursor;
            setSubs(old => old.map(s => s.id === id ? page : s));
            if (page.gap) setGaps(old => ({ ...old, [id]: `Events ${page.gap!.from}–${page.gap!.to} were dropped.` }));
            setEvents(old => {
              const merged = [...(old[id] ?? []), ...page.events];
              while (merged.length > 200 || new TextEncoder().encode(JSON.stringify(merged)).byteLength > 1024 * 1024) merged.shift();
              return { ...old, [id]: merged };
            });
            if (page.status !== 'active') return;
          }
        } catch (e: any) {
          if (e.name !== 'AbortError') { setError(e.message); setSubs(old => old.map(s => s.id === id ? { ...s, status: 'interrupted', reason: e.message } : s)); }
        }
      };
      void poll();
    }
    return () => controller.abort();
  }, [liveIds, visible, connection.id]);
  async function pick(op: Operation) {
    setError(''); setResult(undefined); setOperation(undefined);
    try { const value = await api<{ operation: Operation }>(`${root}/operations/${encodeURIComponent(op.id)}`); setOperation(value.operation); setArgs('{}'); }
    catch (e: any) { setError(e.message); }
  }
  function argumentsValue() {
    const value = JSON.parse(args);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be a JSON object');
    return value;
  }
  async function run() {
    if (!operation || busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError('');
    try {
      const value = await api<any>(`${root}/${operation.mode === 'command' ? 'call' : 'subscriptions'}`, { body: { operationId: operation.id, arguments: argumentsValue() }, signal: controller.signal });
      if (operation.mode === 'command') setResult(value);
      else { started.current.add(value.id); setSubs(old => [...old, value]); }
    } catch (e: any) { setError(e.name === 'AbortError' ? 'Cancelled; the upstream outcome may be unknown.' : e.message); }
    finally { setBusy(false); }
  }
  async function stop(id: string) {
    try { const value = await api<Subscription>(`${root}/subscriptions/${id}`, { method: 'DELETE' }); started.current.delete(id); setSubs(old => old.map(s => s.id === id ? value : s)); }
    catch (e: any) { setError(e.message); }
  }
  async function save() {
    if (!operation) return;
    try { await api('/calls', { body: { name: saveName, connectionId: connection.id, kind: 'websocket', websocketRequest: { operationId: operation.id, arguments: argumentsValue() } } }); setSaveOpen(false); saved.reload(); toast('Command saved'); }
    catch (e: any) { setError(e.message); }
  }
  return <div className="h-full space-y-4 overflow-y-auto p-4 sm:p-6">
    <PageHeader title="Console" actions={<Select aria-label="Connection" value={connection.id} onChange={e => onConnection(e.target.value)}>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.serviceName}</option>)}</Select>} />
    <div className="flex items-center gap-2"><Button onClick={onHttp}>HTTP</Button><Badge>WebSocket</Badge></div>
    {error && <Alert>{error}</Alert>}
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="space-y-3 p-4"><Input aria-label="Search WebSocket operations" placeholder="Search operations" value={query} onChange={e => setQuery(e.target.value)} />
        {operations.map(op => <button type="button" key={op.id} disabled={busy} onClick={() => pick(op)} className="block w-full rounded px-2 py-2 text-left text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800"><span className="block font-medium">{op.title}</span><span className="text-xs text-zinc-500">{op.mode} · {op.id}</span></button>)}
        {!loading && !operations.length && <p className="text-xs text-zinc-500">No operations available.</p>}
        {nextOffset !== undefined && <Button loading={loading} onClick={() => load(nextOffset)}>Load more</Button>}
        {(saved.data ?? []).filter(s => s.kind === 'websocket' && s.connectionId === connection.id).map(s => <button type="button" key={s.id} onClick={() => { const request = s.websocketRequest!; api<{ operation: Operation }>(`${root}/operations/${encodeURIComponent(request.operationId)}`).then(value => { setOperation(value.operation); setArgs(JSON.stringify(request.arguments, null, 2)); }).catch(e => setError(e.message)); }} className="block w-full truncate text-left text-xs">Saved · {s.name}</button>)}
      </Card>
      <div className="min-w-0 space-y-4">
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{operation?.title ?? 'Select an operation'}</h2>{operation?.description && <p className="text-[13px] text-zinc-500">{operation.description}</p>}
          <FormField label="Arguments (JSON)"><Textarea aria-label="Arguments (JSON)" value={args} disabled={!operation || busy} onChange={e => setArgs(e.target.value)} rows={6} className="font-mono text-xs" /></FormField>
          {operation && <details><summary className="cursor-pointer text-xs text-zinc-500">Schemas and operation</summary><JsonView value={operation} /></details>}
          <div className="flex flex-wrap gap-2"><Button variant="primary" loading={busy} disabled={!operation || busy} onClick={run}>{operation?.mode === 'subscription' ? 'Start subscription' : 'Run command'}</Button>
            {operation?.mode === 'command' && <Button onClick={() => { setSaveName(operation.title); setSaveOpen(true); }}>Save command</Button>}{busy && <Button onClick={() => abort.current?.abort()}>Cancel</Button>}</div>
        </Card>
        {result !== undefined && <Card className="min-w-0 p-4"><h2 className="mb-2 text-sm font-semibold">Result</h2><JsonView value={result} /></Card>}
        {subs.map(s => <Card key={s.id} className="min-w-0 space-y-2 p-4"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{s.operationId}</h2><Badge>{s.status}</Badge>{s.status === 'active' && <Button size="sm" onClick={() => stop(s.id)}>Stop</Button>}</div>
          <p className="break-all text-xs text-zinc-500">{s.id} · Expires {new Date(s.expiresAt).toLocaleTimeString()}</p>{s.reason && <Alert>{s.reason}</Alert>}{gaps[s.id] && <Alert>{gaps[s.id]}</Alert>}
          {!visible && s.status === 'active' && <p className="text-xs text-zinc-500">Event reads paused.</p>}
          <div className="max-h-80 overflow-auto"><JsonView value={events[s.id] ?? []} /></div>
        </Card>)}
      </div>
    </div>
    <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title="Save command"><div className="space-y-3"><FormField label="Name"><Input value={saveName} onChange={e => setSaveName(e.target.value)} /></FormField><Button variant="primary" disabled={!saveName.trim()} onClick={save}>Save</Button></div></Dialog>
  </div>;
}
