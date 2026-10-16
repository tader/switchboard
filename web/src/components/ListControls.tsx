import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';
import { useSession } from '../auth';
import { matchesSearch, resolveView, sortRows } from '../list-state';
import { Alert, Button, Empty, Input, Select, Spinner } from './ui';

export { matchesSearch };

export function useViewState<T extends Record<string, string>>(page: string, defaults: T, transient: string[] = []) {
  const { user } = useSession();
  const key = `switchboard.view.${user.id}.${page}`;
  const [params, setParams] = useSearchParams();
  const prefix = page === 'activity' ? '' : `${page}.`;
  const viewParams = () => new URLSearchParams([...params].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  const signature = params.toString();
  const previous = useRef(signature);
  const read = () => {
    try {
      const stored = localStorage.getItem(key);
      if (stored) return JSON.parse(stored);
      if (page === 'connections-layout') return { view: localStorage.getItem('switchboard.connections.view') === 'compact' ? 'compact' : 'normal' };
    } catch {}
    return null;
  };
  const [value, setValue] = useState<T>(() => resolveView(defaults, read(), viewParams(), transient));
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    setValue(resolveView(defaults, read(), viewParams(), transient));
  }, [signature]);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(value).filter(([k]) => !transient.includes(k))))); } catch {}
  }, [key, value]);
  const set = (patch: Partial<T>) => {
    const next = { ...value, ...patch };
    // BrowserRouter updates history synchronously; read the latest URL so two scoped resets cannot overwrite each other.
    const url = new URLSearchParams(window.location.search);
    for (const k of Object.keys(defaults)) { if (next[k]) url.set(prefix + k, next[k]); else url.delete(prefix + k); }
    previous.current = url.toString();
    setValue(next); setParams(url, { replace: true });
  };
  return [value, set, () => set(defaults)] as const;
}

export type SortOption = { value: string; label: string };
interface ListController {
  state: Record<string, string>;
  set(patch: Partial<Record<string, string>>): void;
  reset(): void;
  sortBy(field: string): void;
  changed: boolean;
  total: number;
  visible: readonly unknown[];
}
export function useList<T extends { id: string }>(page: string, rows: T[], options: {
  search(row: T): unknown[]; sorts: Record<string, (row: T) => string | number | null | undefined>;
  defaultSort?: string; defaultOrder?: string; filters?: Record<string, string>; filter?(row: T, values: Record<string, string>): boolean;
}) {
  const defaults: Record<string, string> = { q: '', sort: options.defaultSort ?? Object.keys(options.sorts)[0], order: options.defaultOrder ?? 'asc', ...options.filters };
  const [state, setState, reset] = useViewState(page, defaults);
  const sort = Object.hasOwn(options.sorts, state.sort) ? state.sort : defaults.sort;
  const visible = sortRows(rows.filter(row => matchesSearch(state.q, ...options.search(row)) && (!options.filter || options.filter(row, state))), options.sorts[sort], state.order);
  const sortBy = (key: string) => setState({ sort: key, order: sort === key && state.order === 'asc' ? 'desc' : 'asc' });
  return { state: { ...state, sort } as Record<string, string>, set: setState, reset, visible, total: rows.length, sortBy,
    filtered: !!state.q || Object.keys(options.filters ?? {}).some(key => state[key] !== defaults[key]),
    changed: Object.keys(defaults).some(key => state[key] !== defaults[key as keyof typeof defaults]) };
}

export function ListToolbar({ list, label, sorts, children, placeholder }: { list: ListController; label: string; sorts: SortOption[]; children?: ReactNode; placeholder?: string }) {
  return <div className="flex flex-wrap items-center gap-2">
    <div className="relative min-w-44 flex-1 sm:max-w-sm"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" /><Input aria-label={`Search ${label}`} placeholder={placeholder ?? `Search ${label}…`} value={list.state.q} onChange={e => list.set({ q: e.target.value })} className="pl-9" /></div>
    {children}
    <Select aria-label={`Sort ${label}`} value={`${list.state.sort}:${list.state.order}`} onChange={e => { const [sort, order] = e.target.value.split(':'); list.set({ sort, order }); }} className="w-44">
      {sorts.flatMap(option => ['asc', 'desc'].map(order => <option key={`${option.value}:${order}`} value={`${option.value}:${order}`}>{option.label} {order === 'asc' ? '↑' : '↓'}</option>))}
    </Select>
    {list.changed && <Button variant="ghost" size="sm" icon={<X className="size-3.5" />} onClick={list.reset}>Reset</Button>}
    <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-zinc-500" aria-live="polite">{list.visible.length} of {list.total}</span>
  </div>;
}

export function SortHeader({ list, field, children, className }: { list: ListController; field: string; children: ReactNode; className?: string }) {
  const active = list.state.sort === field;
  const Icon = active ? list.state.order === 'desc' ? ArrowDown : ArrowUp : ArrowUpDown;
  return <th scope="col" className={className} aria-sort={active ? list.state.order === 'desc' ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => list.sortBy(field)} className="inline-flex items-center gap-1.5 rounded-sm hover:text-zinc-900 dark:hover:text-zinc-100">{children}<Icon aria-hidden="true" className={`size-3 shrink-0 ${active ? 'text-indigo-500' : 'text-zinc-400'}`} /></button></th>;
}

export function ListFeedback({ loading, error, empty, filtered, label, retry, reset }: { loading?: boolean; error?: Error; empty: boolean; filtered?: boolean; label: string; retry(): void; reset(): void }) {
  if (error) return <Alert>{error.message}<Button size="sm" variant="ghost" className="ml-2" onClick={retry}>Try again</Button></Alert>;
  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (empty) return <Empty title={filtered ? 'No matches' : `No ${label} yet`} action={filtered ? <Button onClick={reset}>Clear filters</Button> : undefined}>{filtered ? 'Try another search or clear the filters.' : undefined}</Empty>;
  return null;
}
