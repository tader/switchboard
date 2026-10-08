# Plugin branches and upstream MCP connections

This is the implementation checklist and handoff record. Update it as work is
completed. Do not mark verification or deployment complete without evidence.

## User decisions and order

- Implement plugin branch switching first, verify it, and deploy it to the
  existing instance **before starting MCP implementation**.
- Then implement HTTP MCP connections with **tools, resources, and prompts
  together**, supporting **OAuth, API keys, and unauthenticated servers**.
- Maintain this file so another agent can resume without the chat history.
- Read `CLAUDE.md` and the untracked `CLAUDE.local.md` for repository and local
  deployment instructions. Do not copy private deployment information here.
- Existing untracked `AGENTS.md` belongs to the user; leave it alone.

## Current handoff

- Phase: MCP implementation and compact connection/plugin tables complete;
  delivery checks passed. Deployment is the next action.
- Previous deployment: branch feature from `eefe061`; MCP not yet deployed.
- No additional user decisions are needed for the agreed scope.
- Plan moved to the repository root, outside end-user documentation.

## 1. Plugin update branch

- [x] Inspect current installation, update, reload, admin route, and UI flows.
- [x] Record the plan and resumable checklist.
- [x] Extend `POST /api/admin/plugins/:id/update` with optional `{ ref }`:
  omitted keeps the tracked ref; a nonempty string switches branch/tag/commit;
  `null` tracks the repository default branch. Reject malformed input.
- [x] Persist the ref even when the resolved commit is unchanged. Reuse existing
  `plugins.source` JSON; no migration for this feature.
- [x] Validate manifest and expected plugin ID before changing installed files.
  Serialize competing updates and restore files/source after activation failure.
  Preserve settings, connections, and unrelated plugins.
- [x] Add “Update from…” dialog, explicit default-branch selection, tracked ref
  plus commit display, accurate success messages, and update-cache invalidation.
- [x] Add regression tests for ref switching/default reset, slash refs, pinned
  tags/commits, same-commit changes, malformed/missing refs, ID mismatch, failed
  activation/recovery, and concurrent updates.
- [x] Update README, plugin guide, and self OpenAPI.
- [x] Pass tests, server typecheck, and production web build.
- [x] Inspect actual UI using scratch data in light/dark and narrow layouts.
- [x] Deploy with `just deploy`; wait for healthy, then check the public URL.
- [x] Record deployed revision/build and verification here before MCP work.

## 2. MCP core and authentication

- [x] Verify current official MCP specification/SDK compatibility; pin a
  suitable released SDK. Check Node runtime compatibility.
- [x] Add an HTTP/MCP discriminator to service/connection views and persistent
  connections (append-only migration, existing connections default to HTTP).
- [x] Provide an MCP service with exact endpoint URL and OAuth, bearer-token,
  API-key-header, and unauthenticated methods. Keep plugins compatible with the
  type-only import rule and use core helpers through plugin context as needed.
- [x] Implement a shared upstream MCP client/execution layer with Streamable
  HTTP JSON/SSE, modern 2026-07-28 and legacy 2025 negotiation, capability-aware
  calls, bounded pagination/results/timeouts, cancellation, and session cleanup.
- [x] Isolate clients and discovery caches by user, connection, endpoint, and
  authentication state; invalidate on reconnect/delete/plugin changes/shutdown.
- [x] Implement OAuth resource/issuer discovery, client metadata/pre-registration/
  dynamic registration as supported, PKCE, state/issuer validation, resource
  indicators, encrypted pending state/tokens, serialized refresh, and reconnect
  for renewed consent. Never forward a Switchboard token upstream.
- [x] Apply credential-host checks before/after authorization; validate redirects
  and discovered endpoints while allowing explicitly configured private servers.
- [x] Avoid automatically replaying mutating calls after ambiguous failures.

## 3. MCP surfaces and parity

- [x] Add connection-scoped HTTP endpoints for tools list/search/inspect/call,
  resources list/templates/read, prompts list/get, and supported completions.
- [x] Enforce ownership and token connection restrictions on every operation.
- [x] Add console Tools/Resources/Prompts views with schemas, arguments, rich
  results, text/binary resource previews, prompt messages, and distinct errors.
- [x] Extend Switchboard's MCP tools with connection-scoped discovery/invocation.
- [x] Expose native resource/template/prompt handlers with stable namespacing by
  immutable connection ID, URI/link round-tripping, pagination, and isolation.
- [x] Preserve schemas, annotations, structured/rich content, roles, and isError;
  do not claim capabilities that are not implemented.
- [x] Add discriminated saved MCP requests (tool/read/prompt) and replay support,
  keeping old saved HTTP calls compatible via append-only migration.
- [x] Add MCP operation/target/outcome to Activity with redacted arguments and
  no stored response bodies. HTTP 200 with isError must display as failure.
- [x] Extend satellite catalog and execution, keeping credentials on satellites;
  older satellites must report unsupported capabilities clearly.

## 4. MCP verification and delivery

- [x] Fake modern/legacy upstream integration tests: auth modes, OAuth callback/
  refresh/consent failures, JSON/SSE, pagination, templates, prompts/completions,
  rich content, protocol/tool failures, cancellation, and session expiry.
- [x] Isolation/security regressions: users/tokens/caches, allowed hosts,
  redirects/metadata, credential redaction, and ambiguous-call replay prevention.
- [x] Saved-call, native MCP federation, and satellite compatibility coverage.
- [x] Rehearse upgrade from the preceding deployed revision on scratch data.
- [x] Pass full tests, server typecheck, web typecheck/build, UI visual checks.
- [x] Update README, MCP/API guides, plugin contract docs, and self OpenAPI.
- [ ] Deploy and verify healthy/public reachability; update this handoff.

## Deliberate follow-ups

Stdio, deprecated standalone HTTP+SSE transport, live resource subscriptions,
sampling/elicitation, and task extensions are outside the initial release.
Streamable HTTP's SSE response bodies are in scope.

## Key implementation locations

- Branches: `server/plugins/github.ts`, `server/plugins/manager.ts`,
  `server/routes/admin.ts`, `web/src/pages/Plugins.tsx`, `test/github.test.ts`.
- MCP: `server/plugins/api.ts`, `server/connections.ts`, `server/db.ts`, new
  upstream client/auth modules and MCP plugin, `server/routes/connections.ts`,
  `server/mcp.ts`, `server/proxy.ts`, `server/audit.ts`, satellite modules,
  `web/src/api.ts`, Connections/Console/Activity pages.
- Docs: `README.md`, `docs/plugins.md`, `docs/guides/mcp.md`,
  `server/self-openapi.ts`.

## Research references

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/calling.md

## Verification log

- Branch feature: `npm test` passes 40 tests (including new update and route
  regressions); `npx tsc --noEmit -p .` passes; `npm --prefix web run build`
  passes. Local Node is v22.19.0; deployment image uses Node 24.
- Scratch browser script: `/tmp/branch-ui-check.mjs` uses a real temporary server
  and mocked plugin GitHub update responses. It needed sandbox escalation to
  bind the local port. Initial script used an outdated sign-up button label;
  corrected to the current “Continue” button. Passed branch selection and
  default reset, no browser errors or horizontal overflow. Screenshots inspected:
  `/tmp/branch-light.png`, `/tmp/branch-dark.png`, `/tmp/branch-mobile.png`.
- Append deployment evidence and later checks here; keep private addresses in
  the untracked local deployment notes only.
- Branch deployment verified 2026-10-08 11:24 UTC: `just deploy` succeeded from
  commit `eefe061`. Image SHA256:
  `10d9e9bf6efffe2abd4fb390ac56affecc967ab4fa43401c2fc89857b2278016`.
  Container health became `healthy`, then public `/healthz` returned
  `{"ok":true}`. Final branch regression run: 40/40 pass. Production web asset:
  `index-B79XCZXu.js`. No MCP changes were included in this deployment.

- MCP foundation verified 2026-10-08: retained the existing exact
  `@modelcontextprotocol/client` 2.3.1 pin and lockfile. npm registry reports
  Node >=20; the released package documents modern 2026-07-28 support and
  legacy negotiation. Official SDK protocol-version documentation checked.
  Real SDK integration now verifies modern auto negotiation and legacy
  initialization, tools listing and invocation, and client cleanup. This caught
  missing modern tools/list cache metadata in Switchboard's own MCP endpoint;
  fixed with `ttlMs: 0` and `cacheScope: private`.
- Migration 10 adds checked connection `kind` (http/mcp), defaulting existing
  rows to HTTP. Plugin kinds are optional for compatibility; service and
  connection views, web types, satellite catalogs and remote connection storage
  carry the discriminator. Regression covers reconnect, inactive plugins,
  database restart, invalid stored kinds and existing HTTP views.
- Scratch upgrade rehearsal used db/config/crypto modules extracted directly
  from deployed `eefe061` to create schema 9 and encrypted connection data, then
  current code upgraded to schema 10. Kind defaults, name, config and decrypted
  credentials were preserved. This verifies migration 10 only; repeat the full
  upgrade rehearsal after the remaining MCP migrations are implemented.
- Foundation validation: 42/42 tests passed; server typecheck and web
  typecheck/production build passed. A sandboxed test rerun could not start
  local servers; the full run outside the sandbox passed. UI bundle unchanged;
  no visible UI feature added. Plan moved from docs/development-plan.md to
  development-plan.md so implementation notes are outside end-user docs.

- MCP delivery validation 2026-10-08: 50/50 tests passed, server typecheck and
  production web build passed. Integration uses fake modern and legacy servers,
  JSON/SSE, all authentication modes, issuer/state/PKCE/resource checks,
  concurrent refresh and 401s, renewed consent, response/page bounds, no replay
  after ambiguous failures, cancellation, and redacted activity outcomes.
- Real SDK clients exercise Switchboard native federation in auto/legacy modes,
  namespaced resources/templates/prompts/completions, rich tool failures, saved
  requests and per-token isolation. A real central/satellite pair verifies MCP
  tools, native resources, saved reads, credentials remaining on the satellite,
  and connection deletion cancelling in-flight work. Old catalogs without MCP
  execution support return an explicit update-required error.
- Upgrade rehearsal used db/config/crypto sources from deployed `eefe061` to
  create schema 9 and encrypted HTTP connection, saved-call and activity data;
  current code upgraded to schema 12. Connection config/credentials decrypted
  unchanged, saved HTTP calls retained their fields, and old audit metadata
  defaulted to null. Scratch artifacts: `/tmp/switchboard-mcp-upgrade`.
- Browser verification: `/tmp/table-mcp-ui-check.mjs` passed on a real scratch
  instance with 19 connections, plugin details/actions, MCP tools/resources/
  prompts and save/load. No page errors or horizontal overflow. Screenshots
  inspected in light/dark and mobile: `/tmp/connections-table-*.png`,
  `/tmp/plugins-table-*.png`, `/tmp/mcp-console-*.png`.
- OAuth discovery refuses redirects and private cross-origin addresses unless
  explicitly allowed; public HTTPS discovery pins its checked DNS address.
  Clients and caches are scoped to each operation, and reconnect/delete/plugin
  unload/shutdown abort active work. Upstream and discovery bodies are bounded.
- README, MCP/API guides, plugin context contract and self OpenAPI updated;
  the in-app API reference is generated directly from self OpenAPI.

## Compact lists

- [x] Replace connection and plugin cards with compact responsive tables.
- [x] Add search/counts, preserve connection actions, plugin settings/toggles,
  source/ref/version/status and branch-update dialogs. Plugin names open details.
- [x] Verify light/dark/mobile, long names and sources, existing menus, and search.
