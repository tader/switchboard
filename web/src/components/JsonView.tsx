import { useState } from 'react';
import { cx } from '../lib';

const PAGE = 100;

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-zinc-400">null</span>;
  if (typeof value === 'string') return <span className="break-all text-emerald-700 dark:text-emerald-400">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-violet-700 dark:text-violet-400">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({ name, value, depth, last }: { name?: string; value: unknown; depth: number; last: boolean }) {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';
  const entries = isObject ? (isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as object)) : [];
  const [open, setOpen] = useState(depth < 3 && entries.length <= 200);
  const [limit, setLimit] = useState(PAGE);
  const comma = last ? '' : ',';
  const label = name !== undefined && (
    <>
      <span className="text-zinc-800 dark:text-zinc-200">{JSON.stringify(name)}</span>
      <span className="text-zinc-400">: </span>
    </>
  );

  if (!isObject) {
    return (
      <div className="pl-4">
        {label}
        <Primitive value={value} />
        <span className="text-zinc-400">{comma}</span>
      </div>
    );
  }
  const [o, c] = isArray ? ['[', ']'] : ['{', '}'];
  if (!entries.length) {
    return (
      <div className="pl-4">
        {label}
        <span className="text-zinc-400">
          {o}
          {c}
          {comma}
        </span>
      </div>
    );
  }
  return (
    <div className="pl-4">
      <span className="-ml-4 inline-flex cursor-pointer select-none items-baseline" onClick={() => setOpen(!open)}>
        <span className={cx('inline-block w-4 text-center text-[10px] text-zinc-400 transition-transform', open && 'rotate-90')}>▶</span>
        {label}
        <span className="text-zinc-400">{o}</span>
      </span>
      {open ? (
        <>
          {entries.slice(0, limit).map(([k, v], i) => (
            <Node key={k} name={isArray ? undefined : k} value={v} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          {entries.length > limit && (
            <button type="button" className="pl-4 text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setLimit(limit + PAGE * 5)}>
              Show more ({entries.length - limit})
            </button>
          )}
          <div className="text-zinc-400">
            {c}
            {comma}
          </div>
        </>
      ) : (
        <span className="cursor-pointer text-zinc-400" onClick={() => setOpen(true)}>
          {' '}
          {isArray ? `${entries.length} items` : `${entries.length} keys`} {c}
          {comma}
        </span>
      )}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="-ml-4 font-mono text-[12.5px] leading-relaxed">
      <Node value={value} depth={0} last />
    </div>
  );
}
