import { config } from './config.ts';

// OpenAPI description of Switchboard's own API, served at /api/openapi.json. Switchboards connected to this
// one use it for their console's API reference.

const ref = { name: 'ref', in: 'path', required: true, description: 'Connection id or name', schema: { type: 'string' } };
const id = (description: string) => ({ name: 'id', in: 'path', required: true, description, schema: { type: 'string' } });
const json = (schema: object, example?: unknown) => ({ required: true, content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const ok = { '200': { description: 'OK' } };
const pairs = { description: 'Array of {key, value, enabled?} or an object', oneOf: [{ type: 'array', items: { type: 'object' } }, { type: 'object' }] };

const call = {
  type: 'object',
  required: ['connection'],
  properties: {
    connection: { type: 'string', description: 'Connection id or name' },
    method: { type: 'string', default: 'GET' },
    url: { type: 'string', description: 'Relative to the service base URL, or absolute on an allowed host. May contain {placeholders}.' },
    pathParams: { type: 'object', additionalProperties: { type: 'string' } },
    query: pairs,
    headers: pairs,
    body: { description: 'String, or JSON (sent as application/json)' },
    bodyEncoding: { type: 'string', enum: ['utf8', 'base64'] },
  },
};

const saved = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Unique per user; saved calls run by name or id' },
    connectionId: { type: 'string' },
    method: { type: 'string', default: 'GET' },
    url: { type: 'string', description: 'Like the call API: relative or absolute, may contain {placeholders}' },
    pathParams: { type: 'object', description: 'Values for the placeholders' },
    query: { type: 'array', items: { type: 'object' }, description: 'Array of {key, value, enabled}' },
    headers: { type: 'array', items: { type: 'object' }, description: 'Array of {key, value, enabled}' },
    body: { type: 'string' },
  },
};

export function openapiDocument() {
  const op = (tag: string, summary: string, extra: object = {}) => ({ tags: [tag], summary, responses: ok, ...extra });
  return {
    openapi: '3.0.3',
    info: { title: 'Switchboard', version: '1', description: 'Authenticate with `Authorization: Bearer swb_…`.' },
    servers: [{ url: config.publicUrl }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
    security: [{ token: [] }],
    paths: {
      '/api/me': { get: op('Account', 'Who the token belongs to') },
      '/api/me/token': { delete: op('Account', 'Revoke the token making this request') },
      '/api/services': { get: op('Connections', 'Services and their sign-in methods') },
      '/api/connections': {
        get: op('Connections', 'List connections'),
        post: op('Connections', 'Connect an account', {
          description: 'Returns status "connected", "redirect" (open url in a browser) or "device" (show the code, then poll).',
          requestBody: json(
            {
              type: 'object',
              required: ['service'],
              properties: {
                service: { type: 'string', description: 'Service id, from GET /api/services' },
                method: { type: 'string', description: 'Sign-in method id; default: the first available' },
                config: { type: 'object', description: "Values for the method's fields, by key" },
                name: { type: 'string', description: 'Name scripts use for the connection; default: from the account' },
                redirectUri: { type: 'string', description: "Redirect URI registered at the provider, if it is not Switchboard's (e.g. http://localhost:8080/callback). The result is then manual: complete it with POST /api/connect/{flow}/complete." },
              },
            },
            { service: 'github', method: 'token', config: { token: '' } },
          ),
        }),
      },
      '/api/connections/{ref}': {
        get: op('Connections', 'Get a connection', { parameters: [ref] }),
        patch: op('Connections', 'Rename a connection', { parameters: [ref], requestBody: json({ type: 'object', properties: { name: { type: 'string', description: 'New name; scripts using the old one stop working' } } }, { name: '' }) }),
        delete: op('Connections', 'Disconnect', { parameters: [ref] }),
      },
      '/api/connections/{ref}/reconnect': { post: op('Connections', 'Sign in again', { parameters: [ref], requestBody: json({ type: 'object' }, {}) }) },
      '/api/connections/{ref}/token': {
        get: op('Connections', 'Get a fresh access token for a provider SDK', {
          parameters: [ref, { name: 'force', in: 'query', description: '1 to refresh even if still valid', schema: { type: 'string' } }],
        }),
      },
      '/api/connections/{ref}/openapi': { get: op('Connections', 'Operations from the service API description', { parameters: [ref] }) },
      '/api/connect/{flow}/complete': {
        post: op('Connections', 'Complete a sign-in with the address the provider redirected to', {
          description: 'For sign-ins started with a redirectUri. Pass the full address from the browser, or just the code.',
          parameters: [{ name: 'flow', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: json({ type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The address after signing in, e.g. http://localhost:8080/callback?code=…&state=…' } } }, { url: '' }),
        }),
      },
      '/api/connect/{flow}/poll': { post: op('Connections', 'Advance a device sign-in', { parameters: [{ name: 'flow', in: 'path', required: true, schema: { type: 'string' } }] }) },
      '/api/call': { post: op('Calls', 'Make a request through a connection', { description: 'Returns status, headers and body in a JSON envelope.', requestBody: json(call, { connection: '', method: 'GET', url: '/' }) }) },
      '/proxy/{ref}/{path}': {
        get: op('Calls', 'Proxy a request through a connection', {
          description: 'Any method. The path is relative to the service base URL; query, headers and body are passed through.',
          parameters: [ref, { name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      },
      '/api/calls': { get: op('Saved calls', 'List saved calls'), post: op('Saved calls', 'Save a call', { requestBody: json(saved, { name: '', method: 'GET', url: '/' }) }) },
      '/api/calls/{id}': {
        get: op('Saved calls', 'Get a saved call', { parameters: [id('Saved call id or name')] }),
        put: op('Saved calls', 'Update a saved call', { parameters: [id('Saved call id or name')], requestBody: json(saved) }),
        delete: op('Saved calls', 'Delete a saved call', { parameters: [id('Saved call id or name')] }),
      },
      '/api/calls/{id}/run': {
        post: op('Saved calls', 'Run a saved call', {
          description: 'Passes the response through. The body may override connection, pathParams, query, headers and body.',
          parameters: [id('Saved call id or name')],
          requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: {} } } },
        }),
      },
      '/api/tokens': {
        get: op('Tokens', 'List API tokens'),
        post: op('Tokens', 'Create an API token', {
          requestBody: json(
            {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', description: 'Shown on the tokens page and in Activity' },
                connectionIds: { type: 'array', items: { type: 'string' }, nullable: true, description: 'Limit the token to these connections; null for everything' },
                expiresInDays: { type: 'integer', description: 'Omit for a token that does not expire' },
              },
            },
            { name: '', connectionIds: null },
          ),
        }),
      },
      '/api/tokens/{id}': { delete: op('Tokens', 'Revoke an API token', { parameters: [id('Token id')] }) },
      '/api/admin/plugins': { get: op('Admin', 'List plugins') },
      '/api/admin/plugins/install': {
        post: op('Admin', 'Install plugins from GitHub', { requestBody: json(
            {
              type: 'object',
              required: ['repo'],
              properties: {
                repo: { type: 'string', description: 'owner/repo or a github.com URL, also to a folder' },
                ref: { type: 'string', description: 'Branch, tag or commit; default: the default branch' },
                path: { type: 'string', description: 'Folder in the repository' },
              },
            },
            { repo: 'owner/repo' },
          ),
        }),
      },
      '/api/admin/plugins/check-updates': { post: op('Admin', 'Check plugins for updates') },
      '/api/admin/plugins/{id}/update': { post: op('Admin', 'Update a plugin', { parameters: [id('Plugin id')] }) },
      '/api/admin/plugins/{id}/reload': { post: op('Admin', 'Reload a plugin', { parameters: [id('Plugin id')] }) },
      '/api/admin/users': {
        get: op('Admin', 'List users'),
        post: op('Admin', 'Add a user and get an invite link', { requestBody: json(
            { type: 'object', required: ['username'], properties: { username: { type: 'string' }, role: { type: 'string', enum: ['user', 'admin'], default: 'user' } } },
            { username: '', role: 'user' },
          ),
          description: 'Returns the user and a one-time invite link to send them.',
        }),
      },
    },
  };
}
