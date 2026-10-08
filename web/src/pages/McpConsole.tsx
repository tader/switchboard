import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type Connection, type SavedCall } from '../api';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, PageHeader, Select, Spinner, Tabs, Textarea, useToast } from '../components/ui';
import { useResource } from '../lib';
import { JsonView } from '../components/JsonView';

type Tab = 'tools' | 'resources' | 'prompts';
type Item = { name: string; description?: string; uri?: string; uriTemplate?: string; inputSchema?: any; outputSchema?: any; annotations?: any; arguments?: { name: string; required?: boolean }[] };

export function McpConsole({ connection, connections, onConnection }: { connection: Connection; connections: Connection[]; onConnection: (id: string) => void }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const saved = useResource(() => api<SavedCall[]>('/calls'), [connection.id]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const savedDraft = useRef<{ target: string; args: string } | null>(null);
  const loadedSaved = useRef<string | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const linkedUri = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const invoke = (operation: string, body: any, signal?: AbortSignal) => api(`/connections/${connection.id}/mcp/${operation}`, { body, signal });
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true); setItems([]); setSelected(null); setTarget(savedDraft.current?.target ?? linkedUri.current ?? ''); if (savedDraft.current) setArgs(savedDraft.current.args); savedDraft.current = null; linkedUri.current = null; setResult(null); setError(''); setListError('');
    const list = async () => {
      try {
        const data = await invoke(`${tab}/list`, {}, ctrl.signal);
        let list: Item[] = data[tab];
        if (tab === 'resources') {
          try {
            const templates = await invoke('resources/templates/list', {}, ctrl.signal);
            list = [...list, ...templates.resourceTemplates];
          } catch (error: any) {
            if (!/does not support/i.test(error.message)) throw error;
          }
        }
        if (!ctrl.signal.aborted) setItems(list);
      } catch (e: any) { if (!ctrl.signal.aborted) setListError(e.message); }
      finally { if (!ctrl.signal.aborted) setLoading(false); }
    };
    list();
    return () => { ctrl.abort(); abort.current?.abort(); };
    // The connection is keyed by its id in the parent; each tab owns its discovery request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, revision]);
  const choose = (item: Item) => {
    abort.current?.abort(); setBusy(false); setSelected(item); setTarget(item.uri ?? item.uriTemplate ?? item.name); setResult(null); setError('');
    const names = tab === 'prompts' ? item.arguments?.filter(a => a.required).map(a => a.name) ?? [] : item.inputSchema?.required ?? [];
    const initial: Record<string, unknown> = {};
    for (const name of names) {
      const field = item.inputSchema?.properties?.[name];
      initial[name] = field?.default ?? (field?.type === 'boolean' ? false : field?.type === 'integer' || field?.type === 'number' ? 0 : field?.type === 'array' ? [] : field?.type === 'object' ? {} : '');
    }
    setArgs(JSON.stringify(initial, null, 2));
  };
  const loadSaved = (request: SavedCall) => {
    if (!request.mcpRequest) return;
    abort.current?.abort(); setBusy(false); setSelected(null); setResult(null); setError('');
    const next: Tab = request.mcpRequest.operation === 'tools/call' ? 'tools' : request.mcpRequest.operation === 'resources/read' ? 'resources' : 'prompts';
    const draft = { target: request.mcpRequest.name ?? request.mcpRequest.uri ?? '', args: JSON.stringify(request.mcpRequest.arguments ?? {}, null, 2) };
    if (next !== tab) savedDraft.current = draft;
    setTab(next); setTarget(draft.target); setArgs(draft.args);
  };
  useEffect(() => {
    const id = params.get('saved');
    if (!id || loadedSaved.current === id) return;
    const request = saved.data?.find(s => s.id === id && s.kind === 'mcp' && s.connectionId === connection.id);
    if (request) { loadedSaved.current = id; loadSaved(request); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data, params]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const operation = tab === 'tools' ? 'tools/call' : tab === 'resources' ? 'resources/read' : 'prompts/get';
      await api('/calls', { body: { kind: 'mcp', name: saveName, connectionId: connection.id, mcpRequest: { operation, ...(tab === 'resources' ? { uri: target } : { name: target, arguments: JSON.parse(args) }) } } });
      saved.reload(); setSaveOpen(false); toast('Saved');
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };
  const run = async () => {
    if (busy) return;
    const ctrl = new AbortController(); abort.current = ctrl;
    setBusy(true); setError(''); setResult(null);
    try {
      const operation = tab === 'tools' ? 'tools/call' : tab === 'resources' ? 'resources/read' : 'prompts/get';
      const body = tab === 'resources' ? { uri: target } : { name: target, arguments: JSON.parse(args) };
      const value = await invoke(operation, body, ctrl.signal);
      if (!ctrl.signal.aborted) setResult(value);
    } catch (e: any) { if (!ctrl.signal.aborted) setError(e.message); }
    finally { if (abort.current === ctrl) setBusy(false); }
  };
  return <div className="space-y-4 p-4 sm:p-6">
    <PageHeader title="Console" actions={<Select aria-label="Connection" value={connection.id} onChange={e => onConnection(e.target.value)} className="max-w-full sm:max-w-xs">{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.serviceName}</option>)}</Select>} />
    <Tabs value={tab} onChange={setTab} tabs={[{ value: 'tools', label: 'Tools' }, { value: 'resources', label: 'Resources' }, { value: 'prompts', label: 'Prompts' }]} />
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="min-w-0 space-y-3 p-3">
        <div className="flex gap-2"><Input aria-label="Search MCP items" placeholder="Search…" value={filter} onChange={e => setFilter(e.target.value)} /><Button size="sm" onClick={() => setRevision(v => v + 1)} disabled={loading}>Refresh</Button></div>
        {loading ? <Spinner /> : listError ? <Alert>{listError}</Alert> : <ul className="max-h-96 space-y-1 overflow-y-auto">{items.filter(i => `${i.name} ${i.description ?? ''} ${i.uri ?? i.uriTemplate ?? ''}`.toLowerCase().includes(filter.toLowerCase())).map((item, n) => <li key={`${item.name}-${n}`}><button type="button" onClick={() => choose(item)} className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"><span className="block truncate text-[13px] font-medium">{item.name}</span><span className="block truncate text-xs text-zinc-500">{item.uriTemplate ? 'Template · ' : ''}{item.description ?? item.uri ?? item.uriTemplate}</span></button></li>)}</ul>}
        {!loading && !listError && !items.length && <p className="text-xs text-zinc-500">No {tab} available.</p>}
        {(saved.data ?? []).some(s => s.kind === 'mcp' && s.connectionId === connection.id) && <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800"><h2 className="mb-1 text-xs font-medium text-zinc-500">Saved requests</h2>{saved.data?.filter(s => s.kind === 'mcp' && s.connectionId === connection.id).map(s => <button type="button" key={s.id} onClick={() => loadSaved(s)} className="block w-full truncate rounded px-2 py-1.5 text-left text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={`Load ${s.name}`}>{s.name}</button>)}</div>}
      </Card>
      <div className="min-w-0 space-y-4">
        <Card className="space-y-3 p-4">
          <FormField label={tab === 'resources' ? 'Resource URI' : tab === 'tools' ? 'Tool' : 'Prompt'}><Input value={target} onChange={e => setTarget(e.target.value)} placeholder={tab === 'resources' ? 'file:///notes' : 'Select an item'} /></FormField>
          {selected?.description && <p className="text-[13px] text-zinc-500">{selected.description}</p>}
          {tab !== 'resources' && <FormField label="Arguments (JSON)"><Textarea aria-label="Arguments (JSON)" value={args} onChange={e => setArgs(e.target.value)} rows={5} className="font-mono text-xs" spellCheck={false} /></FormField>}
          {selected?.inputSchema && <details className="text-xs"><summary className="cursor-pointer text-zinc-500">Input schema</summary><JsonView value={selected.inputSchema} /></details>}
          {selected?.outputSchema && <details className="text-xs"><summary className="cursor-pointer text-zinc-500">Output schema</summary><JsonView value={selected.outputSchema} /></details>}
          {selected?.annotations && <details className="text-xs"><summary className="cursor-pointer text-zinc-500">Annotations</summary><JsonView value={selected.annotations} /></details>}
          {selected?.arguments && <details className="text-xs"><summary className="cursor-pointer text-zinc-500">Prompt arguments</summary><JsonView value={selected.arguments} /></details>}
          <div className="flex gap-2"><Button variant="primary" loading={busy} disabled={!target || busy} onClick={run}>{tab === 'tools' ? 'Call tool' : tab === 'resources' ? 'Read resource' : 'Get prompt'}</Button><Button disabled={!target || busy} onClick={() => { setSaveName(target); setSaveOpen(true); }}>Save</Button>{busy && <Button onClick={() => { abort.current?.abort(); setBusy(false); setError('Cancelled; the upstream outcome may be unknown'); }}>Cancel</Button>}</div>
          {error && <Alert>{error}</Alert>}
        </Card>
        {result && <Card className="min-w-0 space-y-3 p-4"><div className="flex items-center gap-2"><h2 className="text-[13px] font-semibold">Result</h2>{result.isError && <Badge tone="red">Tool error</Badge>}</div>
          {result.content?.map((content: any, i: number) => <Content key={i} content={content} onRead={uri => { if (tab !== 'resources') linkedUri.current = uri; setTab('resources'); setTarget(uri); }} />)}
          {result.contents?.map((content: any, i: number) => <Content key={i} content={content} />)}
          {result.messages?.map((message: any, i: number) => <div key={i} className="space-y-1"><Badge>{message.role}</Badge><Content content={message.content} /></div>)}
          <details open={!!result.structuredContent}><summary className="cursor-pointer text-xs text-zinc-500">{result.structuredContent ? 'Structured content' : 'Full result'}</summary><JsonView value={result.structuredContent ?? result} /></details>
        </Card>}
      </div>
    </div>
    <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title="Save MCP request"><form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-4"><FormField label="Name"><Input aria-label="Saved request name" value={saveName} onChange={e => setSaveName(e.target.value)} required /></FormField>{error && <Alert>{error}</Alert>}<div className="flex justify-end gap-2"><Button onClick={() => setSaveOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={saving}>Save</Button></div></form></Dialog>
    <Link to="/connections" className="text-xs text-zinc-500 hover:underline">Connections</Link>
  </div>;
}

function Content({ content, onRead }: { content: any; onRead?: (uri: string) => void }) {
  if (content.type === 'resource') return <Content content={content.resource} onRead={onRead} />;
  if (typeof content.text === 'string') return <pre className="whitespace-pre-wrap break-words text-[13px]">{content.text}</pre>;
  if (content.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(content.mimeType)) return <img src={`data:${content.mimeType};base64,${content.data}`} alt="MCP result" className="max-h-80 max-w-full rounded" />;
  if (content.type === 'audio' && /^audio\/(mpeg|mp3|wav|ogg|webm)$/.test(content.mimeType)) return <audio controls src={`data:${content.mimeType};base64,${content.data}`} className="max-w-full" />;
  if (content.type === 'resource_link' && onRead) return <Button size="sm" onClick={() => onRead(content.uri)}>{content.name ?? content.uri}</Button>;
  if (typeof content.blob === 'string') return <BinaryContent content={content} />;
  return <JsonView value={content} />;
}

function BinaryContent({ content }: { content: { blob: string; uri?: string; mimeType?: string } }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    try {
      const data = Uint8Array.from(atob(content.blob), c => c.charCodeAt(0));
      const next = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
      setUrl(next);
      return () => URL.revokeObjectURL(next);
    } catch { setUrl(''); }
  }, [content.blob]);
  return <div className="space-y-2 text-xs">{content.mimeType && <p className="text-zinc-500">{content.mimeType}</p>}{/^image\/(png|jpeg|gif|webp)$/.test(content.mimeType ?? '') && <img src={`data:${content.mimeType};base64,${content.blob}`} alt="Resource preview" className="max-h-80 max-w-full" />}{url && <a href={url} download="resource" className="text-indigo-600 dark:text-indigo-400">Download resource</a>}</div>;
}
