import { useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { Field, Pair } from '../api';
import { cx } from '../lib';
import { Checkbox, FormField, Input, SecretInput, Select, Switch, Textarea } from './ui';

export function initialValues(fields: Field[], current: Record<string, any> = {}) {
  const v: Record<string, any> = {};
  for (const f of fields) {
    if (current[f.key] !== undefined) v[f.key] = current[f.key];
    else if (f.default !== undefined) v[f.key] = f.default;
    else v[f.key] = f.type === 'boolean' ? false : '';
  }
  return v;
}

/**
 * Renders plugin-defined fields. `secretsSet` lists secret fields that already have a stored value:
 * they are shown empty, and left empty they keep that value.
 */
export function FieldsForm({
  fields, values, onChange, secretsSet = [], idPrefix = 'f',
}: { fields: Field[]; values: Record<string, any>; onChange: (v: Record<string, any>) => void; secretsSet?: string[]; idPrefix?: string }) {
  const basic = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  const hasAdvancedValue = advanced.some((f) => values[f.key] && values[f.key] !== f.default);
  const [showAdvanced, setShowAdvanced] = useState(hasAdvancedValue);
  const set = (k: string, v: any) => onChange({ ...values, [k]: v });

  const render = (f: Field) => {
    const id = `${idPrefix}-${f.key}`;
    const value = values[f.key] ?? '';
    const keep = f.type === 'secret' && secretsSet.includes(f.key);
    let control;
    switch (f.type) {
      case 'secret':
        control = <SecretInput id={id} value={value} placeholder={keep ? 'Saved — leave empty to keep' : f.placeholder} required={f.required && !keep} onChange={(e) => set(f.key, e.target.value)} />;
        break;
      case 'textarea':
        control = <Textarea id={id} rows={3} value={value} placeholder={f.placeholder} required={f.required} onChange={(e) => set(f.key, e.target.value)} className="font-mono text-[12.5px]" />;
        break;
      case 'select':
        control = (
          <Select id={id} value={value} required={f.required} onChange={(e) => set(f.key, e.target.value)}>
            {!f.required && f.default === undefined && <option value="">—</option>}
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        );
        break;
      case 'boolean':
        return (
          <div key={f.key} className="flex items-start justify-between gap-4">
            <div>
              <label htmlFor={id} className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                {f.label}
              </label>
              {f.description && <p className="text-xs text-zinc-500 dark:text-zinc-400">{f.description}</p>}
            </div>
            <Switch checked={!!value} onChange={(v) => set(f.key, v)} label={f.label} />
          </div>
        );
      default:
        control = (
          <Input
            id={id}
            type={f.type === 'url' ? 'url' : 'text'}
            value={value}
            placeholder={f.placeholder}
            required={f.required}
            spellCheck={false}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
    }
    return (
      <FormField key={f.key} label={f.label} description={f.description} htmlFor={id} optional={!f.required && f.type !== 'select'}>
        {control}
      </FormField>
    );
  };

  return (
    <div className="space-y-4">
      {basic.map(render)}
      {advanced.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-[13px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ChevronRight className={cx('size-4 transition-transform', showAdvanced && 'rotate-90')} />
            Advanced
          </button>
          {showAdvanced && <div className="mt-3 space-y-4 border-l-2 border-zinc-100 pl-4 dark:border-zinc-800">{advanced.map(render)}</div>}
        </div>
      )}
    </div>
  );
}

/** Rows of key/value pairs; an empty row is always kept at the end for typing. */
export function KeyValueEditor({
  pairs, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', suggestions,
}: { pairs: Pair[]; onChange: (p: Pair[]) => void; keyPlaceholder?: string; valuePlaceholder?: string; suggestions?: string[] }) {
  const rows = [...pairs, { key: '', value: '', enabled: true }];
  const listId = suggestions ? `kv-${suggestions.join('').length}-${suggestions.length}` : undefined;
  const update = (i: number, patch: Partial<Pair>) => {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, j) => j < next.length - 1 || r.key || r.value));
  };
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
      {listId && (
        <datalist id={listId}>
          {suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        return (
          <div key={i} className={cx('group flex items-center border-zinc-100 dark:border-zinc-800', i > 0 && 'border-t', r.enabled === false && 'opacity-50')}>
            <div className="flex w-9 justify-center">{!last && <Checkbox checked={r.enabled !== false} onChange={(v) => update(i, { enabled: v })} aria-label="Enabled" />}</div>
            <input
              value={r.key}
              list={listId}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={keyPlaceholder}
              spellCheck={false}
              className="h-9 w-2/5 min-w-0 border-l border-zinc-100 bg-transparent px-3 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-zinc-400 focus:bg-indigo-50/40 dark:border-zinc-800 dark:focus:bg-indigo-500/5"
            />
            <input
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={valuePlaceholder}
              spellCheck={false}
              className="h-9 min-w-0 flex-1 border-l border-zinc-100 bg-transparent px-3 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-zinc-400 focus:bg-indigo-50/40 dark:border-zinc-800 dark:focus:bg-indigo-500/5"
            />
            <div className="flex w-9 justify-center">
              {!last && (
                <button
                  type="button"
                  onClick={() => onChange(rows.filter((_, j) => j !== i && j !== rows.length - 1))}
                  className="rounded p-1 text-zinc-400 opacity-0 hover:text-zinc-700 group-hover:opacity-100 dark:hover:text-zinc-200"
                  aria-label="Remove"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
