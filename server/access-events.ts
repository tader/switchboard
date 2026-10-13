/** Active leases must revalidate authorization when a token/session changes. */
const listeners = new Set<() => void>();
export function onAccessChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function accessChanged() { for (const listener of listeners) listener(); }
