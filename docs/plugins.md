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

The external [`google`](https://github.com/tader/switchboard-plugin-google) plugin exports `googleService({ id, name, scopes, baseUrl, allowedHosts, openapi, fields })`, which builds a Google service using the admin-configured OAuth client. See the [Gmail plugin](https://github.com/tader/switchboard-plugin-gmail/blob/main/plugins/gmail/index.ts) for a short, complete example. The external [`microsoft`](https://github.com/tader/switchboard-plugin-microsoft) plugin similarly exports `microsoftService` and `spec` for Microsoft Graph apps. Declare these helpers in `dependencies` with compatible `dependencyVersions`; the live catalog resolves their separate repositories.

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

**Plugins → Community** loads the current [community catalog](https://github.com/tader/switchboard-plugins) when opened and when **Refresh** is clicked. Its listings are not bundled with Switchboard releases. Each listing installs one plugin folder. Contribute a listing through a pull request in the catalog repository; its README describes the format and validation command.

For private repositories, choose **GitHub access → Automatic** or one of your local GitHub connections. Automatic access tries public access, `SWITCHBOARD_GITHUB_TOKEN`, the remembered connection when it belongs to you, then your other eligible GitHub connections. Explicit selection uses only the chosen connection. A personal access token needs repository Contents read access; OAuth access may need the `repo` scope and organization authorization. Another administrator's connections and satellite connections are not used. Successful saved connections are remembered by id for later checks and updates; credentials remain encrypted in the connection store. **Automatic** ignores the previous preference for that operation and remembers any saved connection that succeeds.

Missing dependencies are installed recursively from matching folders in the requested repository, then from the live catalog. A compatible installed dependency is reused. When a version requirement needs an existing dependency upgraded, Switchboard considers its tracked ref and checks the requirements of the enabled plugins that use it. The preview shows shared dependency upgrades and affected dependents. It does not search old release tags, switch dependency refs or automatically downgrade dependencies. Enable disabled dependencies explicitly first; incompatible built-in helpers require a Switchboard upgrade.

*Check for updates* compares installed commits with their tracked refs. **Update all** previews all available updates together, regardless of the search filter, so shared dependencies are resolved consistently. Each plugin retains its own tracked ref. Incompatible requirements stop the preview with an explanation.

Use **Update from…** to change a selected plugin's branch, tag, commit or GitHub access choice. The ref is remembered, including when both refs point to the same commit. **Use default branch** returns to the repository's default branch. Changes are pinned to the previewed commits; previews expire after ten minutes or become stale when installed plugin code, settings or state changes. Settings and connections remain in place. A failed activation restores every changed plugin's previous files and metadata, but cannot undo external side effects performed by plugin code.

### Installation API

`POST /api/admin/plugins/install/plan` accepts `{repo, ref?, path?, githubConnectionId?, expectedId?}`. `expectedId` checks that a single-plugin listing still points to the expected manifest. `POST /api/admin/plugins/update/plan` accepts `{updates: [{id, ref?, githubConnectionId?}]}` for one or multiple plugins. Both return `{planId, expiresAt, changes, affectedDependents, requiresReview}` without executing downloaded plugin code.

Apply the reviewed preview with `POST /api/admin/plugins/apply` and `{planId}`. It returns `{ids, changes, plugins}`. The preview belongs to the requesting administrator and can be applied once. An expired or stale preview returns HTTP 409; request a new preview.

For `githubConnectionId`, a string explicitly selects your local GitHub connection, `null` uses automatic access, and omission on update prefers the remembered connection before falling back automatically. For update `ref`, omission retains the tracked ref and `null` follows the default branch.

The direct install/update endpoints retain their response shapes. If a direct operation requires a shared dependency upgrade, they return HTTP 409 with `code: "plugin_review_required"` and the concrete `plan`; review it before sending its `planId` to the apply endpoint.

Plugins run in Switchboard process with full access. Only install plugins you trust.
