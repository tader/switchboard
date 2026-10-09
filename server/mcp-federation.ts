import { listConnections, getConnectionRow } from './connections.ts';
import { badRequest, forbidden } from './http.ts';
import { executeMcp, type McpInput } from './provider-mcp.ts';
import type { User, ApiToken } from './users.ts';
import type { Caller } from './audit.ts';

export interface FederationContext { user: User; token: ApiToken; signal?: AbortSignal; caller: Caller }

export function namespaceUri(id: string, uri: string) { return `switchboard-mcp:${id}:${uri}`; }
export function namespacePrompt(id: string, name: string) { return `${id}:${name}`; }

function unpack(value: unknown, resource: boolean) {
  if (typeof value !== 'string') throw badRequest('A namespaced MCP target is required');
  const raw = resource ? value.replace(/^switchboard-mcp:/, '') : value;
  if (resource && raw === value) throw badRequest('The resource URI must start with switchboard-mcp:');
  const colon = raw.indexOf(':');
  if (colon < 1 || !raw.slice(colon + 1)) throw badRequest('Invalid namespaced MCP target');
  return { id: raw.slice(0, colon), target: raw.slice(colon + 1) };
}

function permitted(ctx: FederationContext, id: string) {
  const row = getConnectionRow(ctx.user.id, id);
  if (row.id !== id || (ctx.token.connectionIds && !ctx.token.connectionIds.includes(id))) throw forbidden('This client cannot use that MCP connection');
  return row;
}

/** Only protocol resource links are rewritten; structured application data stays byte-for-byte compatible. */
export function namespaceResult(result: any, id: string): any {
  const content = (item: any): any => item.type === 'resource_link' ? { ...item, uri: namespaceUri(id, item.uri) }
    : item.type === 'resource' ? { ...item, resource: { ...item.resource, uri: namespaceUri(id, item.resource.uri) } } : item;
  return { ...result,
    ...(result.ttlMs !== undefined ? { ttlMs: 0, cacheScope: 'private' } : {}),
    ...(result.content ? { content: result.content.map(content) } : {}),
    ...(result.contents ? { contents: result.contents.map((item: any) => ({ ...item, uri: namespaceUri(id, item.uri) })) } : {}),
    ...(result.messages ? { messages: result.messages.map((item: any) => ({ ...item, content: content(item.content) })) } : {}),
  };
}

/** One upstream page per response. Cursors bind to immutable IDs and are checked against current access. */
export async function federatedList(ctx: FederationContext, operation: 'resources/list' | 'resources/templates/list' | 'prompts/list', cursor?: unknown) {
  const connections = listConnections(ctx.user.id, ctx.token.connectionIds).filter(c => c.kind === 'mcp' && c.status !== 'unavailable').sort((a, b) => a.id.localeCompare(b.id));
  const key = operation === 'resources/list' ? 'resources' : operation === 'resources/templates/list' ? 'resourceTemplates' : 'prompts';
  let index = 0;
  let upstreamCursor = '';
  if (cursor !== undefined && cursor !== '') {
    if (typeof cursor !== 'string' || cursor.length > 8192) throw badRequest('Invalid MCP cursor');
    let decoded: any;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw badRequest('Invalid MCP cursor'); }
    if (decoded.operation !== operation || typeof decoded.connection !== 'string' || typeof decoded.cursor !== 'string') throw badRequest('Invalid MCP cursor');
    index = connections.findIndex(c => c.id === decoded.connection);
    if (index < 0) throw badRequest('The connection for this cursor is no longer available');
    upstreamCursor = decoded.cursor;
  }
  const encode = (connection: string, next: string) => Buffer.from(JSON.stringify({ operation, connection, cursor: next })).toString('base64url');
  for (let checked = 0; index < connections.length && checked < 32; checked++, index++) {
    const conn = connections[index];
    let result: any;
    try { result = await executeMcp(ctx.user, conn.id, { operation, cursor: upstreamCursor }, ctx.signal, ctx.caller); }
    catch (error: any) {
      if (/Server does not support/.test(error.message)) { upstreamCursor = ''; continue; }
      throw error;
    }
    const nextCursor = result.nextCursor ? encode(conn.id, result.nextCursor) : connections[index + 1] ? encode(connections[index + 1].id, '') : undefined;
    return { [key]: result[key].map((item: any) => ({ ...item,
      name: operation === 'prompts/list' ? namespacePrompt(conn.id, item.name) : item.name,
      ...(item.uri ? { uri: namespaceUri(conn.id, item.uri) } : {}),
      ...(item.uriTemplate ? { uriTemplate: namespaceUri(conn.id, item.uriTemplate) } : {}),
    })), ...(nextCursor ? { nextCursor } : {}), ttlMs: 0, cacheScope: 'private' };
  }
  return { [key]: [], ...(connections[index] ? { nextCursor: encode(connections[index].id, '') } : {}), ttlMs: 0, cacheScope: 'private' };
}

export async function federatedRequest(ctx: FederationContext, operation: 'resources/read' | 'prompts/get' | 'completion/complete', params: any) {
  const resource = operation === 'resources/read' || (operation === 'completion/complete' && params.ref?.type === 'ref/resource');
  const parsed = unpack(operation === 'completion/complete' ? resource ? params.ref?.uri : params.ref?.name : resource ? params.uri : params.name, resource);
  permitted(ctx, parsed.id);
  const input: McpInput = operation === 'completion/complete'
    ? { operation, ref: resource ? { type: 'ref/resource', uri: parsed.target } : { type: 'ref/prompt', name: parsed.target }, argument: params.argument, context: params.context }
    : { operation, ...(resource ? { uri: parsed.target } : { name: parsed.target, arguments: params.arguments }) };
  return namespaceResult(await executeMcp(ctx.user, parsed.id, input, ctx.signal, ctx.caller), parsed.id);
}
