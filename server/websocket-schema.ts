import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { WebSocketCapability, WebSocketOperation } from './plugins/api.ts';
import { badRequest, HttpError } from './http.ts';

export const WS_LIMITS = Object.freeze({ openMs: 30_000, commandMs: 60_000, maxTimeoutMs: 120_000,
  arguments: 256 * 1024, event: 256 * 1024, message: 1024 * 1024, page: 512 * 1024,
  leaseMs: 300_000, idleMs: 60_000, cleanupMs: 5000, events: 1000, buffer: 1024 * 1024,
  principal: 8, user: 16, instance: 64, sweepMs: 5000 });
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false, addUsedSchema: false });
const validators = new WeakMap<WebSocketOperation, { input: ValidateFunction; output?: ValidateFunction; event?: ValidateFunction }>();

export function validateWebSocketCapability(capability: WebSocketCapability) {
  if (!capability || !['string', 'function'].includes(typeof capability.endpoint) || typeof capability.createSession !== 'function' || !Array.isArray(capability.operations) || capability.operations.length > 1000) throw new Error('Invalid WebSocket capability');
  if (capability.proxy !== undefined && typeof capability.proxy !== 'boolean') throw new Error('Invalid WebSocket proxy capability');
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const op of capability.operations) {
    if (!op || typeof op.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(op.id) || ids.has(op.id) || typeof op.title !== 'string' || !op.title || !['command', 'subscription'].includes(op.mode)) throw new Error('Invalid or duplicate WebSocket operation');
    ids.add(op.id);
    if (op.rest) {
      const key = `${op.rest.method} ${op.rest.path}`;
      if (op.mode !== 'command' || !['GET', 'POST', 'PUT'].includes(op.rest.method) || !/^\/[a-z0-9][a-z0-9/-]*$/.test(op.rest.path) || routes.has(key) || (op.rest.method === 'GET' && op.readOnlyHint !== true)) throw new Error('Invalid WebSocket REST binding');
      routes.add(key);
    }
    if (!op.inputSchema || op.inputSchema.type !== 'object') throw new Error(`WebSocket ${op.id} needs an object input schema`);
    if (Buffer.byteLength(JSON.stringify(op)) > WS_LIMITS.arguments) throw new Error('WebSocket metadata exceeded size limit');
    validators.set(op, { input: ajv.compile(op.inputSchema), output: op.outputSchema ? ajv.compile(op.outputSchema) : undefined, event: op.eventSchema ? ajv.compile(op.eventSchema) : undefined });
  }
}
export function jsonSize(value: unknown, limit: number): number {
  let raw: string | undefined;
  try { raw = JSON.stringify(value); } catch { throw badRequest('WebSocket values must be JSON serializable'); }
  if (raw === undefined) throw badRequest('WebSocket values must be JSON serializable');
  const size = Buffer.byteLength(raw);
  if (size > limit) throw new HttpError(413, 'WebSocket value exceeded the size limit');
  return size;
}
export function validateWebSocketValue(op: WebSocketOperation, kind: 'input' | 'output' | 'event', value: unknown) {
  if (!validators.has(op)) validateWebSocketCapability({ endpoint: '', operations: [op], createSession: () => { throw new Error(); } });
  const check = validators.get(op)![kind];
  if (kind === 'input' && (!value || typeof value !== 'object' || Array.isArray(value))) throw badRequest('WebSocket arguments must be an object');
  jsonSize(value, kind === 'input' ? WS_LIMITS.arguments : kind === 'event' ? WS_LIMITS.event : WS_LIMITS.message);
  if (check && !check(value)) throw new HttpError(kind === 'input' ? 400 : 502, `Invalid WebSocket ${kind}: ${ajv.errorsText(check.errors)}`);
}
