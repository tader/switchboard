import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Connection, OutgoingRequest, PluginContext } from '../../server/plugins/api.ts';

const MAX_BODY = 1024 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const MAX_PAGE_SIZE = 100;
const dateFilters = ['dueDateLt', 'dueDateLte', 'dueDateGt', 'dueDateGte', 'completionDateLt', 'completionDateLte', 'completionDateGt', 'completionDateGte'] as const;

export function pagination(url: URL) {
  const rawSize = url.searchParams.get('pageSize');
  const limit = rawSize === null ? MAX_PAGE_SIZE : Number(rawSize);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  const filters = new URLSearchParams(url.searchParams);
  filters.delete('pageSize');
  filters.delete('nextToken');
  filters.sort();
  const fingerprint = crypto.createHash('sha256').update(filters.toString()).digest('base64url').slice(0, 16);
  let offset = 0;
  const token = url.searchParams.get('nextToken');
  if (token) {
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.fingerprint !== fingerprint) throw new Error();
      offset = decoded.offset;
    } catch {
      throw new Error('nextToken is invalid or belongs to a different query');
    }
  }
  return { limit, offset, fingerprint };
}

export function pageResult(body: any, fingerprint: string) {
  if (!body || !Array.isArray(body.items)) throw new Error('Invalid paginated response from EventKit helper');
  const result: { items: unknown[]; nextToken?: string } = { items: body.items };
  if (Number.isInteger(body.nextOffset)) {
    result.nextToken = Buffer.from(JSON.stringify({ offset: body.nextOffset, fingerprint })).toString('base64url');
  }
  return result;
}

export function reminderFilters(url: URL) {
  const input: Record<string, unknown> = { listId: url.searchParams.get('listId') ?? undefined };
  const hideCompleted = url.searchParams.get('hideCompleted');
  if (hideCompleted !== null) {
    if (hideCompleted !== 'true' && hideCompleted !== 'false') throw new Error('hideCompleted must be true or false');
    input.hideCompleted = hideCompleted === 'true';
  }
  const due = url.searchParams.get('due');
  if (due && !['overdue', 'today', 'tomorrow', 'next7Days'].includes(due)) throw new Error('due must be overdue, today, tomorrow, or next7Days');
  if (due) input.due = due;
  for (const name of dateFilters) {
    const value = url.searchParams.get(name);
    if (value !== null) input[name] = value;
  }
  return input;
}

const openapi = {
  openapi: '3.0.3',
  info: { title: 'Apple Reminders', version: '1.0.0', description: 'The reminders and lists belonging to the macOS user running Switchboard.' },
  paths: {
    '/lists': {
      get: {
        operationId: 'listReminderLists', summary: 'List reminder lists',
        parameters: [
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } },
          { name: 'nextToken', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'A page of reminder lists' } },
      },
    },
    '/reminders': {
      get: {
        operationId: 'listReminders', summary: 'List reminders',
        parameters: [
          { name: 'listId', in: 'query', description: 'Only reminders in this list', schema: { type: 'string' } },
          { name: 'hideCompleted', in: 'query', description: 'Hide completed reminders; false by default', schema: { type: 'boolean', default: false } },
          { name: 'due', in: 'query', description: 'Convenient local-time due-date window; overdue also excludes completed reminders', schema: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'next7Days'] } },
          ...dateFilters.map((name) => ({ name, in: 'query', description: `${name.replace(/(Lt|Lte|Gt|Gte)$/, '')} comparison as an ISO 8601 date-time`, schema: { type: 'string', format: 'date-time' } })),
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } },
          { name: 'nextToken', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'A page of reminders' } },
      },
      post: {
        operationId: 'createReminder', summary: 'Create a reminder',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReminderInput' } } } },
        responses: { 201: { description: 'Created reminder' } },
      },
    },
    '/reminders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, description: 'EventKit reminder identifier', schema: { type: 'string' } }],
      get: { operationId: 'getReminder', summary: 'Get a reminder', responses: { 200: { description: 'Reminder' } } },
      patch: {
        operationId: 'updateReminder', summary: 'Update a reminder',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReminderInput' } } } },
        responses: { 200: { description: 'Updated reminder' } },
      },
      delete: { operationId: 'deleteReminder', summary: 'Delete a reminder', responses: { 200: { description: 'Deletion result' } } },
    },
  },
  components: {
    schemas: {
      ReminderInput: {
        type: 'object',
        properties: {
          title: { type: 'string' }, notes: { type: 'string', nullable: true, description: 'Set to null to clear' }, listId: { type: 'string' },
          dueDate: { type: 'string', nullable: true, format: 'date-time', description: 'Set to null to clear' }, completed: { type: 'boolean' },
          priority: { type: 'integer', description: 'EventKit priority: 0 none, 1 high, 5 medium, 9 low', enum: [0, 1, 5, 9] },
        },
      },
    },
  },
};

async function buildHelper(ctx: PluginContext) {
  await fs.mkdir(ctx.dataDir, { recursive: true });
  const helper = path.join(ctx.dataDir, 'apple-reminders-helper');
  const source = path.join(ctx.dir, 'helper.swift');
  const plist = path.join(ctx.dir, 'Info.plist');
  const stamp = path.join(ctx.dataDir, 'helper-version');
  const version = crypto.createHash('sha256').update(await fs.readFile(source)).update(await fs.readFile(plist)).digest('hex');
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === version && await fs.access(helper).then(() => true, () => false)) return helper;
  const temporary = `${helper}.${process.pid}.tmp`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('swiftc', [source, '-o', temporary, '-framework', 'Foundation', '-framework', 'EventKit', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => error += chunk);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `swiftc exited with status ${code}`)));
  });
  await fs.rename(temporary, helper);
  await fs.writeFile(stamp, version, { mode: 0o600 });
  return helper;
}

function runHelper(helper: string, input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('EventKit helper timed out'));
    }, HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || `EventKit helper exited with status ${code}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid response from EventKit helper${stderr ? `: ${stderr.trim()}` : ''}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function jsonBody(request: http.IncomingMessage) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('Request body is too large');
  }
  if (!body) return {};
  const value = JSON.parse(body);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Request body must be a JSON object');
  return value as Record<string, unknown>;
}

export default async function setup(ctx: PluginContext) {
  if (process.platform !== 'darwin') return {};

  let helper: string | undefined;
  let buildError: string | undefined;
  try {
    helper = await buildHelper(ctx);
  } catch (error: any) {
    buildError = `Could not build the EventKit helper: ${error.message}`;
    ctx.log.warn(buildError);
  }
  const tokens = new Set<string>();
  const server = http.createServer(async (request, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokens.has(token)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid Apple Reminders connection' }));
      return;
    }
    try {
      if (!helper) throw new Error(buildError ?? 'EventKit helper is unavailable');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = url.pathname.match(/^\/reminders\/([^/]+)$/);
      let input: Record<string, unknown>;
      let pageFingerprint: string | undefined;
      if (request.method === 'GET' && url.pathname === '/lists') {
        const page = pagination(url);
        pageFingerprint = page.fingerprint;
        input = { operation: 'lists', offset: page.offset, limit: page.limit };
      }
      else if (request.method === 'GET' && url.pathname === '/reminders') {
        const page = pagination(url);
        pageFingerprint = page.fingerprint;
        input = { operation: 'list', ...reminderFilters(url), offset: page.offset, limit: page.limit };
      }
      else if (request.method === 'POST' && url.pathname === '/reminders') input = { ...await jsonBody(request), operation: 'create' };
      else if (request.method === 'GET' && match) input = { operation: 'get', id: decodeURIComponent(match[1]) };
      else if (request.method === 'PATCH' && match) input = { ...await jsonBody(request), operation: 'update', id: decodeURIComponent(match[1]) };
      else if (request.method === 'DELETE' && match) input = { operation: 'delete', id: decodeURIComponent(match[1]) };
      else {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const result = await runHelper(helper, input);
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(pageFingerprint && result.status === 200 ? pageResult(result.body, pageFingerprint) : result.body));
    } catch (error: any) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the Apple Reminders adapter');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    services: [{
      id: 'apple-reminders',
      name: 'Apple Reminders',
      description: 'Lists and reminders from this Mac',
      icon: 'icon.svg',
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      openapi,
      authMethods: [{
        id: 'eventkit',
        name: 'This Mac',
        description: 'Uses the reminders of the macOS user running Switchboard',
        unavailable: buildError,
        async connect() {
          if (!helper) throw new Error(buildError ?? 'EventKit helper is unavailable');
          const result = await runHelper(helper, { operation: 'authorize' });
          if (result.status !== 200) throw new Error((result.body as any)?.error ?? 'Reminders access was not granted');
          const token = crypto.randomBytes(32).toString('base64url');
          tokens.add(token);
          return { credentials: { token }, account: { id: 'local', label: 'Reminders on this Mac' } };
        },
        authorize(request: OutgoingRequest, connection: Connection) {
          tokens.add(String(connection.credentials.token));
          request.headers.set('authorization', `Bearer ${connection.credentials.token}`);
        },
        revoke(connection: Connection) {
          tokens.delete(String(connection.credentials.token));
          return Promise.resolve();
        },
      }],
    }],
    dispose: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
