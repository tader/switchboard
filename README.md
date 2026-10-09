# Switchboard

> Switchboard was written entirely by Claude (Anthropic's Claude Opus 5.5, working in Claude Code), from the first line of code to these docs, at the request of [@tader](https://github.com/tader), who set the direction, tested it, and reported what to fix.

One place that signs in to services (Gmail, Outlook, Google Calendar, GitHub, any OAuth or API-key API) so scripts and agents don't each need their own OAuth client. Scripts call services through Switchboard with a Switchboard token; Switchboard adds credentials and refreshes tokens.

- Multiple users; each connects any number of accounts per service (e.g. several Gmail accounts).
- Services come from hot-reloadable plugins, which may depend on each other (`gmail` → `google` → `oauth2`).
- A service can offer several sign-in methods: personal access token, API key, basic auth, OAuth authorization code (with PKCE), OAuth device code, client credentials.
- Web console to build calls (method, URL, query, headers, body), browse the service's OpenAPI description, and save calls for reuse.
- Admins install and update plugins from GitHub and manage users.
- Satellites expose plugins on intermittently connected private machines through an outbound WebSocket; connections remain per-user and credentials remain on that machine.

## Run

    cp compose.example.yaml compose.yaml    # then set your domain and reverse proxy labels
    just deploy        # docker compose build && up -d
    just setup-link    # one-time link to set the admin password

`compose.example.yaml` assumes Traefik on an external `traefik` network with a `letsencrypt` resolver; adjust it to your setup. `compose.yaml` and `docker-compose.dev.yml` are ignored by git, so your own domain stays out of the repository.

On first start, and whenever no administrator can sign in, the log contains a setup link for `SWITCHBOARD_ADMIN_USERNAME` valid for 24 hours. Restarting prints a fresh one. Other users are added on the Users page and get a one-time invite link.

### Configuration

| Variable | Default | |
|---|---|---|
| `SWITCHBOARD_PUBLIC_URL` | `http://localhost:8770` | Address browsers use. OAuth redirect URI is `<SWITCHBOARD_PUBLIC_URL>/oauth/callback`. |
| `SWITCHBOARD_DATA_DIR` | `.data` (`/data` in the image) | Database, encryption key, installed plugins. |
| `SWITCHBOARD_SECRET_KEY` | generated in the data dir | 32 bytes (hex or base64) used to encrypt credentials at rest. |
| `SWITCHBOARD_ADMIN_USERNAME` | `admin` | Who the setup link is for. |
| `SWITCHBOARD_GITHUB_TOKEN` | | For installing plugins from private repos and higher rate limits. |
| `SWITCHBOARD_PORT` / `SWITCHBOARD_HOST` | `8770` / `0.0.0.0` | |
| `SWITCHBOARD_SESSION_TTL_SECS` | 14 days | |
| `SWITCHBOARD_WATCH_PLUGINS` | `true` | Reload plugins when their files change. |
| `SWITCHBOARD_AUDIT_RETENTION_DAYS` | `90` | How long the activity log is kept; `0` keeps it forever. |
| `SWITCHBOARD_SATELLITE_CENTRAL_URL` | | First-start bootstrap for one upstream URL; later changes are managed in the UI. |
| `SWITCHBOARD_SATELLITE_TOKEN` | | First-start bootstrap token created on the upstream's Satellites page; grants are selected locally. |

Switchboard was called Hub before: `HUB_*` variables, `hub_` tokens, the `X-Hub-Token` header and an existing `hub.db` keep working.

Back up the data dir. Without `secret.key` (or `SWITCHBOARD_SECRET_KEY`) stored credentials cannot be decrypted.

### Satellites

A satellite owns its connections and explicitly shares selected connections with each upstream. On the upstream, add the machine under **Satellites** and copy its device token. On the private instance, use **Satellites → Upstreams → Add upstream**, enter the upstream URL and token, then create connections locally and choose **Share with upstreams** from each connection's menu. Multiple upstreams can receive different selections.

Allowed users on an upstream receive read-only handles automatically. They can execute shared HTTP and MCP connections and browse their OpenAPI descriptions, but cannot create, rename, reconnect or delete connections on the satellite. Credentials and configuration remain local. Activity records identify the local owner, upstream and requesting upstream user. Revocation cancels active requests. Offline calls fail immediately with `503` and `satellite_offline`.

A received connection may be explicitly shared onward. Each hop enforces its own grants; instance routes prevent cycles and limit a request to eight hops. All connected instances must support satellite protocol 2. The old environment variables bootstrap one upstream on first startup only; they do not grant any connections. During upgrade, legacy satellite shadow-owned connections are assigned to the oldest active local administrator and remain unshared until that owner selects upstreams.

#### Run a satellite without Docker

Install Node.js 24, then build Switchboard from a checkout:

```bash
npm ci
npm --prefix web ci
npm --prefix web run build
```

Create the machine under **Satellites** on the central Switchboard and copy the token it shows. Start the local instance with a separate persistent data directory and bind it to loopback:

```bash
export SWITCHBOARD_HOST=127.0.0.1
export SWITCHBOARD_PORT=8770
export SWITCHBOARD_PUBLIC_URL=http://127.0.0.1:8770
export SWITCHBOARD_DATA_DIR="$HOME/.local/share/switchboard-satellite"

export SWITCHBOARD_SATELLITE_CENTRAL_URL=https://switchboard.example.com
export SWITCHBOARD_SATELLITE_TOKEN='sws_…'

npm start
```

The local UI is then available only on that machine at `http://127.0.0.1:8770`. Open the setup link printed on first start to create its local administrator. Machine-specific plugins are configured in this local UI; for example, install **Shell command** from **Plugins → Community**, then enable **Allow shell commands** under **Plugins → Shell command → Settings** before the Shell command service is advertised upstream.

The satellite needs only outbound HTTPS/WebSocket access to the central URL. No inbound firewall or router port is required. For unattended use, put the variables in a permission-restricted service configuration and run Switchboard as a dedicated low-privilege OS user. Shell commands execute with that user's filesystem permissions.

### Installing and setting up services

Switchboard includes **MCP**, **API Keys**, and **OAuth**. Install other services from **Plugins → Community** first. Google and Microsoft app plugins automatically install their shared provider plugin. Setup guides appear after installation.

- **Google** (Gmail, Calendar, Drive, Docs, Sheets, Google APIs): create a *Web application* OAuth client in the Google Cloud console, add the redirect URI shown in *Plugins → Google → Settings*, and enter the client id and secret there. Enable each API you use (Gmail, Calendar, Drive, Docs, Sheets) in the same Cloud project. While the consent screen is in testing, add each Google account as a test user. Users can also bring their own client under *Advanced* when connecting.
- **Home Assistant**: no setup. Sign in through the browser (Switchboard's URL is the OAuth client id, as Home Assistant expects) or paste a long-lived token. The URL must be reachable from Switchboard container; `.local` names usually aren't, so use an IP or hostname.
- **Jira / Confluence / Bitbucket**: install [tader/switchboard-plugin-atlassian](https://github.com/tader/switchboard-plugin-atlassian) through *Plugins → Install from GitHub*. Cloud API tokens and Data Center personal access tokens work without administrator OAuth setup; the repository includes setup guides for cloud sign-in.
- **Todoist**: API tokens work without setup; for browser sign-in create an app in the Todoist App Management Console.
- **Spotify**: create an app at developer.spotify.com/dashboard (Web API), add the redirect URI, and add each user under *User Management* while the app is in development mode. The client secret is only needed for *App only* access.
- **Plex**: no setup. Sign in through plex.tv, with a code at plex.tv/link, or with a token. Switchboard picks the first of your servers it can reach (local HTTPS first); set *Server URL* under *Advanced* to choose one.
- **Microsoft 365 and Outlook.com** (Outlook Mail, Outlook Calendar, OneDrive, Microsoft To Do, Microsoft Graph): create an app registration in the Microsoft Entra admin center and enter it under *Plugins → Microsoft → Settings*. Browser sign-in needs a client secret; sign-in with a code needs *Allow public client flows*. See *Docs → Setting up Microsoft sign-in*. The API reference uses slim descriptions built from Microsoft's 44 MB one by the [Microsoft plugin build tool](https://github.com/tader/switchboard-plugin-microsoft/blob/main/plugins/microsoft/openapi/build.ts).
- **Google Keep**: Google only offers the Keep API to Google Workspace, and its consent screen never shows the Keep scopes (`invalid_scope`, "Some requested scopes cannot be shown"; intended behavior per Google), so it connects only with a *Service account*: a Workspace admin authorizes the service account's client id for the Keep scopes under *Security → API controls → Domain-wide delegation*, and you paste its JSON key and the user to act as. The generic *Google APIs* service offers service accounts too.
- **Switchboard**: connect to another Switchboard with one of its API tokens, or *Sign in with Switchboard*: the other Switchboard asks you to approve and which connections to share, then issues a token. No setup on either side.
- **GitHub**: personal access tokens work without setup. For browser sign-in and sign-in with a code, create a GitHub OAuth app (enable device flow for the latter) and enter it in *Plugins → GitHub → Settings*.

## Using it from scripts

Create a token on the *API tokens* page, ideally one per script, limited to the connections it needs. Pass it as `Authorization: Bearer swb_…` (or `X-Switchboard-Token`). Connections are referenced by id or name (e.g. `gmail-work`).

**Proxy**: any method, path relative to the service's base URL (or an absolute URL on an allowed host). Request and response are passed through.

    curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \
      https://switchboard.example.com/proxy/gmail-work/gmail/v1/users/me/messages?maxResults=5

**Access token** for provider SDKs (refreshed as needed; ask again instead of storing it):

    curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" https://switchboard.example.com/api/connections/gmail-work/token
    # {"access_token":"ya29…","token_type":"Bearer","expires_at":1791279999000}

**JSON call** returning status, headers and body in an envelope:

    curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H 'content-type: application/json' https://switchboard.example.com/api/call -d '{
      "connection": "github-me", "method": "GET", "url": "/repos/{owner}/{repo}/issues",
      "pathParams": {"owner": "octocat", "repo": "hello-world"}, "query": {"state": "open"}
    }'

**Saved calls** run by id or name; the JSON body may override `connection`, `pathParams`, `query`, `headers` and `body`:

    curl -X POST -H "Authorization: Bearer $SWITCHBOARD_TOKEN" https://switchboard.example.com/api/calls/Unread%20mail/run -d '{"query":{"maxResults":"20"}}'

Credentials are only attached to the hosts a service allows (for Gmail `gmail.googleapis.com` and `www.googleapis.com`); requests to other hosts are refused.

### MCP

Connect upstream MCP servers from the Connections page using OAuth, bearer tokens, API-key headers or no authentication. The console provides Tools, Resources and Prompts with rich results and saved requests. Connections can switch between the original grouped cards (Normal) and a compact table, with the choice remembered in the browser. Both views are searchable; plugins use a compact searchable table.

`https://switchboard.example.com/mcp` is an MCP server (Streamable HTTP; protocol 2026-07-28, and the `initialize`-based 2025-03-26 to 2025-11-25 for older clients). Its tools: `list_connections`, `search_operations` and `get_operation` (from the service's API reference), structured `call_operation`, lower-level `call`, `list_saved_calls`, and `run_saved_call`. MCP connections add `search_mcp_tools`, `get_mcp_tool`, `call_mcp_tool`, resource/prompt tools and native resources, templates, prompts and completions namespaced by immutable connection ID. They act as the token's user, only on the token's connections, and show up in Activity as source *MCP*.

    claude mcp add --transport http switchboard https://switchboard.example.com/mcp            # signs in through the browser
    claude mcp add --transport http switchboard https://switchboard.example.com/mcp --header "Authorization: Bearer $SWITCHBOARD_TOKEN"

In Claude Desktop or claude.ai, add a custom connector with the URL. Clients sign in with OAuth: Switchboard publishes protected resource metadata (`/.well-known/oauth-protected-resource/mcp`) and authorization server metadata (`/.well-known/oauth-authorization-server`), and accepts Client ID Metadata Documents and dynamic client registration (`/oauth/register`). The consent page lets you choose which connections to share. Tokens issued this way are bound to the MCP endpoint (they are refused by the rest of the API) and listed on the API tokens page, where they can be revoked.

### API

Everything in the web app is available with a token that has full access (tokens limited to connections can only list and use those).

| | |
|---|---|
| `GET /api/me`, `GET /api/services` | Who you are; services and their sign-in methods and fields |
| `GET /api/connections`, `GET/PATCH/DELETE /api/connections/:ref` | Connections; `PATCH {"name"}` renames |
| `POST /api/connections` `{service, method, config, name?}` | Connect. Returns `connected`, `redirect` (open `url` in a browser) or `device` (show `device.userCode`, then `POST /api/connect/:flowId/poll` until connected) |
| `POST /api/connections/:ref/reconnect` | Same, for an existing connection |
| `POST /api/connect/:flowId/complete` `{url}` | Complete a sign-in started with `redirectUri` (a redirect URI other than Switchboard's, e.g. localhost) with the address the browser was sent to |
| `POST /api/connections/:ref/mcp/:operation` | Tools, resources, prompts and completions on an MCP connection |
| `GET /api/connections/:ref/openapi` | Operations from the service's OpenAPI description |
| `ANY /proxy/:ref/*`, `POST /api/call`, `GET /api/connections/:ref/token` | See above |
| `GET/POST /api/calls`, `GET/PUT/DELETE /api/calls/:id`, `POST /api/calls/:id/run` | Saved calls |
| `GET/POST /api/tokens`, `PATCH/DELETE /api/tokens/:id` | API tokens |
| `GET /api/admin/plugins`, `GET /api/admin/plugins/:id` (with log) | Admin: plugins |
| `POST /api/admin/plugins/install` `{repo, ref?, path?, githubConnectionId?}`, `POST /api/admin/plugins/check-updates`, `POST /api/admin/plugins/:id/update` `{ref?, githubConnectionId?}` | Install/update from GitHub; omit update ref to keep it or use `null` for the default branch. Select your local GitHub connection or use automatic access |
| `GET /api/admin/plugins/community` | Live community catalog, fetched at runtime |
| `POST /api/admin/plugins/install/plan`, `POST /api/admin/plugins/update/plan`, `POST /api/admin/plugins/apply` `{planId}` | Preview and apply plugin/dependency changes; [request formats](docs/plugins.md#installation-api) |
| `POST /api/admin/plugins/:id/reload`, `PATCH /api/admin/plugins/:id` `{enabled}`, `GET/PUT /api/admin/plugins/:id/settings`, `DELETE /api/admin/plugins/:id` | |
| `GET/POST /api/admin/users`, `PATCH/DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/invite` | Admin: users |
| `GET/POST /api/admin/satellites`, `GET/PATCH/DELETE /api/admin/satellites/:id`, `POST /api/admin/satellites/:id/rotate-token` | Admin: outbound satellite enrolment, user access and credential rotation |
| `GET /api/audit`, `GET /api/audit/:id`, `GET /api/audit/facets`, `GET /api/audit/histogram?by=…` | Activity log. Filters: `connection`, `client` (token id or `web`), `status` (`2xx`…`5xx`, `error` or a code), `method`, `source`, `q`, `from`/`to` (ms); `sort` (`time`, `duration`, `status`, `size`), `order`, `limit`, `offset`. Not readable with tokens limited to connections. |
| `DELETE /api/me/token` | Revoke the token making the request |
| `GET /api/openapi.json` | OpenAPI description of this API |

### Switchboard as an OAuth provider

Apps (such as another Switchboard or an MCP client) can get a Switchboard token by sending the user to `/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `state` and a PKCE `code_challenge` (`S256`), optionally with `resource` (`<switchboard>/mcp` for a token bound to the MCP endpoint). The `client_id` is one of: a registered id from `POST /oauth/register`; an https URL of a Client ID Metadata Document listing the redirect URIs; or the app's own URL, with `redirect_uri` on the same origin (how Switchboards connect to each other). Loopback redirect URIs may use any port. The user approves and picks which connections to share; then `POST /oauth/token` with `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri` and `code_verifier` returns `{access_token, token_id}`. Clients are not registered: the consent page shows the client's host. Tokens issued this way are listed on the API tokens page.

### Activity

Every request through Switchboard is logged per user, whether it goes through the proxy, the call API, a saved call or the console. So is every raw access token handed out: requests made with that token go to the service directly and do not appear afterwards. MCP entries also record operation, target and outcome, including `isError` failures. Each entry records time, client (API token or web console), connection, method, URL, status, duration and sizes, IP and user agent, plus the request headers and the first 4 KB of the request body. Secrets are masked before anything is stored: credentials Switchboard added, and values with secret-looking names (token, secret, password, api_key, …) in query strings, headers and JSON or form bodies. Response bodies are not kept. Browse it on the *Activity* page, or from a connection's or token's menu. A stacked chart above the table shows requests over time, broken down by connection, client, method, status or URL (ids in paths are grouped as `{id}`); drag across it, or click a column, to zoom in, which also filters the table.

### Docs

The web app has guides under *Docs*: using Switchboard from AI assistants (Claude, Codex, Copilot, OpenCode), the Switchboard API with a reference generated from its OpenAPI description, and setup guides that plugins ship in their `docs/` folder (for example Google sign-in and Google Keep). Switchboard's own guides live in `docs/guides/`.

## Separately maintained plugins

The 19 provider and machine-specific plugins previously bundled here now each have a repository named `tader/switchboard-plugin-<id>`. Find them in the live [community catalog](https://github.com/tader/switchboard-plugins). This includes GitHub, Google and its apps, Microsoft and its apps, Home Assistant, Plex, Spotify, Todoist, Shell command, and Switchboard-to-Switchboard connections.

**Before upgrading an existing instance, install its used plugins from Community, including plugins used on satellites.** **Install the shared Google or Microsoft plugin explicitly as well when using their apps.** An older Switchboard may reuse its bundled helper when installing an app; that helper also needs an installed copy before upgrading. Installed copies take precedence over built-ins. Their plugin IDs, service IDs, authentication methods, settings, credentials and persistent data directories are preserved; keep the instance data directory and encryption key. Missing plugins leave connections unavailable until the plugin is installed again. Do not delete or reconnect them solely for this move.

Install **GitHub** first if you use saved GitHub connections to access private plugin repositories. Public installation also works without a GitHub connection; `SWITCHBOARD_GITHUB_TOKEN` remains available for bootstrap access.

## Atlassian plugins

Jira, Confluence and Bitbucket are maintained in [tader/switchboard-plugin-atlassian](https://github.com/tader/switchboard-plugin-atlassian). Install that repository through **Plugins → Install from GitHub**.

**Install the external Atlassian plugin before upgrading a Switchboard that uses built-in Jira or Confluence.** It keeps the `atlassian` plugin ID, `jira`/`confluence` service IDs, authentication methods and saved OAuth settings. Installed plugins take precedence over built-ins during the transition. Existing connections and saved calls remain valid; do not delete or reconnect them solely for this move.

## macOS plugins

Apple Reminders, Apple Mail and Apple Calendar are maintained in [tader/switchboard-plugin-macos](https://github.com/tader/switchboard-plugin-macos). Install that repository through **Plugins → Install from GitHub** on the Mac running the services, including a Mac satellite when the main instance runs elsewhere.

**Before upgrading an existing Apple Reminders installation, install the external repository on every Mac providing Reminders.** It replaces the built-in plugin using the same `apple-reminders` service ID, `eventkit` authentication method and persistent data directory. Existing connections and credentials remain valid; do not delete or reconnect them. The external installed plugin takes precedence over the built-in one during the transition.

Mail and Calendar require macOS 14+, Node 24+, Xcode Command Line Tools and the logged-in user's session. See the external repository's setup guides and validation record for permission requirements and current limitations.

## Plugins

See [docs/plugins.md](docs/plugins.md). Built-in plugins live in `plugins/`; plugins installed from GitHub go to `<data>/plugins/` and take precedence over a built-in plugin with the same id.

**Plugins → Community** browses the live [community catalog](https://github.com/tader/switchboard-plugins); open it or click **Refresh** to fetch current listings. Private repository installation can use your saved GitHub connections automatically or a connection you select. Successful choices are remembered for updates. Missing plugin dependencies are installed recursively; optional `dependencyVersions` semver ranges are checked before installation and during loading.

Use **Plugins → Actions → Update from…** to test an installed plugin from another branch, tag, or commit. Future updates follow that ref. Choose **Use default branch** to return to the repository default. Installation and updates preview changes before applying them, including shared dependency upgrades and affected plugins. **Update all** coordinates available updates on their individual tracked refs. If activation fails, Switchboard restores every changed plugin's previous files and metadata; plugin code's external side effects cannot be undone.

## Development

    npm install && npm --prefix web install
    npm run dev                 # server on :8770, restarts on server changes; plugins hot-reload
    npm --prefix web run dev    # web app on :5173 with API proxy
    npm test

Or `just dev` for a container (port 8771) that mounts the repository; copy `docker-compose.dev.example.yml` to `docker-compose.dev.yml` first.

Stack: TypeScript run directly by Node 24 (type stripping, no build step), Hono, SQLite (`node:sqlite`), React + Vite + Tailwind for `web/`.

### Published images and releases

GitHub Actions builds `ghcr.io/tader/switchboard` for Linux amd64 and arm64. `edge` follows validated main commits; `sha-<commit>` identifies their exact source. Stable releases publish `<version>` and the current stable release also updates `latest`. Pull requests build and smoke-test images without publishing. Use a persistent volume at `/data`:

```sh
docker run -d --name switchboard -p 8770:8770 -v switchboard-data:/data ghcr.io/tader/switchboard:edge
```

Release-please opens a release PR from Conventional Commits (`fix:` bumps patch, `feat:` bumps minor, `feat!:` signals breaking changes). Merge that PR to update versions and changelogs and create the GitHub release. Switchboard's release workflow calls the Docker publisher directly, so releases created with `GITHUB_TOKEN` still publish images. Enable **Allow GitHub Actions to create and approve pull requests** in each active repository's Actions settings. No personal access token secret is needed.

Google, Microsoft, Atlassian and macOS plugins have independent release components within their family repositories; their `plugin.json` versions are updated together with their component package manifests. The community catalog is unversioned and always read from main.
