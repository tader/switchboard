---
title: Writing plugins
adminOnly: true
---

# Writing plugins

A plugin is a directory with a `plugin.json` and an entry module. It can provide services (things users connect to), export helpers for other plugins, or both.

```
my-plugin/
  plugin.json
  index.ts      # or index.js; TypeScript is run directly (erasable syntax only)
  icon.svg
```

```json
{
  "id": "linear",
  "name": "Linear",
  "version": "1.0.0",
  "description": "Issues and projects.",
  "dependencies": ["oauth2", "api-key"],
  "icon": "icon.svg",
  "settings": [
    { "key": "clientId", "label": "OAuth client ID" },
    { "key": "clientSecret", "label": "OAuth client secret", "type": "secret" }
  ]
}
```

- `id`: lowercase letters, digits and dashes.
- `dependencies`: plugins whose exports you use. They load first; when one reloads, so does yours. If one is missing or disabled your plugin waits.
- `dependencyVersions`: optional npm semver ranges keyed by ids in `dependencies`, for example `{"oauth2": "^1.0.0", "api-key": ">=1.0.0 <2.0.0"}`. Existing dependency arrays remain valid without ranges. A constrained dependency must have a valid semantic version. Version mismatches also block loading after local edits or a restart.
- `settings`: instance-wide values an administrator sets on the Plugins page, passed as `ctx.settings`. Saving them reloads the plugin.
- `main`: entry module if not `index.ts`/`index.js`.

The entry module default-exports a setup function:

```ts
import type { PluginContext } from '../../server/plugins/api.ts'; // type-only, erased at runtime
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  const configured = !!(ctx.settings.clientId && ctx.settings.clientSecret);

  return {
    services: [
      {
        id: 'linear',
        name: 'Linear',
        description: 'Issues and projects',
        icon: 'icon.svg',
        baseUrl: 'https://api.linear.app',
        allowedHosts: ['api.linear.app'],
        openapi: undefined, // URL or object; enables the API reference in the console
        authMethods: [
          apiKey.headerKey({ id: 'key', name: 'API key', header: 'Authorization' }),
          oauth.authorizationCode({
            name: 'Sign in with Linear',
            unavailable: configured ? undefined : 'An administrator needs to configure an OAuth app',
            authorizeUrl: 'https://linear.app/oauth/authorize',
            tokenUrl: 'https://api.linear.app/oauth/token',
            clientId: () => ctx.settings.clientId,
            clientSecret: () => ctx.settings.clientSecret,
            scopes: ['read'],
            identify: async (creds) => ({ label: 'Linear account' }),
          }),
        ],
      },
    ],
    exports: {},               // available to plugins that depend on this one
    dispose() {},              // called before the plugin is unloaded
  };
}
```

All types are in [`server/plugins/api.ts`](../server/plugins/api.ts).

## Services and auth methods

A service has one or more `authMethods`; the user picks one when connecting. A method:

- declares `fields` to ask the user (`text`, `secret`, `url`, `textarea`, `select`, `boolean`; `advanced` fields are folded away),
- `connect({ config, callbackUrl, state })` returns one of
  - `{ credentials, account?, config? }`: connected,
  - `{ redirect, pending? }`: the browser goes to `redirect`; the provider returns to Switchboard's single callback URL with `state`, and Switchboard calls `callback({ params, pending, ... })`,
  - `{ device: { userCode, verificationUri, interval }, pending? }`: the user enters the code; Switchboard calls `poll({ pending, ... })`, which returns `{ wait: true }` or the credentials,
- `authorize(req, conn, { force })` adds credentials to an outgoing request (`req.headers`, `req.url`). Return `{ credentials }` to persist refreshed ones. After a 401 Switchboard retries once with `force: true`. Calls are serialized per connection, so refreshes don't race.
- optional `token(conn)` hands out a bearer token for SDKs, and `revoke(conn)` runs when a connection is deleted.

`account.id` identifies the account at the provider: connecting the same account again updates the existing connection instead of adding one.

`ServiceDefinition.kind` identifies the connection protocol (`http` or `mcp`). Omitting it defaults to `http` for existing plugins. Switchboard persists the kind on connections and includes it in service and connection API views.

For `kind: 'mcp'`, `baseUrl` is the exact Streamable HTTP endpoint, including its path and query. Core execution performs MCP negotiation, capability checks, pagination, timeouts and cleanup. Plugins still use only type imports. `ctx.mcp.oauth()` provides the MCP OAuth auth method with endpoint/scopes/client fields, discovery, PKCE and encrypted refresh state. See `plugins/mcp/index.ts` for OAuth, bearer, header and no-auth methods. MCP connections use the scoped MCP API and cannot be called through the HTTP proxy.

Credentials and config are stored encrypted. Secrets the user typed are only returned to plugins, never to the web app.

Credentials are only sent to `allowedHosts` (default: the host of `baseUrl`). Entries may be `*.example.com`. `baseUrl`, `allowedHosts` and `openapi` may be functions of the connection, for services where the user enters the URL.

## Shared building blocks

Switchboard bundles only `mcp`, `api-key`, and `oauth2`. Provider integrations are installed from Community.

`oauth2` exports `authorizationCode`, `deviceCode`, `clientCredentials` (each returns an auth method, options may be functions of the user's config), and `tokenRequest`, `freshCredentials`, `OAuthError`.

`api-key` exports `bearerToken`, `headerKey`, `queryKey`, `basicAuth`. Secret fields go into credentials; pass `identify` to validate the key and name the account.

The external [`google`](https://github.com/tader/switchboard-plugin-google) plugin exports `googleService({ id, name, scopes, baseUrl, allowedHosts, openapi, fields })`, which builds a Google service using the admin-configured OAuth client. See the [Gmail plugin](https://github.com/tader/switchboard-plugin-google/blob/main/plugins/gmail/index.ts) for a short, complete example. The external [`microsoft`](https://github.com/tader/switchboard-plugin-microsoft) plugin similarly exports `microsoftService` and `spec` for Microsoft Graph apps. Declare these helpers in `dependencies` with compatible `dependencyVersions`; the live catalog resolves each plugin's repository and folder. Google and Microsoft apps live alongside their helper in their respective family repository.

## Documentation

Put Markdown files in a `docs/` folder in the plugin. They appear in Switchboard's **Docs** under *Services* while the plugin is active. The connect dialog links to them for the services they cover. Optional front matter:

```markdown
---
title: Connecting Linear          # default: the first "# heading"
services: [linear]                # default: the services this plugin provides
dependents: true                  # also for services of plugins that depend on this one
excludeServices: [linear-admin]
order: 1
adminOnly: true                   # only shown to administrators
---
```

Guides can use GitHub-style callouts: a blockquote starting with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. Code blocks are highlighted for `bash`, `json`, `toml`, `yaml`, `python`, `javascript`, `typescript`, `http` and `markdown`.

`\{{publicUrl}}`, `\{{mcpUrl}}` and `\{{callbackUrl}}` are replaced with Switchboard's addresses (write `\\{{…}}` to show one literally), so a guide can say exactly which redirect URI to register. Links like `/connections` or `/docs/<plugin>/<file>` open inside Switchboard. Edits show up on the next page load.

## Hot reload and installing

Files are watched: editing a plugin (built in, or under `<data>/plugins/`) reloads it and its dependents within a second. Each load imports a fresh copy of the plugin directory, so relative imports are reloaded too. Plugins cannot have their own `node_modules`; bundle third-party code or use Node built-ins and `fetch`.

To publish, push the directory to GitHub. Admins install with `owner/repo`, a URL to a folder (`https://github.com/owner/repo/tree/main/plugins/linear`), or `owner/repo@tag`. A repository may contain several plugins at the top level or under `plugins/`; omitting the folder selects all of them. The install dialog previews the selected plugins and their dependencies before installing.

**Plugins → Community** loads the current [community catalog](https://github.com/tader/switchboard-plugins) when opened and when **Refresh** is clicked. Its listings are not bundled with Switchboard releases. Use the checkboxes to select several plugins, then **Install selected** to review and install them together, including shared dependencies. The header checkbox selects available plugins in the current filtered results. Each listing installs one plugin folder. **Manage lists** adds or removes additional GitHub catalogs by repository, JSON file path, and branch or tag. These settings are saved for the instance and shared by administrators. Additional catalogs use the same JSON format as the main catalog and are also used to resolve dependencies. Filter by curated list to browse one list. The main list takes precedence for duplicate plugin IDs, followed by additional lists in their configured order. Failed lists and duplicate listings are reported in the Community view; available lists remain usable. Contribute a listing through a pull request in the catalog repository; its README describes the format and validation command.

Catalog requests try anonymous access first. If GitHub rejects access or rate limits a request, Switchboard tries `SWITCHBOARD_GITHUB_TOKEN`, then the signed-in administrator’s eligible local or shared peer GitHub connections. This also permits private curated lists and applies when catalogs resolve installation dependencies. Another administrator’s private connections are never used. Exhausted rate limits are reported explicitly.

For private repositories, choose **GitHub access → Automatic** or one of your accessible GitHub connections, including a connection shared by a peer. Automatic access tries public access, `SWITCHBOARD_GITHUB_TOKEN`, the remembered connection when it belongs to you, then your other eligible local or shared peer GitHub connections. Explicit selection uses only the chosen connection. A personal access token needs repository Contents read access; OAuth access may need the `repo` scope and organization authorization. Another administrator's private connections are not used. Peer requests use only connections explicitly shared with you, execute on their owning instance, and never transfer the GitHub token. Offline or revoked shares are unavailable. Successful saved connections are remembered by id for later checks and updates; credentials remain encrypted in the connection store. **Automatic** ignores the previous preference for that operation and remembers any saved connection that succeeds.

Missing dependencies are installed recursively from matching folders in the requested repository, then from the live catalog. A compatible installed dependency is reused. When a version requirement needs an existing dependency upgraded, Switchboard considers its tracked ref and checks the requirements of the enabled plugins that use it. The preview shows shared dependency upgrades and affected dependents. It does not search old release tags, switch dependency refs or automatically downgrade dependencies. Enable disabled dependencies explicitly first; incompatible built-in helpers require a Switchboard upgrade.

*Check for updates* compares installed commits with their selected update policy. New installs follow the latest stable published GitHub release; unpublished default-branch commits and prereleases are excluded. Repositories without a stable release require an explicit development branch choice. Repositories with release-please component tags (such as `gmail-v1.2.3`) require a plugin folder; repository-wide releases use tags such as `v1.2.3`. **Update all** previews all available updates together, regardless of the search filter, so shared dependencies are resolved consistently. Each plugin retains its release or branch setting. Pinned releases are excluded from update checks. Incompatible requirements stop the preview with an explanation.

Use **Version & updates…** to select **Latest release**, **Pin a release**, or **Development branch**, and optionally change GitHub access. The release picker includes prereleases for explicit selection. A pin stores the reviewed commit as well as its release tag: ordinary updates keep that commit even if the tag moves. Select another version or Latest release to unpin. Branch updates follow the chosen ref (leave it empty for the repository default branch). Existing explicit refs keep their previous behavior; existing sources without a ref now follow stable releases. Changes are pinned to the previewed commits; previews expire after ten minutes or become stale when installed plugin code, settings or state changes. Settings and connections remain in place. A failed activation restores every changed plugin's previous files and metadata, but cannot undo external side effects performed by plugin code.

### Installation API

`POST /api/admin/plugins/install/plan` accepts `{repo, channel?, ref?, path?, githubConnectionId?, expectedId?}`. `expectedId` checks that a single-plugin listing still points to the expected manifest. `POST /api/admin/plugins/update/plan` accepts `{updates: [{id, channel?, ref?, githubConnectionId?}]}` for one or multiple plugins. Both return `{planId, expiresAt, changes, affectedDependents, requiresReview}` without executing downloaded plugin code.

Apply the reviewed preview with `POST /api/admin/plugins/apply` and `{planId}`. It returns `{ids, changes, plugins}`. The preview belongs to the requesting administrator and can be applied once. An expired or stale preview returns HTTP 409; request a new preview.

For `githubConnectionId`, a string explicitly selects your accessible local or shared peer GitHub connection, `null` uses automatic access, and omission on update prefers the remembered connection before falling back automatically. Set `channel` to `latest` (no ref), `release` (required published release tag in `ref`), or `branch` (optional ref). Omit both fields on updates to retain the saved policy. For compatibility, an explicit `ref` without `channel` selects development tracking; `null` selects the default branch. A pinned dependency is never silently upgraded; choose a compatible version explicitly first.

`POST /api/admin/plugins/releases` accepts `{repo?, path?, pluginId?, githubConnectionId?}` and returns published `{tag, name, prerelease, publishedAt, url}` entries. Use a plugin folder for component releases. `pluginId` can supply an installed plugin's repository/folder and remembered access. Drafts are excluded; older releases remain available for pinning.

The direct install/update endpoints retain their response shapes. If a direct operation requires a shared dependency upgrade, they return HTTP 409 with `code: "plugin_review_required"` and the concrete `plan`; review it before sending its `planId` to the apply endpoint.

Plugins run in Switchboard process with full access. Only install plugins you trust.


## Peers

`ctx.peer` is true when this instance has at least one configured peer, incoming or outgoing. It replaces the former satellite flag. A peer describes a relationship between two Switchboard instances; both can explicitly share local connections through **Peers → Sharing**. Plugins configure connections only on their local instance.

The former `switchboard` plugin is retired and cannot be enabled. Its existing connection records and credentials remain stored, but unavailable. Configure Peers and choose sharing grants explicitly instead.

## WebSocket-backed operations

An HTTP-category service may declare `websocket` alongside `baseUrl` and `openapi`.
No new connection kind or plugin dependency is required. The capability has:

- `endpoint`: an absolute URL or a function of the connection. Relative URLs resolve
  against `baseUrl`; HTTP(S) endpoints are converted to WS(S). The normal allowed-host
  policy applies before and after authorization. WS requires an HTTP base URL.
- `operations`: unique IDs, titles, descriptions, `mode` (`command` or `subscription`),
  object `inputSchema`, optional `outputSchema`/`eventSchema`, and optional
  `readOnlyHint`/`idempotentHint`. Schemas use JSON Schema draft 2020-12; references
  must resolve locally. Validation does not coerce values or insert defaults.
- `createSession({ channel, connection, signal })`: returns a protocol adapter with
  `call(operationId, arguments, operationSignal)`, optional
  `subscribe(operationId, arguments, emit, subscriptionSignal)`, and optional
  `dispose()`. Results and emitted events must be JSON serializable.

`channel.send(string | Uint8Array)` and `channel.receive(signal?)` are asynchronous.
`channel.closed` resolves on closure. Authentication is the first receive consumer;
then the session owns the single receive loop and dispatches correlated replies and
subscription events. Initial frames are buffered before authentication starts.
The session signal ends when the socket closes. Commands receive cancellation and
timeout signals; subscriptions receive a lifetime signal that ends when stopped.
Do not attach an operation timeout to a long-lived subscription's receive loop.

Core calls the selected auth method's existing `authorize()` with an HTTP-equivalent
GET upgrade request. For services that authenticate in frames, implement the optional
`authenticateWebSocket(channel, connection, { force, signal })` hook. Both hooks may
return updated credentials. Authentication is serialized with credential refresh.
A definitive authentication rejection may throw an Error with
`code = 'WEBSOCKET_AUTH_REJECTED'`; core opens a new socket once with `force: true`.
The authorization method should refresh credentials on that forced attempt. Never
include credentials or authentication frames in errors, results, events, or logs.

For example, an HA-style message-authenticated method can use:

```ts
async authenticateWebSocket(channel, connection, { signal }) {
  const greeting = JSON.parse(String(await channel.receive(signal)));
  if (greeting.type !== 'auth_required') throw new Error('Unexpected authentication greeting');
  await channel.send(JSON.stringify({
    type: 'auth', access_token: connection.credentials.accessToken,
  }));
  const result = JSON.parse(String(await channel.receive(signal)));
  if (result.type !== 'auth_ok') {
    const error = Object.assign(new Error('Authentication rejected'), {
      code: 'WEBSOCKET_AUTH_REJECTED',
    });
    throw error;
  }
}
```

This illustrates the documented [Home Assistant authentication handshake](https://developers.home-assistant.io/docs/api/websocket/);
it does not implement its command protocol or token refresh.

A subscription must resolve only after the upstream acknowledges it. Register its
message ID and event callback before sending the start command so early events are
retained. Return `{ stop: async () => { /* unsubscribe and await acknowledgement */ } }`.
If no stop function is supplied, core closes the entire session when the subscription
ends; other subscriptions on it become interrupted. Cancellation during creation
must release partially created work. Dispose outstanding requests and listeners when
the session signal aborts, and discard late replies to cancelled commands.

Sockets are pooled by caller, connection, endpoint, plugin generation, and credential
generation, with 60-second idle expiry. Core closes a session when a command is
cancelled or times out; its other subscriptions become interrupted. Core never
replays sent commands. Access changes, reconnect/delete, credential replacement,
plugin reload/unload, and shutdown end affected sessions. Subscriptions use bounded
in-memory event buffers and five-minute leases; see the API guide for quotas and
limits. Installed plugins still use type-only imports and cannot require their own
`node_modules`. See the [TypeScript plugin contract](../server/plugins/api.ts) and
the [complete test-plugin adapter](../test/fixtures/websocket-plugin/index.ts) for
reply dispatching, message authentication, commands, and subscriptions.


### Frame proxy and REST bindings

Set `websocket.proxy: true` to enable authenticated, dedicated raw frame relays to the capability's fixed endpoint. Core applies the existing auth hooks, host policy, socket quotas, credential invalidation, and access checks; the protocol adapter is not created on relay sockets. Managed operations continue to use their own adapter sockets.

Command operations may declare `rest: { method: 'GET' | 'POST' | 'PUT', path: '/relative/path' }`. Core serves these under `/api/connections/:ref/plugin`, executing the command through its managed WebSocket adapter and returning its result directly as JSON. GET bindings require `readOnlyHint: true`. Paths must be unique per method and contain lowercase letters, digits, slashes, or hyphens. GET query arguments are validated against the input schema (boolean values are decoded); POST/PUT accept the argument object as JSON. Core generates `/plugin/openapi.json` from the operation schemas. These features currently require local connections.

## Reusable credentials

Auth methods may declare `reusable` with a versioned `format`, `kind` (`static` or `oauth`), authority/client `context(config)`, and a `validate(connection)` hook. Static methods can implement `prepare(config, previous)` for rotation. `exportCredentials`/`importCredentials` map native bundles to one canonical encrypted format; matching field names alone do not establish compatibility.

OAuth additionally requires a refresh-free `applyToken(request, connection, token)` hook, granted-scope metadata, and an `allowRequest(request, connection)` policy that enforces the consumer's resource and access boundaries. Optional `requiredScopes` and `coversScopes` handle provider-specific scope implications. `configKeys` identifies lifecycle configuration kept only on the credential, such as per-user client IDs/secrets. Context must identify the authority and client, not include rotating secret values.

The built-in API-key helper opts in when an identity validation hook is provided, and projects one-field token/key bundles into a common opaque-secret format. The OAuth helper opts in when its factory receives a reusable request policy; it supports shared additional consent via core-managed scopes. Methods without a contract remain independent and existing plugins continue working unchanged. Core resolves bundles per connection, serializes refresh by credential ID, and invalidates all linked authentication sessions on changes.

OAuth reuse currently requires an HTTP-only service. A handshake URL policy does not establish safe MCP-tool or WebSocket-frame permissions; these OAuth methods remain independent. Static reuse still resolves centrally across HTTP, MCP, and WebSocket transports. Provider token requests for reusable OAuth methods reject redirects and sanitize error bodies.


## Authentication providers and consumers

An auth method can expose `credentialProvider: { format, provide(connection, options) }`. Use a versioned format identifier. `provide` returns `{ bundle, account, credentials? }`; `account.id` must match the connected account. Options include `forceAuthentication`, `signal`, and `persistCredentials(value)`. Persist a rotated refresh token immediately, even when a later validation step may fail. Bundles are limited to 512 KiB. Keep browser profiles and unrelated secrets out of exported bundles. A provider method should not expose a general `token` hook.

A consumer declares `credentialConsumer: { format, field }` and a field with `{ key: field, type: 'credential-source', credentialFormat: format, label: 'Authentication source' }`. Call `ctx.credentials.obtain(connection.config[field], { format, forceAuthentication?, signal? })` in authentication hooks. It returns `{ format, bundle, account }` on the backend. The capability is optional for compatibility with older cores; hide or disable this authentication method when it is absent. A method cannot be both a provider and consumer.

Core binds calls to the acting user, declared consumer and selected source. It lists only owned or explicitly granted direct-peer sources, validates the source again before every consumer operation, and serializes source refreshes. Sources require a separate authentication-sharing grant before peers can request a bundle. No browser endpoint returns a bundle. Audit entries contain transfer metadata only.

Consumers remain responsible for validating bundle format, account identity, audience, granted permissions, resource and access boundaries. They may opt into the reusable OAuth contract above to share an encrypted cache across compatible local service connections. Resource-qualified scope metadata must distinguish audiences. Core invokes the destination consumer's token hook when projecting shared credentials, so each service receives the appropriate audience. Authentication hooks receive an optional `persistCredentials` callback for intermediate rotations. Use it before returning a later updated bundle. An unavailable source may use a previously imported cache until refresh fails; an observed revoked grant blocks linked use immediately.

Authentication methods can set `hidden: true` to retain handlers for existing connections while omitting the method from setup choices. Hidden methods are not selected by default for new connections. Reconnecting through a visible replacement keeps the connection ID.
