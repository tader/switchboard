import { AsyncLocalStorage } from 'node:async_hooks';
import { randomId } from './crypto.ts';
import { one, run } from './db.ts';
import { HttpError } from './http.ts';

export const SATELLITE_PROTOCOL = 2;
export const SATELLITE_MAX_MESSAGE = 2 * 1024 * 1024;
export const SATELLITE_OPERATIONS = new Set(['call', 'mcp', 'openapi']);
export const MAX_SATELLITE_HOPS = 8;
export interface SatelliteRoute { path: string[]; deadline: number }
export const satelliteRoute = new AsyncLocalStorage<SatelliteRoute>();
export function instanceId(): string {
  let id = one('SELECT value FROM instance_settings WHERE key = ?', 'instance-id')?.value;
  if (!id) { id = randomId('instance'); run('INSERT INTO instance_settings (key, value) VALUES (?, ?)', 'instance-id', id); }
  return id;
}
export function acceptRoute(path: unknown, deadline: unknown): SatelliteRoute {
  if (!Array.isArray(path) || path.length < 1 || path.length > MAX_SATELLITE_HOPS || path.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(path).size !== path.length || path.includes(instanceId())) {
    throw new HttpError(508, 'Satellite route contains a loop or exceeds eight hops');
  }
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now()) throw new HttpError(504, 'Satellite request deadline expired');
  return { path, deadline: Math.min(deadline, Date.now() + 120_000) };
}
export function forwardingRoute(timeoutMs: number): SatelliteRoute {
  const previous = satelliteRoute.getStore();
  const path = [...(previous?.path ?? []), instanceId()];
  if (path.length > MAX_SATELLITE_HOPS || new Set(path).size !== path.length) throw new HttpError(508, 'Satellite route contains a loop or exceeds eight hops');
  return { path, deadline: Math.min(previous?.deadline ?? Infinity, Date.now() + Math.min(Math.max(timeoutMs, 1), 120_000)) };
}
