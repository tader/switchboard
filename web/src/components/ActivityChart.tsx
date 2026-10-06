import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ZoomOut } from 'lucide-react';
import { api } from '../api';
import { cx } from '../lib';
import { Spinner } from './ui';

export type Breakdown = 'connection' | 'client' | 'method' | 'status' | 'url';

export const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: 'connection', label: 'Connection' },
  { value: 'client', label: 'Client' },
  { value: 'method', label: 'Method' },
  { value: 'status', label: 'Status' },
  { value: 'url', label: 'URL' },
];

interface Histogram {
  by: Breakdown;
  from: number;
  to: number;
  interval: number;
  series: { key: string; label: string; total: number }[];
  buckets: { t: number; values: Record<string, number> }[];
}

// Status classes keep the reserved status colors, always with their label.
const STATUS: Record<string, { color: string; label: string }> = {
  '2xx': { color: 'var(--status-good)', label: '2xx success' },
  '3xx': { color: 'var(--status-neutral)', label: '3xx redirect' },
  '4xx': { color: 'var(--status-serious)', label: '4xx client error' },
  '5xx': { color: 'var(--status-critical)', label: '5xx server error' },
  failed: { color: 'var(--status-critical)', label: 'Failed' },
};
const SLOTS = 7;

/**
 * Color follows the entity, never its rank: a series keeps its slot while it stays on screen, so
 * zooming or filtering does not repaint the survivors. New series take a slot no visible series uses.
 */
function useSlots(by: Breakdown, keys: string[]) {
  const registry = useRef(new Map<string, Map<string, number>>());
  return useMemo(() => {
    const reg = registry.current.get(by) ?? new Map<string, number>();
    registry.current.set(by, reg);
    const used = new Set<number>();
    const out = new Map<string, number>();
    for (const k of keys) {
      const s = reg.get(k);
      if (s !== undefined && !used.has(s)) {
        out.set(k, s);
        used.add(s);
      }
    }
    for (const k of keys) {
      if (out.has(k)) continue;
      const free = [...Array(SLOTS).keys()].find((s) => !used.has(s))!;
      out.set(k, free);
      used.add(free);
      reg.set(k, free);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, keys.join('\0')]);
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const pad = (n: number) => String(n).padStart(2, '0');
function formatTick(t: number, interval: number, span: number) {
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (interval >= 86400_000) return date;
  return span > 86400_000 && d.getHours() === 0 && d.getMinutes() === 0 ? date : time;
}
function formatRange(t: number, interval: number) {
  const a = new Date(t);
  const b = new Date(t + interval);
  const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (interval >= 86400_000) return interval === 86400_000 ? day(a) : `${day(a)} – ${day(new Date(t + interval - 1))}`;
  return `${day(a)}, ${pad(a.getHours())}:${pad(a.getMinutes())} – ${pad(b.getHours())}:${pad(b.getMinutes())}`;
}
function formatInterval(ms: number) {
  if (ms >= 86400_000) return ms === 86400_000 ? 'per day' : `per ${ms / 86400_000} days`;
  if (ms >= 3600_000) return ms === 3600_000 ? 'per hour' : `per ${ms / 3600_000} hours`;
  return ms === 60_000 ? 'per minute' : `per ${ms / 60_000} minutes`;
}

const H = 190;
const M = { top: 10, right: 8, bottom: 24, left: 40 };

export function ActivityChart({
  query, by, onBy, onZoom, canZoomOut, onZoomOut, onPick, refresh,
}: {
  /** The table's filters (without paging), as a query string. */
  query: string;
  by: Breakdown;
  onBy: (b: Breakdown) => void;
  onZoom: (from: number, to: number) => void;
  canZoomOut: boolean;
  onZoomOut: () => void;
  /** Filter the table by a series. */
  onPick?: (key: string) => void;
  /** Changes to refetch (live mode). */
  refresh: number;
}) {
  const [data, setData] = useState<Histogram | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ i: number; key?: string } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api<Histogram>(`/audit/histogram?${query}&by=${by}&tz=${new Date().getTimezoneOffset()}`)
      .then((d) => !stale && (setData(d), setError('')))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [query, by, refresh]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const keys = useMemo(() => (data?.series ?? []).map((s) => s.key).filter((k) => k !== '__other'), [data]);
  const slots = useSlots(by, keys);
  const colorOf = (key: string) => (by === 'status' ? STATUS[key]?.color ?? 'var(--status-neutral)' : key === '__other' ? 'var(--series-other)' : `var(--series-${(slots.get(key) ?? 0) + 1})`);
  const labelOf = (s: { key: string; label: string }) => (by === 'status' ? STATUS[s.key]?.label ?? s.label : s.label);

  // Geometry
  const g = useMemo(() => {
    if (!data) return null;
    const n = Math.max(1, Math.ceil((data.to - data.from) / data.interval));
    const innerW = width - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const band = innerW / n;
    const barW = Math.max(1, Math.min(24, band * 0.72));
    const byT = new Map(data.buckets.map((b) => [b.t, b.values]));
    const columns = [...Array(n).keys()].map((i) => {
      const t = data.from + i * data.interval;
      const values = byT.get(t) ?? {};
      const total = Object.values(values).reduce((a, b) => a + b, 0);
      return { i, t, values, total };
    });
    const max = niceMax(Math.max(1, ...columns.map((c) => c.total)));
    const y = (v: number) => (v / max) * innerH;
    const xOf = (i: number) => M.left + i * band;
    const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((v) => Number.isInteger(v) || max <= 4);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 90))));
    return { n, innerW, innerH, band, barW, columns, max, y, xOf, ticks, every };
  }, [data, width]);

  const indexAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const x = clientX - rect.left - M.left;
    return Math.min(g!.n - 1, Math.max(0, Math.floor(x / g!.band)));
  };

  // Drag across columns to zoom in; a click on one column zooms to it.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!g || e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const i = indexAt(e.clientX);
    setDrag({ x0: i, x1: i });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!g) return;
    const i = indexAt(e.clientX);
    if (drag) setDrag({ ...drag, x1: i });
    else setHover((h) => (h?.i === i ? h : { i }));
  };
  const onPointerUp = () => {
    if (!g || !drag || !data) return;
    const a = Math.min(drag.x0, drag.x1);
    const b = Math.max(drag.x0, drag.x1);
    setDrag(null);
    if (a === b && !g.columns[a].total) return;
    onZoom(data.from + a * data.interval, Math.min(data.to, data.from + (b + 1) * data.interval) - 1);
  };

  const total = data?.series.reduce((n, s) => n + s.total, 0) ?? 0;
  const hovered = hover && g ? g.columns[hover.i] : null;
  // Beside the hovered column, never over it: to the right, or to the left near the edge.
  const TIP = 224;
  const tipLeft = hovered && g ? (g.xOf(hovered.i) + g.band + 12 + TIP <= width ? g.xOf(hovered.i) + g.band + 12 : Math.max(4, g.xOf(hovered.i) - 12 - TIP)) : 0;

  return (
    <div className="mb-4 rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold">Requests over time</span>
          {data && (
            <span className="ml-2 text-xs text-zinc-500">
              {total.toLocaleString()} · {formatInterval(data.interval)}
            </span>
          )}
        </div>
        {canZoomOut && (
          <button type="button" onClick={onZoomOut} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
            <ZoomOut className="size-3.5" /> Zoom out
          </button>
        )}
        <div role="radiogroup" aria-label="Break down by" className="flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {BREAKDOWNS.map((b) => (
            <button
              key={b.value}
              type="button"
              role="radio"
              aria-checked={by === b.value}
              onClick={() => onBy(b.value)}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                by === b.value ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-700 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={box} className={cx('relative select-none px-0 pt-2 transition-opacity', loading && data && 'opacity-60')} style={{ height: H + 8 }}>
        {!data || !g ? (
          <div className="flex h-full items-center justify-center">{error ? <span className="text-xs text-rose-600">{error}</span> : <Spinner />}</div>
        ) : (
          <>
            <svg
              width={width}
              height={H}
              className="block cursor-crosshair touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => !drag && setHover(null)}
              role="img"
              aria-label={`Requests over time, broken down by ${by}. ${total} requests.`}
            >
              {/* grid and y ticks */}
              {g.ticks.map((v) => {
                const yy = M.top + g.innerH - g.y(v);
                return (
                  <g key={v}>
                    <line x1={M.left} x2={width - M.right} y1={yy} y2={yy} stroke={v === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
                    <text x={M.left - 8} y={yy} dy="0.32em" textAnchor="end" className="fill-[var(--chart-muted)] text-[10.5px] tabular-nums">
                      {v.toLocaleString()}
                    </text>
                  </g>
                );
              })}
              {/* drag selection */}
              {drag && (
                <rect
                  x={g.xOf(Math.min(drag.x0, drag.x1))}
                  y={M.top}
                  width={(Math.abs(drag.x1 - drag.x0) + 1) * g.band}
                  height={g.innerH}
                  className="fill-indigo-500/10 stroke-indigo-500/40"
                  strokeWidth={1}
                />
              )}
              {/* hovered column wash */}
              {hover && !drag && <rect x={g.xOf(hover.i)} y={M.top} width={g.band} height={g.innerH} className="fill-zinc-500/[0.06]" />}
              {/* stacked columns: 2px surface gap between segments, 4px rounded data-end, square at the baseline */}
              {g.columns.map((c) => {
                if (!c.total) return null;
                const x = g.xOf(c.i) + (g.band - g.barW) / 2;
                let acc = 0;
                const order = data.series.filter((s) => c.values[s.key]);
                return (
                  <g key={c.i} opacity={hovered?.total && !drag && hover!.i !== c.i ? 0.5 : 1}>
                    {order.map((s, j) => {
                      const v = c.values[s.key];
                      const h = g.y(v);
                      const y0 = M.top + g.innerH - g.y(acc) - h;
                      acc += v;
                      const top = j === order.length - 1;
                      const gap = !top && h > 3 ? 2 : 0;
                      const hh = Math.max(0.75, h - gap);
                      const yy = y0 + gap;
                      const r = top ? Math.min(4, g.barW / 2, hh) : 0;
                      const d = `M${x},${yy + hh}V${yy + r}${r ? `Q${x},${yy} ${x + r},${yy}` : ''}H${x + g.barW - r}${r ? `Q${x + g.barW},${yy} ${x + g.barW},${yy + r}` : ''}V${yy + hh}Z`;
                      return <path key={s.key} d={d} fill={colorOf(s.key)} />;
                    })}
                  </g>
                );
              })}
              {/* x ticks */}
              {g.columns
                .filter((c) => c.i % g.every === 0)
                .map((c) => (
                  <text key={c.i} x={g.xOf(c.i) + g.band / 2} y={H - 6} textAnchor="middle" className="fill-[var(--chart-muted)] text-[10.5px] tabular-nums">
                    {formatTick(c.t, data.interval, data.to - data.from)}
                  </text>
                ))}
            </svg>

            {/* One tooltip, every series in the column; values lead. */}
            {hovered && !drag && (
              <div
                className="pointer-events-none absolute top-1 z-10 w-56 rounded-lg bg-white px-3 py-2 text-[12px] shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700"
                style={{ left: tipLeft }}
              >
                <div className="mb-1.5 text-[11px] text-zinc-500">{formatRange(hovered.t, data.interval)}</div>
                {hovered.total ? (
                  <>
                    {data.series
                      .filter((s) => hovered.values[s.key])
                      .reverse()
                      .map((s) => (
                        <div key={s.key} className="flex items-center gap-2 py-px">
                          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: colorOf(s.key) }} />
                          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{hovered.values[s.key].toLocaleString()}</span>
                          <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{labelOf(s)}</span>
                        </div>
                      ))}
                    <div className="mt-1.5 flex justify-between border-t border-zinc-100 pt-1.5 text-zinc-500 dark:border-zinc-700">
                      <span>Total</span>
                      <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{hovered.total.toLocaleString()}</span>
                    </div>
                    <div className="mt-1 text-[10.5px] text-zinc-400">Click to zoom in, or drag across columns</div>
                  </>
                ) : (
                  <div className="text-zinc-400">No requests</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Legend: always present for two or more series; the total carries the value. */}
      {data && data.series.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-zinc-100 px-4 py-2.5 text-[12px] dark:border-zinc-800">
          {[...data.series].map((s) => {
            const pickable = onPick && s.key !== '__other' && by !== 'url';
            const content = (
              <>
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(s.key) }} />
                <span className={cx('truncate text-zinc-700 dark:text-zinc-300', by === 'url' || by === 'connection' ? 'max-w-64 font-mono text-[11.5px]' : 'max-w-56')} title={labelOf(s)}>
                  {labelOf(s)}
                </span>
                <span className="tabular-nums text-zinc-400">{s.total.toLocaleString()}</span>
              </>
            );
            return pickable ? (
              <button key={s.key} type="button" onClick={() => onPick!(s.key)} title={`Show only ${labelOf(s)}`} className="flex items-center gap-1.5 rounded hover:underline">
                {content}
              </button>
            ) : (
              <span key={s.key} className="flex items-center gap-1.5" title={s.key === '__other' ? 'Smaller series, combined' : undefined}>
                {content}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
