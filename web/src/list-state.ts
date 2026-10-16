/** Explicit view links start from defaults, so unrelated remembered filters cannot hide their target. */
export function resolveView<T extends Record<string, string>>(defaults: T, stored: unknown, params: URLSearchParams, transient: string[] = []): T {
  const keys = Object.keys(defaults);
  const explicit = keys.some(key => params.has(key));
  const result = { ...defaults };
  for (const key of keys as (keyof T & string)[]) {
    const value = explicit ? params.get(key) : !transient.includes(key) && stored && typeof stored === 'object' ? (stored as Record<string, unknown>)[key] : undefined;
    if (typeof value === 'string') result[key] = value as T[typeof key];
  }
  return result;
}

export function sortRows<T extends { id: string }>(rows: T[], value: (row: T) => string | number | null | undefined, order: string): T[] {
  return [...rows].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null && bv == null ? a.id.localeCompare(b.id) : av == null ? 1 : -1;
    const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return (order === 'desc' ? -comparison : comparison) || a.id.localeCompare(b.id);
  });
}

export function matchesSearch(query: string, ...values: unknown[]) {
  const text = values.filter(value => value != null).join(' ').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}
