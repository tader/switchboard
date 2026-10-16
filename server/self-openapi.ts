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

const mcpRequest = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete'] },
    name: { type: 'string' }, uri: { type: 'string' }, arguments: { type: 'object' },
    cursor: { type: 'string', description: 'Omit to collect pages; an explicit cursor returns one page' },
    query: { type: 'string', description: 'Filter tools by name or description' },
    ref: { type: 'object' }, argument: { type: 'object' }, context: { type: 'object' },
  },
};

const saved = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Unique per user; saved calls run by name or id' },
    kind: { type: 'string', enum: ['http', 'mcp', 'websocket'], default: 'http' },
    websocketRequest: { type: 'object', required: ['operationId', 'arguments'], properties: { operationId: { type: 'string' }, arguments: { type: 'object' } }, description: 'Save declared command operations only' },
    mcpRequest: { ...mcpRequest, description: 'For kind=mcp, save tools/call, resources/read or prompts/get' },
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
      '/api/credentials': {
        get: op('Credentials', 'List reusable credentials owned by the full-access caller'),
        post: op('Credentials', 'Promote a connection credential without revealing its secret', { requestBody: json({ type: 'object', required: ['connection', 'name'], properties: { connection: { type: 'string' }, name: { type: 'string' } } }) }),
      },
      '/api/credentials/candidates': { post: op('Credentials', 'Find compatible credentials or connections for reuse', { requestBody: json({ type: 'object', properties: { connection: { type: 'string' }, service: { type: 'string' }, method: { type: 'string' }, config: { type: 'object' } } }) }) },
      '/api/credentials/{id}': {
        get: op('Credentials', 'Inspect metadata, linked services, and rotation field definitions', { parameters: [id('Credential ID')] }),
        patch: op('Credentials', 'Rename a credential with optimistic version checking', { parameters: [id('Credential ID')], requestBody: json({ type: 'object', required: ['name','version'], properties: { name: { type: 'string' }, version: { type: 'integer' } } }) }),
        delete: op('Credentials', 'Delete an unused credential; linked credentials cannot be deleted', { parameters: [id('Credential ID')] }),
      },
      '/api/credentials/{id}/rotate': { post: op('Credentials', 'Validate and replace a static secret for all linked connections', { parameters: [id('Credential ID')], requestBody: json({ type: 'object', required: ['version','config'], properties: { version: { type: 'integer' }, config: { type: 'object', description: 'Replacement credential fields such as token, key, or password; never returned by the management API.' } } }) }) },
      '/api/credentials/{id}/revoke': { post: op('Credentials', 'Disable all links and request provider revocation when supported', { parameters: [id('Credential ID')], requestBody: json({ type: 'object', required: ['version'], properties: { version: { type: 'integer' } } }) }) },
      '/api/connections/{ref}/credential': { post: op('Credentials', 'Link a compatible credential after destination validation', { parameters: [ref], requestBody: json({ type: 'object', properties: { credentialId: { type: 'string' }, sourceConnection: { type: 'string' }, name: { type: 'string' } } }) }) },
      '/api/connections/{ref}/credential/independent': { post: op('Credentials', 'Make a static connection independent without returning its secret', { parameters: [ref], description: 'OAuth requires a fresh reconnect with independent: true instead of copying a refresh token.' }) },
      '/api/connections/{ref}/websocket/proxy': { get: op('WebSocket', 'Upgrade to an authenticated provider frame relay', { parameters: [ref], description: 'Local connections with proxy support only. Authenticate with a Switchboard bearer token or same-origin session cookie. Provider authentication is performed server-side before frames are relayed.', responses: { '101': { description: 'WebSocket relay established' } } }) },
      '/api/connections/{ref}/plugin/openapi.json': { get: op('Connections', 'OpenAPI reference for plugin REST endpoints backed by WebSocket commands', { parameters: [ref] }) },
      '/api/connections/{ref}/websocket/operations': { get: op('WebSocket', 'Search/list WebSocket operations', { parameters: [ref, { name: 'query', in: 'query', schema: { type: 'string' } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }] }) },
      '/api/connections/{ref}/websocket/operations/{operationId}': { get: op('WebSocket', 'Inspect a WebSocket operation', { parameters: [ref, { name: 'operationId', in: 'path', required: true, description: 'URL-encode slashes in operation ids', schema: { type: 'string' } }] }) },
      '/api/connections/{ref}/websocket/call': { post: op('WebSocket', 'Execute a declared command', { parameters: [ref], requestBody: json({ type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' }, arguments: { type: 'object', default: {} } } }) }) },
      '/api/connections/{ref}/websocket/operations/get': { post: op('WebSocket', 'Get operation metadata without encoded path segments', { parameters: [ref], requestBody: json({ type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } }) }) },
      '/api/connections/{ref}/websocket/subscriptions': {
        get: op('WebSocket', 'List subscription handles owned by this caller', { parameters: [ref] }),
        post: op('WebSocket', 'Start a declared subscription', { parameters: [ref], requestBody: json({ type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' }, arguments: { type: 'object', default: {} } } }) }),
      },
      '/api/connections/{ref}/websocket/subscriptions/{id}/read': { post: op('WebSocket', 'Read buffered events; preserve nextCursor and inspect gaps/status', { parameters: [ref, id('Subscription handle')], requestBody: json({ type: 'object', properties: { cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 0 } } }) }) },
      '/api/connections/{ref}/websocket/subscriptions/{id}': { delete: op('WebSocket', 'Stop a subscription; terminal buffers remain readable for five minutes', { parameters: [ref, id('Subscription handle')] }) },
      '/api/me': { get: op('Account', 'Who the token belongs to') },
      '/api/me/token': { delete: op('Account', 'Revoke the token making this request') },
      '/api/services': { get: op('Connections', 'Services and their sign-in methods') },
      '/api/peers': { get: op('Peers', 'List peers with your sharing counts and last-seen information') },
      '/api/connection-shares': { get: op('Peers', 'Read your sharing matrix and blocked peer cycles') },
      '/api/connections/{ref}/shares/{peerId}': { put: op('Connections', 'Set one sharing matrix cell for a connection you own', { parameters: [ref, { name: 'peerId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: json({ type: 'object', required: ['shared'], properties: { shared: { type: 'boolean' } } }) }) },
      '/api/connections/{ref}/shares': {
        get: op('Connections', 'Read sharing grants for a connection you own', { parameters: [ref] }),
        put: op('Connections', 'Replace sharing grants for a connection you own', { parameters: [ref],
          requestBody: json({ type: 'object', required: ['peerIds'], properties: { peerIds: { type: 'array', items: { type: 'string' }, description: 'An empty list revokes all sharing' } } }),
        }),
      },
      '/api/admin/peers': {
        get: op('Admin', 'List configured peers and live status without device tokens'),
        post: op('Admin', 'Configure an incoming or outgoing peer', { requestBody: json({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, url: { type: 'string' }, token: { type: 'string' }, direction: { type: 'string', enum: ['incoming', 'outgoing'], default: 'incoming' }, ownerUserId: { type: 'string' } } }) }),
      },
      '/api/admin/peers/{id}/rotate-token': { post: op('Admin', 'Rotate the accepting peer credential', { parameters: [id('Peer id')] }) },
      '/api/admin/peers/{id}': {
        get: op('Admin', 'Read a peer and its received connections', { parameters: [id('Peer id')] }),
        patch: op('Admin', 'Change a peer without changing local connections', { parameters: [id('Peer id')], requestBody: json({ type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, token: { type: 'string', description: 'Omit or leave blank to preserve the token' }, disabled: { type: 'boolean' }, userIds: { type: 'array', items: { type: 'string' } } } }) }),
        delete: op('Admin', 'Remove a peer and its sharing grants', { parameters: [id('Peer id')] }),
      },
      '/api/connections': {
        get: op('Connections', 'List local connections and read-only shared handles', { description: 'readOnly=true identifies imported peer connections. Only execution, OpenAPI discovery and explicit onward sharing are supported for imported handles.' }),
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
                credentialId: { type: 'string', description: 'Reuse this owned credential; additional OAuth consent is requested if needed.' }, independent: { type: 'boolean', description: 'Obtain a fresh OAuth grant for this connection.' }, redirectUri: { type: 'string', description: "Redirect URI registered at the provider, if it is not Switchboard's (e.g. http://localhost:8080/callback). The result is then manual: complete it with POST /api/connect/{flow}/complete." },
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
      '/api/connections/{ref}/reconnect': { post: op('Connections', 'Sign in again', { parameters: [ref], description: 'Full-access owners only. Shared reconnection updates the credential for every linked service; independent requires a fresh private OAuth grant.', requestBody: json({ type: 'object', properties: { method: { type: 'string' }, config: { type: 'object' }, credentialId: { type: 'string' }, independent: { type: 'boolean' } } }, {}) }) },
      '/api/connections/{ref}/token': {
        get: op('Connections', 'Get a fresh access token for a provider SDK', {
          parameters: [ref, { name: 'force', in: 'query', description: '1 to refresh even if still valid', schema: { type: 'string' } }],
        }),
      },
      ...Object.fromEntries(['tools/list', 'tools/get', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete'].map(operation => [
        `/api/connections/{ref}/mcp/${operation}`, { post: op('MCP connections', `MCP ${operation}`, {
          parameters: [ref], requestBody: json(mcpRequest, {}),
          description: 'Runs only on an MCP connection accessible to this token. Returns the MCP result, including rich content and isError. tools/get accepts name and returns its schema. tools/list accepts query. Protocol and authorization errors use HTTP error statuses; tool isError results use HTTP 200.',
        }) },
      ])),
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
          description: 'HTTP calls pass the provider response through and accept connection, pathParams, query, headers and body overrides. MCP requests return an MCP result and accept connection, arguments (merged) and uri overrides.',
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
      '/api/admin/plugins/community': { get: op('Admin', 'Fetch the live community plugin catalog', { description: 'Fetches all configured public GitHub catalogs on each request. Returns sources and warnings alongside plugins. Earlier lists take precedence for duplicate IDs; unavailable lists are reported while other lists remain usable.' }) },
      '/api/admin/plugins/community/sources': {
        get: op('Admin', 'List curated plugin catalogs', { description: 'Returns the main catalog followed by saved additional catalogs.' }),
        put: op('Admin', 'Save additional curated plugin catalogs', {
          requestBody: json({ type: 'object', required: ['sources'], properties: { sources: { type: 'array', maxItems: 20, items: { type: 'object', required: ['name', 'repo', 'path', 'ref'], properties: { name: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } } } } } }),
          description: 'Replaces the additional public GitHub JSON catalogs for the instance. The main catalog is always retained. Duplicate sources and invalid paths are rejected.',
        }),
      },
      '/api/admin/plugins/releases': { post: op('Admin', 'List published plugin releases', {
        requestBody: json({ type: 'object', properties: {
          repo: { type: 'string', description: 'owner/repo; optional when pluginId identifies an installed plugin' },
          path: { type: 'string', description: 'Plugin folder; scopes release-please component tags' },
          pluginId: { type: 'string', description: 'Installed plugin whose source and remembered access should be used' },
          githubConnectionId: { type: 'string', nullable: true, description: 'Local or shared peer GitHub connection; null for automatic access' },
        } }),
        description: 'Returns tag, name, prerelease, publishedAt and url. Includes prereleases for explicit pinning, excludes drafts, and paginates GitHub results. Default latest tracking excludes prereleases. Repositories with component releases require a plugin folder.',
      }) },
      '/api/admin/plugins/install/plan': { post: op('Admin', 'Preview an installation and its dependencies', {
        requestBody: json({ type: 'object', properties: {
          installs: { type: 'array', minItems: 1, maxItems: 100, description: 'Use instead of repo to preview multiple community listings together.', items: { type: 'object', required: ['repo', 'expectedId'], properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' }, expectedId: { type: 'string' } } } },
          repo: { type: 'string' }, channel: { type: 'string', enum: ['latest', 'release', 'branch'], description: 'latest follows stable published releases (install default); release pins ref to a published release; branch follows a development ref. Omit on update to keep the saved policy.' }, ref: { type: 'string' }, path: { type: 'string' }, expectedId: { type: 'string', description: 'Optional expected id for a single-plugin listing' },
          githubConnectionId: { type: 'string', nullable: true, description: 'A local or shared peer GitHub connection accessible to the administrator; null or omitted selects automatically' },
        } }, { repo: 'owner/repo' }),
        description: 'Returns planId, expiresAt, changes, affectedDependents and requiresReview. No plugin code executes. Plans are administrator-bound and expire after ten minutes.',
      }) },
      '/api/admin/plugins/update/plan': { post: op('Admin', 'Preview coordinated plugin updates', {
        requestBody: json({ type: 'object', required: ['updates'], properties: { updates: { type: 'array', minItems: 1, maxItems: 100, items: {
          type: 'object', required: ['id'], properties: { id: { type: 'string' }, channel: { type: 'string', enum: ['latest', 'release', 'branch'], description: 'latest follows stable published releases (install default); release pins ref to a published release; branch follows a development ref. Omit on update to keep the saved policy.' }, ref: { type: 'string', nullable: true, description: 'Release tag for release; branch name for branch. Legacy ref without channel opts into development; null follows the default branch.' }, githubConnectionId: { type: 'string', nullable: true, description: 'Omit to prefer the remembered connection; null requests automatic selection' } },
        } } } }, { updates: [{ id: 'example' }] }),
        description: 'Preview one or multiple updates together, including shared dependency upgrades and compatibility checks.',
      }) },
      '/api/admin/plugins/apply': { post: op('Admin', 'Apply a reviewed plugin preview', {
        requestBody: json({ type: 'object', required: ['planId'], properties: { planId: { type: 'string' } } }),
        description: 'Applies pinned commits and returns ids, changes and plugins. A stale or expired preview returns 409. Activation failures restore previous plugin files and metadata.',
      }) },
      '/api/admin/plugins/install': {
        post: op('Admin', 'Install plugins from GitHub', { requestBody: json(
            {
              type: 'object',
              required: ['repo'],
              properties: {
                repo: { type: 'string', description: 'owner/repo or a github.com URL, also to a folder' },
                channel: { type: 'string', enum: ['latest', 'release', 'branch'], description: 'latest follows stable published releases (install default); release pins ref to a published release; branch follows a development ref. Omit on update to keep the saved policy.' },
                ref: { type: 'string', description: 'Required published release tag for release; optional branch/tag/commit for branch. Omit with latest.' },
                path: { type: 'string', description: 'Folder in the repository' },
                githubConnectionId: { type: 'string', nullable: true, description: 'Local or shared peer GitHub connection accessible to the administrator; omit or null for automatic selection' },
              },
            },
            { repo: 'owner/repo' },
          ),
        }),
      },
      '/api/admin/plugins/check-updates': { post: op('Admin', 'Check plugins for updates') },
      '/api/admin/plugins/{id}/update': { post: op('Admin', 'Update a plugin', {
        parameters: [id('Plugin id')],
        requestBody: { ...json({ type: 'object', properties: {
          channel: { type: 'string', enum: ['latest', 'release', 'branch'], description: 'latest follows stable published releases (install default); release pins ref to a published release; branch follows a development ref. Omit on update to keep the saved policy.' },
          ref: { type: 'string', nullable: true, minLength: 1, description: 'Release tag for release; branch name or null for branch. Omit both channel and ref to keep the saved policy. Legacy ref without channel selects development.' },
          githubConnectionId: { type: 'string', nullable: true, description: 'Select an accessible local or shared peer GitHub connection; omit to prefer the remembered connection, or null for automatic selection' },
        } }), required: false },
      }) },
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
