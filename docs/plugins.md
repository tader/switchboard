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

## Building blocks from built-in plugins

`oauth2` exports `authorizationCode`, `deviceCode`, `clientCredentials` (each returns an auth method, options may be functions of the user's config), and `tokenRequest`, `freshCredentials`, `OAuthError`.

`api-key` exports `bearerToken`, `headerKey`, `queryKey`, `basicAuth`. Secret fields go into credentials; pass `identify` to validate the key and name the account.

`google` exports `googleService({ id, name, scopes, baseUrl, allowedHosts, openapi, fields })`, which builds a Google service using the admin-configured OAuth client. See `plugins/gmail` for a short, complete example.

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

To publish, push the directory to GitHub. Admins install with `owner/repo`, a URL to a folder (`https://github.com/owner/repo/tree/main/plugins/linear`), or `owner/repo@tag`. A repository may contain several plugins at the top level or under `plugins/`; all are installed. *Check for updates* compares the installed commit with the branch or tag it came from. When updates are available, it becomes *Update all*, showing the count. This updates every available plugin on its own tracked ref, regardless of the search filter. Updates run one at a time; failures are reported separately and can be retried.

Use **Update from…** on an installed plugin to change its branch, tag, or commit. The choice is remembered for subsequent updates, including when both refs point to the same commit. **Use default branch** returns to the repository's default branch. Only the selected plugin's files change; its dependents reload. Settings and connections remain in place. A failed activation restores the previous files and source, but cannot undo external side effects performed by plugin code.

Plugins run in Switchboard process with full access. Only install plugins you trust.
