import type { Connection } from '../api';
import { cx } from '../lib';
import { Alert, Checkbox } from './ui';

/** Chooses between access to all connections or to selected ones. */
export function AccessPicker({
  connections, limited, setLimited, selected, setSelected,
}: { connections: Connection[]; limited: boolean; setLimited: (v: boolean) => void; selected: string[]; setSelected: (v: string[]) => void }) {
  return (
  <div className="space-y-2">
    <div className="text-[13px] font-medium">Access</div>
    <div className="grid grid-cols-2 gap-2">
      {[
        { v: true, label: 'Selected connections', hint: 'Only use the connections you pick' },
        { v: false, label: 'Everything', hint: 'All connections, and manage your account' },
      ].map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => setLimited(o.v)}
          className={cx(
            'rounded-xl px-3 py-2.5 text-left ring-1 transition',
            limited === o.v ? 'bg-indigo-50/60 ring-2 ring-indigo-500 dark:bg-indigo-500/10 dark:ring-indigo-400' : 'ring-zinc-200 hover:ring-zinc-300 dark:ring-zinc-800',
          )}
        >
          <span className="block text-[13px] font-medium">{o.label}</span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">{o.hint}</span>
        </button>
      ))}
    </div>
    {limited &&
      (connections.length ? (
        <div className="scrollbar-thin max-h-56 overflow-y-auto rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
          {connections.map((c, i) => (
            <label key={c.id} className={cx('flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50', i > 0 && 'border-t border-zinc-100 dark:border-zinc-800')}>
              <Checkbox checked={selected.includes(c.id)} onChange={(v) => setSelected(v ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{c.account?.label ?? c.name}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {c.serviceName} · <code className="font-mono">{c.name}</code>
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <Alert tone="amber">You have no connections yet.</Alert>
      ))}
  </div>
  );
}
