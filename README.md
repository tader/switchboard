# Hub

> Hub was written entirely by Claude (Anthropic's Claude Opus 5.5, working in Claude Code), from the first line of code to these docs, at the request of [@tader](https://github.com/tader), who set the direction, tested it, and reported what to fix.

One place that signs in to services (Gmail, Google Calendar, GitHub, any OAuth or API-key API) so scripts and agents don't each need their own OAuth client. Scripts call services through the hub with a hub token; the hub adds credentials and refreshes tokens.

- Multiple users; each connects any number of accounts per service (e.g. several Gmail accounts).
- Services come from hot-reloadable plugins, which may depend on each other (`gmail` → `google` → `oauth2`).
- A service can offer several sign-in methods: personal access token, API key, basic auth, OAuth authorization code (with PKCE), OAuth device code, client credentials.
- Web console to build calls (method, URL, query, headers, body), browse the service's OpenAPI description, and save calls for reuse.
- Admins install and update plugins from GitHub and manage users.

## Run

    cp compose.example.yaml compose.yaml    # then set your domain and reverse proxy labels
    just deploy        # docker compose build && up -d
    just setup-link    # one-time link to set the admin password

`compose.example.yaml` assumes Traefik on an external `traefik` network with a `letsencrypt` resolver; adjust it to your setup. `compose.yaml` and `docker-compose.dev.yml` are ignored by git, so your own domain stays out of the repository.

On first start, and whenever no administrator can sign in, the log contains a setup link for `HUB_ADMIN_USERNAME` valid for 24 hours. Restarting prints a fresh one. Other users are added on the Users page and get a one-time invite link.

### Configuration

| Variable | Default | |
|---|---|---|
| `HUB_PUBLIC_URL` | `http://localhost:8770` | Address browsers use. OAuth redirect URI is `<HUB_PUBLIC_URL>/oauth/callback`. |
| `HUB_DATA_DIR` | `.data` (`/data` in the image) | Database, encryption key, installed plugins. |
| `HUB_SECRET_KEY` | generated in the data dir | 32 bytes (hex or base64) used to encrypt credentials at rest. |
| `HUB_ADMIN_USERNAME` | `admin` | Who the setup link is for. |
| `HUB_GITHUB_TOKEN` | | For installing plugins from private repos and higher rate limits. |
| `HUB_PORT` / `HUB_HOST` | `8770` / `0.0.0.0` | |
| `HUB_SESSION_TTL_SECS` | 14 days | |
| `HUB_WATCH_PLUGINS` | `true` | Reload plugins when their files change. |
| `HUB_AUDIT_RETENTION_DAYS` | `90` | How long the activity log is kept; `0` keeps it forever. |

Back up the data dir. Without `secret.key` (or `HUB_SECRET_KEY`) stored credentials cannot be decrypted.

### Setting up Google and GitHub

- **Google** (Gmail, Calendar, Drive, Docs, Sheets, Google APIs): create a *Web application* OAuth client in the Google Cloud console, add the redirect URI shown in *Plugins → Google → Settings*, and enter the client id and secret there. Enable each API you use (Gmail, Calendar, Drive, Docs, Sheets) in the same Cloud project. While the consent screen is in testing, add each Google account as a test user. Users can also bring their own client under *Advanced* when connecting.
- **Home Assistant**: no setup. Sign in through the browser (the hub's URL is the OAuth client id, as Home Assistant expects) or paste a long-lived token. The URL must be reachable from the hub container; `.local` names usually aren't, so use an IP or hostname.
- **Jira / Confluence**: API tokens (cloud, with your email) and personal access tokens (Data Center) work without setup. For *Sign in with Atlassian*, create an OAuth 2.0 (3LO) app at developer.atlassian.com/console, add the redirect URI and the scopes (Jira and Confluence each request their own; see the method's *Advanced* section), and enter it under *Plugins → Atlassian → Settings*.
- **Todoist**: API tokens work without setup; for browser sign-in create an app in the Todoist App Management Console.
- **Spotify**: create an app at developer.spotify.com/dashboard (Web API), add the redirect URI, and add each user under *User Management* while the app is in development mode. The client secret is only needed for *App only* access.
- **Plex**: no setup. Sign in through plex.tv, with a code at plex.tv/link, or with a token. The hub picks the first of your servers it can reach (local HTTPS first); set *Server URL* under *Advanced* to choose one.
- **Google Keep**: Google only offers the Keep API to Google Workspace, and its consent screen never shows the Keep scopes (`invalid_scope`, "Some requested scopes cannot be shown"; intended behavior per Google), so it connects only with a *Service account*: a Workspace admin authorizes the service account's client id for the Keep scopes under *Security → API controls → Domain-wide delegation*, and you paste its JSON key and the user to act as. The generic *Google APIs* service offers service accounts too.
- **Hub**: connect to another hub with one of its API tokens, or *Sign in with Hub*: the other hub asks you to approve and which connections to share, then issues a token. No setup on either side.
- **GitHub**: personal access tokens work without setup. For browser sign-in and sign-in with a code, create a GitHub OAuth app (enable device flow for the latter) and enter it in *Plugins → GitHub → Settings*.

## Using it from scripts

Create a token on the *API tokens* page, ideally one per script, limited to the connections it needs. Pass it as `Authorization: Bearer hub_…` (or `X-Hub-Token`). Connections are referenced by id or name (e.g. `gmail-work`).

**Proxy**: any method, path relative to the service's base URL (or an absolute URL on an allowed host). Request and response are passed through.

    curl -H "Authorization: Bearer $HUB_TOKEN" \
      https://hub.example.com/proxy/gmail-work/gmail/v1/users/me/messages?maxResults=5

**Access token** for provider SDKs (refreshed as needed; ask again instead of storing it):

    curl -H "Authorization: Bearer $HUB_TOKEN" https://hub.example.com/api/connections/gmail-work/token
    # {"access_token":"ya29…","token_type":"Bearer","expires_at":1791279999000}

**JSON call** returning status, headers and body in an envelope:

    curl -H "Authorization: Bearer $HUB_TOKEN" -H 'content-type: application/json' https://hub.example.com/api/call -d '{
      "connection": "github-me", "method": "GET", "url": "/repos/{owner}/{repo}/issues",
      "pathParams": {"owner": "octocat", "repo": "hello-world"}, "query": {"state": "open"}
    }'

**Saved calls** run by id or name; the JSON body may override `connection`, `pathParams`, `query`, `headers` and `body`:

    curl -X POST -H "Authorization: Bearer $HUB_TOKEN" https://hub.example.com/api/calls/Unread%20mail/run -d '{"query":{"maxResults":"20"}}'

Credentials are only attached to the hosts a service allows (for Gmail `gmail.googleapis.com` and `www.googleapis.com`); requests to other hosts are refused.

### MCP

`https://hub.example.com/mcp` is an MCP server (Streamable HTTP; protocol 2026-07-28, and the `initialize`-based 2025-03-26 to 2025-11-25 for older clients). Its tools: `list_connections`, `search_operations` and `get_operation` (from the service's API reference), `call`, `list_saved_calls`, `run_saved_call`. They act as the token's user, only on the token's connections, and show up in Activity as source *MCP*.

    claude mcp add --transport http hub https://hub.example.com/mcp            # signs in through the browser
    claude mcp add --transport http hub https://hub.example.com/mcp --header "Authorization: Bearer $HUB_TOKEN"

In Claude Desktop or claude.ai, add a custom connector with the URL. Clients sign in with OAuth: the hub publishes protected resource metadata (`/.well-known/oauth-protected-resource/mcp`) and authorization server metadata (`/.well-known/oauth-authorization-server`), and accepts Client ID Metadata Documents and dynamic client registration (`/oauth/register`). The consent page lets you choose which connections to share. Tokens issued this way are bound to the MCP endpoint (they are refused by the rest of the API) and listed on the API tokens page, where they can be revoked.

### API

Everything in the web app is available with a token that has full access (tokens limited to connections can only list and use those).

| | |
|---|---|
| `GET /api/me`, `GET /api/services` | Who you are; services and their sign-in methods and fields |
| `GET /api/connections`, `GET/PATCH/DELETE /api/connections/:ref` | Connections; `PATCH {"name"}` renames |
| `POST /api/connections` `{service, method, config, name?}` | Connect. Returns `connected`, `redirect` (open `url` in a browser) or `device` (show `device.userCode`, then `POST /api/connect/:flowId/poll` until connected) |
| `POST /api/connections/:ref/reconnect` | Same, for an existing connection |
| `GET /api/connections/:ref/openapi` | Operations from the service's OpenAPI description |
| `ANY /proxy/:ref/*`, `POST /api/call`, `GET /api/connections/:ref/token` | See above |
| `GET/POST /api/calls`, `GET/PUT/DELETE /api/calls/:id`, `POST /api/calls/:id/run` | Saved calls |
| `GET/POST /api/tokens`, `PATCH/DELETE /api/tokens/:id` | API tokens |
| `GET /api/admin/plugins`, `GET /api/admin/plugins/:id` (with log) | Admin: plugins |
| `POST /api/admin/plugins/install` `{repo, ref?, path?}`, `POST /api/admin/plugins/check-updates`, `POST /api/admin/plugins/:id/update` | Install/update from GitHub |
| `POST /api/admin/plugins/:id/reload`, `PATCH /api/admin/plugins/:id` `{enabled}`, `GET/PUT /api/admin/plugins/:id/settings`, `DELETE /api/admin/plugins/:id` | |
| `GET/POST /api/admin/users`, `PATCH/DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/invite` | Admin: users |
| `GET /api/audit`, `GET /api/audit/:id`, `GET /api/audit/facets` | Activity log. Filters: `connection`, `client` (token id or `web`), `status` (`2xx`…`5xx`, `error` or a code), `method`, `source`, `q`, `from`/`to` (ms); `sort` (`time`, `duration`, `status`, `size`), `order`, `limit`, `offset`. Not readable with tokens limited to connections. |
| `DELETE /api/me/token` | Revoke the token making the request |
| `GET /api/openapi.json` | OpenAPI description of this API |

### Hub as an OAuth provider

Apps (such as another hub or an MCP client) can get a hub token by sending the user to `/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `state` and a PKCE `code_challenge` (`S256`), optionally with `resource` (`<hub>/mcp` for a token bound to the MCP endpoint). The `client_id` is one of: a registered id from `POST /oauth/register`; an https URL of a Client ID Metadata Document listing the redirect URIs; or the app's own URL, with `redirect_uri` on the same origin (how hubs connect). Loopback redirect URIs may use any port. The user approves and picks which connections to share; then `POST /oauth/token` with `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri` and `code_verifier` returns `{access_token, token_id}`. Clients are not registered: the consent page shows the client's host. Tokens issued this way are listed on the API tokens page.

### Activity

Every request through the hub is logged per user, whether it goes through the proxy, the call API, a saved call or the console. So is every raw access token handed out: requests made with that token go to the service directly and do not appear afterwards. Each entry records time, client (API token or web console), connection, method, URL, status, duration and sizes, IP and user agent, plus the request headers and the first 4 KB of the request body. Secrets are masked before anything is stored: credentials the hub added, and values with secret-looking names (token, secret, password, api_key, …) in query strings, headers and JSON or form bodies. Response bodies are not kept. Browse it on the *Activity* page, or from a connection's or token's menu.

### Docs

The web app has guides under *Docs*: using Hub from AI assistants (Claude, Codex, Copilot, OpenCode), the Hub API with a reference generated from its OpenAPI description, and setup guides that plugins ship in their `docs/` folder (for example Google sign-in and Google Keep). Hub's own guides live in `docs/guides/`.

## Plugins

See [docs/plugins.md](docs/plugins.md). Built-in plugins live in `plugins/`; plugins installed from GitHub go to `<data>/plugins/` and take precedence over a built-in plugin with the same id.

## Development

    npm install && npm --prefix web install
    npm run dev                 # server on :8770, restarts on server changes; plugins hot-reload
    npm --prefix web run dev    # web app on :5173 with API proxy
    npm test

Or `just dev` for a container (port 8771) that mounts the repository; copy `docker-compose.dev.example.yml` to `docker-compose.dev.yml` first.

Stack: TypeScript run directly by Node 24 (type stripping, no build step), Hono, SQLite (`node:sqlite`), React + Vite + Tailwind for `web/`.
