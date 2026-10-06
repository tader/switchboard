import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Connection, OutgoingRequest, PluginContext } from '../../server/plugins/api.ts';

const MAX_BODY = 1024 * 1024;
const HELPER_TIMEOUT_MS = 60_000;

const openapi = {
  openapi: '3.0.3',
  info: { title: 'Apple Reminders', version: '1.0.0', description: 'The reminders and lists belonging to the macOS user running Switchboard.' },
  paths: {
    '/lists': {
      get: { operationId: 'listReminderLists', summary: 'List reminder lists', responses: { 200: { description: 'Reminder lists' } } },
    },
    '/reminders': {
      get: {
        operationId: 'listReminders', summary: 'List reminders',
        parameters: [{ name: 'listId', in: 'query', description: 'Only reminders in this list', schema: { type: 'string' } }],
        responses: { 200: { description: 'Reminders' } },
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
      if (request.method === 'GET' && url.pathname === '/lists') input = { operation: 'lists' };
      else if (request.method === 'GET' && url.pathname === '/reminders') input = { operation: 'list', listId: url.searchParams.get('listId') ?? undefined };
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
      response.end(JSON.stringify(result.body));
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
