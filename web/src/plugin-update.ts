import type { PluginInfo, PluginPlan } from './api.js';

const key = 'switchboard.plugin-updates.remembered.v1';
export function remembersUpdates(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try { return storage.getItem(key) === 'yes'; } catch { return false; }
}
export function rememberUpdates(enabled: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try { if (enabled) storage.setItem(key, 'yes'); else storage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

/** Prepare a coordinated update for review using each plugin's saved access. */
export async function planWithRememberedAccess(
  plugins: PluginInfo[],
  request: (path: string, options: { body: unknown }) => Promise<PluginPlan>,
): Promise<PluginPlan> {
  return request('/admin/plugins/update/plan', { body: { updates: plugins.map(p => ({ id: p.id })) } });
}
