# Switchboard: notes for working on it

Switchboard signs in to services once (Gmail, Outlook, GitHub, Jira, Home Assistant, any OAuth or API-key API) so scripts and AI agents use them through it with a Switchboard token, never their own credentials. Users, connections, plugins, a proxy, a web console, an activity log and an MCP server. The README is the user documentation; this file is what you need to change the code safely.

Deployment specifics of the maintainer's instance are in `CLAUDE.local.md` (git-ignored). Never put them in tracked files.

## Commands

    npm install && npm --prefix web install
    npm run dev                 # server on :8770; restarts on server changes, plugins hot-reload
    npm --prefix web run dev    # web app on :5173, proxies /api, /oauth, /proxy to :8770
    npm test                    # all tests (node --test test/*.test.ts)
    npx tsc --noEmit -p .       # server, plugins, tests
    cd web && npx tsc --noEmit && npx vite build
    just deploy                 # docker compose build && up -d (uses the untracked compose.yaml)

After `just deploy`, wait for the container to be `healthy` before checking the public URL: Traefik does not route to a container whose health check has not passed yet.

## Stack and layout

TypeScript run directly by **Node 24 type stripping**: no build step for `server/` or `plugins/`. Only erasable syntax (no enums, no parameter properties), and relative imports use `.ts` extensions. Hono, SQLite via `node:sqlite`, React 19 + Vite + Tailwind 4 in `web/`.

- `server/main.ts` routes and startup. `routes/` holds HTTP handlers: `account` (login, invites, tokens), `connections` (connect flows, proxy, call API, saved calls, audit, docs), `admin`, `provider` (Switchboard as an OAuth server).
- `server/connections.ts` connect flows (redirect, device, direct) and connection storage. `proxy.ts` executes requests (allowed hosts, auth, 401 retry, masking). `mcp.ts` the MCP server. `audit.ts` activity log, redaction, histogram. `openapi.ts` turns OpenAPI documents into console operations. `docs.ts` in-app guides. `self-openapi.ts` Switchboard's own API description (also the source of the generated API reference).
- `server/plugins/api.ts` is the **plugin contract**; `manager.ts` loads, orders and hot-reloads plugins; `github.ts` installs and updates them from GitHub.
- `plugins/` built-in plugins. Base plugins export method factories: `oauth2` (authorization code, device code, client credentials), `api-key` (bearer, header, query, basic), `google` (`googleService`), `microsoft` (`microsoftService`). Product plugins are small files on top of them.
- `docs/guides/*.md` Switchboard's guides, `docs/plugins.md` the plugin authoring guide (both shown in the app), `plugins/*/docs/*.md` guides contributed by plugins.
- `web/src/components/ui.tsx` the component kit (Button, Dialog, Menu, Tabs, CopyField, toasts, confirm). Use it rather than new one-off components.

## Invariants: keep these true

- **Credentials only go to a service's allowed hosts** (`allowedHosts`, default the base URL's host), checked again after a plugin's `authorize()` ran.
- **Secrets never reach the browser.** Fields of type `secret` are never returned (plugin settings report only `secretsSet`); credentials and config are encrypted at rest with `secret.key`. API tokens, sessions, invites and OAuth codes are stored only as SHA-256 hashes.
- **The activity log is redacted before it is written** (`audit.ts`: credentials the hub added, secret-looking names in query, headers and JSON or form bodies; `pageToken`-style cursors stay readable). Request bodies are kept up to 4 KB; response bodies are never stored.
- **Cookie-authenticated requests are same-origin only**: state-changing requests need `Sec-Fetch-Site: same-origin` (or a matching Origin), and cookie GETs to `/proxy/` from other sites are refused. All pages send `frame-ancestors 'none'`.
- **Tokens limited to connections** can only list and use those connections: no management, no activity log, no admin. **MCP OAuth tokens** (`audience = 'mcp'`) only work at `/mcp`.
- **OAuth provider** (`routes/provider.ts`): PKCE S256 required. Clients are a registered id (`swbc_…`), a Client ID Metadata Document (fetched and validated, private addresses refused unless the public URL is plain http), a same-origin URL client id (hub-to-hub), or an unregistered id only with a loopback redirect.
- **Plugins run with full access**, which is why only admins install them.

## Compatibility: the app was called Hub

Keep these working: `HUB_*` environment variables (read after `SWITCHBOARD_*`), `hub_` tokens next to `swb_`, the `X-Hub-Token` header, the `hub_session` cookie, `hub.db` (moved to `switchboard.db` once), registered OAuth client ids `hubc_…`. The hub-to-hub plugin and service are now `switchboard`; migration 5 moved existing rows.

## Changing things

- **Implementation checklist:** `development-plan.md` at the repository root. Keep development handoffs outside the end-user `docs/` directory.

- **Database:** migrations are an append-only list in `server/db.ts`. Never edit an existing one; add a new entry.
- **Plugins:** see `docs/plugins.md`. They may only `import type` from the hub or other plugins (erased at runtime); runtime access goes through `ctx.require()`. They cannot have their own `node_modules`. Each load imports a fresh copy of the plugin folder from `<data>/runtime/`; dependents reload with their dependency.
- **A service with several sign-in methods** gets one `authMethods` entry each. A method with `callback` is redirect-based, and gets the generic redirect-URI override (paste the address to complete) for free.
- **Microsoft Graph API reference** ships as slim JSON in `plugins/microsoft/openapi/`. Regenerate with `node --max-old-space-size=4096 plugins/microsoft/openapi/build.ts` (downloads the 44 MB description; parsing needs over 1 GB). Hand-written examples and the `/me/drive` aliases live in that script.
- **Guides:** Markdown with optional front matter (`title`, `services`, `dependents`, `excludeServices`, `order`, `adminOnly`). `{{publicUrl}}`, `{{mcpUrl}}`, `{{callbackUrl}}` are filled in; `\{{…}}` stays literal. Callouts: `> [!NOTE]` etc.
- **Charts:** the activity chart follows a validated palette (CSS variables `--series-*`, `--status-*` in `web/src/index.css`, light and dark). Don't eyeball new colors; validate them.
- **UI copy:** functional and short. No introductions or text describing the UI itself.
- **External APIs and client setups** (providers' OAuth details, MCP clients' config formats): check current documentation before writing them down, and say in the UI or docs when something could not be verified.

## Testing and verifying

- `test/switchboard.test.ts` starts a real server against a fake upstream that is also a fake OAuth provider, and covers most flows end to end. `github.test.ts` (in-process, mocked GitHub; deliberately uses the legacy `HUB_*` variables) and `microsoft.test.ts` (slim Graph descriptions) run in-process.
- For UI changes, look at the result: `playwright-core` with the system Chrome (`/usr/bin/google-chrome`) from a scratch directory, a throwaway instance (`SWITCHBOARD_DATA_DIR=<tmp> SWITCHBOARD_PORT=8771 SWITCHBOARD_PUBLIC_URL=http://localhost:8771`), light and dark, and a narrow viewport where layout matters.
- Before risky changes to stored data, rehearse the upgrade: run the previous commit (`git worktree add <tmp> HEAD`) on a scratch data dir, create data, then start the new code on it.

## Git

Commits are authored with the maintainer's GitHub noreply identity (set in this repository's git config) and end with a `Co-Authored-By` line for Claude. Before each commit, check the staged content for personal data and secrets: the maintainer's domain, names, email addresses and local paths; anything that looks like a token or key. `compose.yaml`, `docker-compose.dev.yml`, `.data/` and `CLAUDE.local.md` are git-ignored; only the `*.example.*` compose files are tracked.
