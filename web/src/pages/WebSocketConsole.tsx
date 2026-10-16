import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Connection, type SavedCall } from '../api';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, Spinner, Textarea, useToast } from '../components/ui';
import { JsonView } from '../components/JsonView';
import { useResource } from '../lib';

type Operation = { id: string; title: string; description?: string; mode: 'command' | 'subscription'; inputSchema: unknown; outputSchema?: unknown; eventSchema?: unknown; rest?: { method: string; path: string }; readOnlyHint?: boolean };
type Subscription = { id: string; operationId: string; status: string; reason?: string; expiresAt: number };
type Event = { sequence: number; time: number; value: unknown };
type Page = Subscription & { events: Event[]; nextCursor: number; gap?: { from: number; to: number } };

export function WebSocketConsole({ connection, onSaved }: { connection: Connection; onSaved(): void }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const root = `/connections/${connection.id}/websocket`;
  const [proxyAvailable, setProxyAvailable] = useState(false);
  const rawMode = params.get('wsMode') === 'proxy';
  const [operation, setOperation] = useState<Operation>();
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [events, setEvents] = useState<Record<string, Event[]>>({});
  const [gaps, setGaps] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(!document.hidden);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const cursors = useRef<Record<string, number>>({});
  const started = useRef(new Set<string>());
  const abort = useRef<AbortController | null>(null);
  const saved = useResource(() => api<SavedCall[]>('/calls'), [connection.id]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ proxy?: boolean }>(`${root}/operations?limit=1`, { signal: controller.signal }).then(page => setProxyAvailable(page.proxy === true)).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [connection.id]);
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
  const selectedSaved = saved.data?.find(call => call.id === params.get('saved') && call.kind === 'websocket' && call.connectionId === connection.id);
  const selectionKey = selectedSaved?.id ?? params.get('operation') ?? '';
  useEffect(() => {
    const id = selectedSaved?.websocketRequest?.operationId ?? params.get('operation');
    if (!id) return;
    const controller = new AbortController();
    setOperation(undefined); setError(''); setResult(undefined);
    api<{ operation: Operation }>(`${root}/operations/get`, { body: { operationId: id }, signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setOperation(value.operation); setArgs(JSON.stringify(selectedSaved?.websocketRequest?.arguments ?? {}, null, 2));
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [connection.id, selectionKey]);
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
    try { await api('/calls', { body: { name: saveName, connectionId: connection.id, kind: 'websocket', websocketRequest: { operationId: operation.id, arguments: argumentsValue() } } }); setSaveOpen(false); saved.reload(); onSaved(); toast('Command saved'); }
    catch (e: any) { setError(e.message); }
  }
  let jsonError = '';
  try { argumentsValue(); } catch (e: any) { jsonError = e.message; }
  const required = ((operation?.inputSchema as any)?.required ?? []) as string[];
  const missing = jsonError ? [] : required.filter(key => !Object.hasOwn(argumentsValue(), key));
  return <div className="space-y-4 p-3 sm:p-4">
    {error && <Alert>{error}</Alert>}
    {rawMode && (!proxyAvailable || connection.peer) && <Alert>WebSocket proxy is only available on supported local connections.</Alert>}
    {proxyAvailable && !connection.peer && <div className={rawMode ? '' : 'hidden'}><RawWebSocketConsole connectionId={connection.id} /></div>}
    <div className={rawMode ? 'hidden' : ''}>
      <div className="min-w-0 space-y-4">
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{operation?.title ?? 'Select an operation'}</h2>{operation?.description && <p className="text-[13px] text-zinc-500">{operation.description}</p>}
          {operation?.rest && !connection.peer && <details><summary className="text-xs text-zinc-500">REST binding</summary><p className="break-all font-mono text-xs">{operation.rest.method} /api/connections/{connection.id}/plugin{operation.rest.path}</p></details>}
          <FormField label="Arguments (JSON)"><Textarea aria-label="Arguments (JSON)" value={args} disabled={!operation || busy} onChange={e => setArgs(e.target.value)} rows={6} className="font-mono text-xs" /></FormField>
          {required.length > 0 && <p className="text-xs text-zinc-500">Required arguments: {required.join(', ')}</p>}
          {operation && jsonError && <Alert>{jsonError}</Alert>}
          {operation && <details><summary className="cursor-pointer text-xs text-zinc-500">Schemas and operation</summary><JsonView value={operation} /></details>}
          <div className="flex flex-wrap gap-2"><Button variant="primary" loading={busy} disabled={!operation || busy || !!jsonError || !!missing.length} onClick={run}>{operation?.mode === 'subscription' ? 'Start subscription' : 'Run command'}</Button>
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


/** WebSocket operations are supplied by the plugin catalog, not its REST OpenAPI document. */
export function WebSocketOperationReference({ connectionId, onPick, onProxy, proxyAllowed, selected }: { connectionId: string; onPick(id: string): void; onProxy(): void; proxyAllowed: boolean; selected: string | null }) {
  const [proxy, setProxy] = useState(false);
  const [query, setQuery] = useState('');
  const [operations, setOperations] = useState<Operation[]>([]);
  const [nextOffset, setNextOffset] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const root = `/connections/${connectionId}/websocket/operations`;
  const load = async (offset: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const signal = controller.signal;
    setLoading(true); setError('');
    try {
      const page = await api<{ operations: Operation[]; nextOffset?: number; proxy?: boolean }>(`${root}?query=${encodeURIComponent(query)}&limit=100&offset=${offset}`, { signal });
      setProxy(page.proxy === true);
      setOperations(old => offset ? [...old, ...page.operations] : page.operations);
      setNextOffset(page.nextOffset);
    } catch (e: any) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    setOperations([]); setNextOffset(undefined);
    void load(0);
    return () => request.current?.abort();
  }, [connectionId, query]);
  return <section aria-label="WebSocket API reference" className="border-b border-zinc-200 p-3 dark:border-zinc-800">
    <h2 className="mb-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300">WebSocket operations</h2>
    <Input aria-label="Search WebSocket API reference" placeholder="Search WebSocket operations" value={query} onChange={e => setQuery(e.target.value)} className="mb-2 h-8 text-[13px]" />
    {error && <Alert>{error}<Button size="sm" onClick={() => void load(0)}>Try again</Button></Alert>}
    {proxy && proxyAllowed && <Button size="sm" variant="ghost" className="mb-2 w-full justify-start" onClick={onProxy}>WebSocket proxy</Button>}
    <ul>{operations.map(op => <li key={op.id}>
      <button type="button" onClick={() => onPick(op.id)} title={op.description} aria-current={selected === op.id ? 'true' : undefined} className={`block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60 ${selected === op.id ? 'bg-indigo-50 dark:bg-indigo-500/10' : ''}`}>
        <span className="block text-[13px]">{op.title}</span>
        <span className="block truncate font-mono text-[11px] text-zinc-500">{op.mode} · {op.id}</span>
      </button>
    </li>)}</ul>
    {loading && <div className="flex justify-center p-2"><Spinner /></div>}
    {!loading && !error && !operations.length && <p className="p-2 text-xs text-zinc-500">No WebSocket operations match.</p>}
    {nextOffset !== undefined && <Button size="sm" loading={loading} onClick={() => void load(nextOffset)}>Load more</Button>}
  </section>;
}


function RawWebSocketConsole({ connectionId }: { connectionId: string }) {
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState('Disconnected');
  const [message, setMessage] = useState('{}');
  const [frames, setFrames] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => () => { socket.current?.close(); }, [connectionId]);
  const connect = () => {
    socket.current?.close(); setError(''); setFrames([]); setState('Connecting');
    const url = new URL(`/api/connections/${encodeURIComponent(connectionId)}/websocket/proxy`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); socket.current = ws;
    ws.onopen = () => setState('Connected');
    ws.onclose = () => { if (socket.current === ws) setState('Disconnected'); };
    ws.onerror = () => setError('WebSocket proxy could not connect or was interrupted.');
    ws.onmessage = event => setFrames(old => [...old, String(event.data).slice(0, 10000)].slice(-100));
  };
  const send = () => {
    try {
      if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('Connect first');
      JSON.parse(message);
      socket.current.send(message); setError('');
    } catch (error: any) { setError(error.message); }
  };
  return <Card className="space-y-3 p-4">
    <h2 className="text-sm font-semibold">WebSocket proxy · {state}</h2>
    <p className="text-[13px] text-zinc-500">Switchboard authenticates to the provider. Send provider protocol messages here; use unique message IDs to match replies.</p>
    {error && <Alert>{error}</Alert>}
    <div className="flex gap-2"><Button disabled={state === 'Connecting' || state === 'Connected'} onClick={connect}>Connect</Button><Button disabled={state === 'Disconnected'} onClick={() => socket.current?.close()}>Disconnect</Button></div>
    <FormField label="Message (JSON)"><Textarea value={message} onChange={event => setMessage(event.target.value)} rows={5} className="font-mono text-xs" /></FormField>
    <Button disabled={state !== 'Connected'} onClick={send}>Send message</Button>
    <div className="max-h-80 overflow-auto"><JsonView value={frames} /></div>
  </Card>;
}
