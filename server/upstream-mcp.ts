import { Client, StreamableHTTPClientTransport, InsufficientScopeError, type CompleteRequest, type RequestOptions, type Tool } from '@modelcontextprotocol/client';
import { getConnectionRow, loadConnection, saveCredentials, markError, touch, withLock, resolveBaseUrl } from './connections.ts';
import { onConnectionChange } from './connection-events.ts';
import { allowedHosts, hostAllowed } from './proxy.ts';
import { badRequest, HttpError } from './http.ts';
import { limitResponse, mcpEndpoint, MCP_RESPONSE_LIMIT, MCP_TIMEOUT } from './mcp-network.ts';
import { record, redactBody, type Caller } from './audit.ts';
import type { User } from './users.ts';
import { satelliteConnection, requestSatellite } from './satellites.ts';

export type McpOperation = 'tools/list' | 'tools/call' | 'resources/list' | 'resources/templates/list' | 'resources/read' | 'prompts/list' | 'prompts/get' | 'completion/complete';
export interface McpInput {
  operation: McpOperation;
  name?: string;
  uri?: string;
  arguments?: Record<string, unknown>;
  cursor?: string;
  query?: string;
  ref?: CompleteRequest['params']['ref'];
  argument?: CompleteRequest['params']['argument'];
  context?: CompleteRequest['params']['context'];
}

const OPERATIONS = new Set<McpOperation>(['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete']);
const active = new Map<AbortController, string>();
onConnectionChange(id => { for (const [controller, connectionId] of active) if (!id || connectionId === id) controller.abort(); });
export function stopUpstreamMcp() { for (const controller of active.keys()) controller.abort(); }

export function validateMcpInput(input: McpInput) {
  if (!input || !OPERATIONS.has(input.operation)) throw badRequest('Unknown MCP operation');
  for (const key of ['name', 'uri', 'cursor', 'query'] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 4096)) throw badRequest(`Invalid MCP ${key}`);
  }
  if (['tools/call', 'prompts/get'].includes(input.operation) && !input.name) throw badRequest('MCP name is required');
  if (input.operation === 'resources/read' && !input.uri) throw badRequest('MCP resource URI is required');
  if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) throw badRequest('MCP arguments must be an object');
  if (input.operation === 'prompts/get' && Object.values(input.arguments ?? {}).some(v => typeof v !== 'string')) throw badRequest('Prompt arguments must be strings');
  if (input.operation === 'completion/complete' && (!input.ref || !['ref/prompt', 'ref/resource'].includes(input.ref.type) || typeof (input.ref.type === 'ref/prompt' ? (input.ref as any).name : (input.ref as any).uri) !== 'string' || !input.argument || typeof input.argument.name !== 'string' || typeof input.argument.value !== 'string')) throw badRequest('A completion requires a reference and argument');
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw badRequest('MCP arguments exceeded the size limit');
}

async function executeRemoteMcp(user: User, row: any, input: McpInput, signal?: AbortSignal, caller?: Caller) {
  if (satelliteConnection(user.id, row.satellite_id, row.remote_connection_id).kind !== 'mcp') throw badRequest('This shared connection is not MCP');
  const controller = new AbortController();
  active.set(controller, row.id);
  const started = Date.now();
  const audit = (status: number, outcome: 'success' | 'tool-error' | 'protocol-error' | 'cancelled') => caller && record({
    userId: user.id, caller, connection: { id: row.id, name: row.name, serviceId: row.service_id }, method: 'MCP',
    status, durationMs: Date.now() - started, mcpOperation: input.operation, mcpTarget: input.name ?? input.uri, mcpOutcome: outcome,
    requestBody: redactBody(JSON.stringify(input), 'application/json'), ...(status >= 400 ? { error: `Satellite MCP ${outcome}` } : {}),
  });
  try {
    const result: any = await requestSatellite(row.satellite_id, user.id, 'mcp', { connection: row.remote_connection_id, input, caller }, MCP_TIMEOUT,
      AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
    if (Buffer.byteLength(JSON.stringify(result)) > MCP_RESPONSE_LIMIT) throw new HttpError(502, 'Satellite MCP result exceeded the size limit');
    touch(row.id);
    audit(result?.isError ? 502 : 200, result?.isError ? 'tool-error' : 'success');
    return result;
  } catch (error: any) {
    audit(error.status ?? 502, error.status === 499 ? 'cancelled' : 'protocol-error');
    throw error;
  } finally { active.delete(controller); }
}

/** No shared client/cache: each operation owns its session, auth snapshot and bounded discovery. */
export async function executeMcp(user: User, ref: string, input: McpInput, signal?: AbortSignal, caller?: Caller): Promise<any> {
  validateMcpInput(input);
  const row = getConnectionRow(user.id, ref);
  if (row.kind !== 'mcp') throw badRequest('This connection is an HTTP API; use an HTTP request');
  if (row.satellite_id) return executeRemoteMcp(user, row, input, signal, caller);
  const { conn, service } = loadConnection(user.id, row.id);
  const endpoint = mcpEndpoint(resolveBaseUrl(service, conn));
  const controller = new AbortController();
  const operationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(MCP_TIMEOUT), ...(signal ? [signal] : [])]);
  active.set(controller, conn.id);
  const started = Date.now();
  const budget = { remaining: 8 * MCP_RESPONSE_LIMIT };
  let retried = false;
  let authHeaders: [string, string][] = [];
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { redirect: 'manual' }, onInsufficientScope: 'throw',
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    async fetch(url, init) {
      if (new URL(url).href !== endpoint.href) throw badRequest('The MCP transport changed the endpoint');
      if (init?.method === 'DELETE') {
        const headers = new Headers(init.headers);
        for (const [key, value] of authHeaders) headers.set(key, value);
        return limitResponse(await fetch(endpoint, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(2000) }), budget);
      }
      let attemptedTokens: string | undefined;
      const send = async (force: boolean) => {
        const req = { method: init?.method ?? 'POST', url: new URL(url), headers: new Headers(init?.headers) };
        for (const name of [...req.headers.keys()]) if (/^(cookie|x-hub-.*|x-switchboard-.*)$/i.test(name)) req.headers.delete(name);
        const before = new Headers(req.headers);
        await withLock(conn.id, async () => {
          const fresh = loadConnection(user.id, conn.id);
          if (fresh.service !== service || fresh.conn.kind !== 'mcp' || mcpEndpoint(resolveBaseUrl(fresh.service, fresh.conn)).href !== endpoint.href) {
            throw new HttpError(409, 'The MCP connection changed; run the operation again');
          }
          if (!hostAllowed(req.url.host, allowedHosts(service, fresh.conn))) throw badRequest('The MCP endpoint is not an allowed credential host');
          const currentTokens = JSON.stringify(fresh.conn.credentials?.tokens);
          const result = await fresh.method.authorize(req, fresh.conn, { force: force && currentTokens === attemptedTokens, signal: operationSignal });
          attemptedTokens = JSON.stringify((result?.credentials as any)?.tokens ?? fresh.conn.credentials?.tokens);
          if (!hostAllowed(req.url.host, allowedHosts(service, fresh.conn)) || req.url.href !== endpoint.href) throw badRequest('The plugin changed the MCP endpoint');
          if (result?.credentials !== undefined) saveCredentials(conn.id, result.credentials);
        });
        authHeaders = [...req.headers.entries()].filter(([key, value]) => before.get(key) !== value);
        operationSignal.throwIfAborted();
        const response = await fetch(req.url, { ...init, headers: req.headers, redirect: 'manual', signal: AbortSignal.any([operationSignal, ...(init?.signal ? [init.signal] : [])]) });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw badRequest('MCP redirects are not supported; enter the final endpoint URL');
        }
        return response;
      };
      let response = await send(false);
      // Only a definitive auth rejection is eligible for replay. Network errors and expired sessions are never replayed.
      if (response.status === 401 && conn.methodId === 'oauth') {
        await response.body?.cancel();
        response = await send(true);
        retried = true;
      }
      return limitResponse(response, budget);
    },
  });
  const client = new Client({ name: 'Switchboard', version: '0.1.0' }, {
    capabilities: {}, enforceStrictCapabilities: true, listMaxPages: 16, defaultCacheTtlMs: 0,
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 15_000, maxRetries: 0 } },
    inputRequired: { autoFulfill: false },
  });
  const options: RequestOptions = { signal: operationSignal, timeout: 60_000, maxTotalTimeout: MCP_TIMEOUT };
  const audit = (status: number, error?: string, outcome: 'success' | 'tool-error' | 'protocol-error' | 'auth-error' | 'cancelled' = 'success') => caller && record({
    userId: user.id, caller, connection: { id: conn.id, name: conn.name, serviceId: conn.serviceId },
    method: 'MCP', url: endpoint.href, status, durationMs: Date.now() - started, retried, error,
    requestBody: redactBody(JSON.stringify(input), 'application/json'),
    mcpOperation: input.operation, mcpTarget: input.name ?? input.uri, mcpOutcome: outcome,
  });
  try {
    await client.connect(transport, options);
    const params = input.cursor === undefined ? undefined : { cursor: input.cursor };
    let result: any;
    switch (input.operation) {
      case 'tools/list':
        result = await client.listTools(params, options);
        if (input.query) {
          const q = input.query.toLowerCase();
          result = { ...result, tools: result.tools.filter((t: Tool) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q)) };
        }
        break;
      case 'tools/call': result = await client.callTool({ name: input.name!, arguments: input.arguments }, options); break;
      case 'resources/list': result = await client.listResources(params, options); break;
      case 'resources/templates/list': result = await client.listResourceTemplates(params, options); break;
      case 'resources/read': result = await client.readResource({ uri: input.uri! }, options); break;
      case 'prompts/list': result = await client.listPrompts(params, options); break;
      case 'prompts/get': result = await client.getPrompt({ name: input.name!, arguments: input.arguments as Record<string, string> }, options); break;
      case 'completion/complete': result = await client.complete({ ref: input.ref!, argument: input.argument!, context: input.context }, options); break;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MCP_RESPONSE_LIMIT) throw new HttpError(502, 'MCP result exceeded the size limit');
    touch(conn.id);
    audit(result?.isError ? 502 : 200, result?.isError ? 'The MCP tool reported failure' : undefined, result?.isError ? 'tool-error' : 'success');
    return result;
  } catch (error: any) {
    const cancelled = operationSignal.aborted;
    if (error instanceof InsufficientScopeError && conn.methodId === 'oauth' && error.requiredScope && error.requiredScope.length <= 8192) {
      await withLock(conn.id, async () => {
        const fresh = loadConnection(user.id, conn.id).conn;
        saveCredentials(conn.id, { ...fresh.credentials, requiredScope: error.requiredScope });
      });
    }
    const status = cancelled ? 499 : error instanceof InsufficientScopeError ? 403 : error instanceof HttpError ? error.status : [401, 403].includes(error.data?.status) ? error.data.status : 502;
    const message = cancelled ? 'MCP operation cancelled or timed out; its outcome may be unknown' : error instanceof InsufficientScopeError ? 'Reconnect this MCP connection to grant additional scopes' : error instanceof HttpError ? error.message : `MCP operation failed: ${error.message ?? 'upstream error'}`;
    if (status === 401 || status === 403) markError(conn.id, message);
    audit(status, `MCP ${input.operation} failed${cancelled ? ' (cancelled or timed out)' : ''}`, cancelled ? 'cancelled' : status === 401 || status === 403 ? 'auth-error' : 'protocol-error');
    throw new HttpError(status, message);
  } finally {
    active.delete(controller);
    // Cleanup uses an independent, short timeout even after the caller has cancelled.
    try {
      if (transport.sessionId) await Promise.race([transport.terminateSession(), new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
    } catch {}
    controller.abort();
    await client.close().catch(() => {});
  }
}
