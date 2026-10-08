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

- Phase: plugin branch switching implemented and verified; deployment pending.
- Deployment: neither feature deployed yet.
- Next action: deploy, record healthy/public checks,
  then start MCP. Do not start MCP before the branch feature is deployed.
- No additional user decisions are needed for the agreed scope.

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
- [ ] Deploy with `just deploy`; wait for healthy, then check the public URL.
- [ ] Record deployed revision/build and verification here before MCP work.

## 2. MCP core and authentication

- [ ] Verify current official MCP specification/SDK compatibility; pin a
  suitable released SDK. Check Node runtime compatibility.
- [ ] Add an HTTP/MCP discriminator to service/connection views and persistent
  connections (append-only migration, existing connections default to HTTP).
- [ ] Provide an MCP service with exact endpoint URL and OAuth, bearer-token,
  API-key-header, and unauthenticated methods. Keep plugins compatible with the
  type-only import rule and use core helpers through plugin context as needed.
- [ ] Implement a shared upstream MCP client/execution layer with Streamable
  HTTP JSON/SSE, modern 2026-07-28 and legacy 2025 negotiation, capability-aware
  calls, bounded pagination/results/timeouts, cancellation, and session cleanup.
- [ ] Isolate clients and discovery caches by user, connection, endpoint, and
  authentication state; invalidate on reconnect/delete/plugin changes/shutdown.
- [ ] Implement OAuth resource/issuer discovery, client metadata/pre-registration/
  dynamic registration as supported, PKCE, state/issuer validation, resource
  indicators, encrypted pending state/tokens, serialized refresh, and reconnect
  for renewed consent. Never forward a Switchboard token upstream.
- [ ] Apply credential-host checks before/after authorization; validate redirects
  and discovered endpoints while allowing explicitly configured private servers.
- [ ] Avoid automatically replaying mutating calls after ambiguous failures.

## 3. MCP surfaces and parity

- [ ] Add connection-scoped HTTP endpoints for tools list/search/inspect/call,
  resources list/templates/read, prompts list/get, and supported completions.
- [ ] Enforce ownership and token connection restrictions on every operation.
- [ ] Add console Tools/Resources/Prompts views with schemas, arguments, rich
  results, text/binary resource previews, prompt messages, and distinct errors.
- [ ] Extend Switchboard's MCP tools with connection-scoped discovery/invocation.
- [ ] Expose native resource/template/prompt handlers with stable namespacing by
  immutable connection ID, URI/link round-tripping, pagination, and isolation.
- [ ] Preserve schemas, annotations, structured/rich content, roles, and isError;
  do not claim capabilities that are not implemented.
- [ ] Add discriminated saved MCP requests (tool/read/prompt) and replay support,
  keeping old saved HTTP calls compatible via append-only migration.
- [ ] Add MCP operation/target/outcome to Activity with redacted arguments and
  no stored response bodies. HTTP 200 with isError must display as failure.
- [ ] Extend satellite catalog and execution, keeping credentials on satellites;
  older satellites must report unsupported capabilities clearly.

## 4. MCP verification and delivery

- [ ] Fake modern/legacy upstream integration tests: auth modes, OAuth callback/
  refresh/consent failures, JSON/SSE, pagination, templates, prompts/completions,
  rich content, protocol/tool failures, cancellation, and session expiry.
- [ ] Isolation/security regressions: users/tokens/caches, allowed hosts,
  redirects/metadata, credential redaction, and ambiguous-call replay prevention.
- [ ] Saved-call, native MCP federation, and satellite compatibility coverage.
- [ ] Rehearse upgrade from the preceding deployed revision on scratch data.
- [ ] Pass full tests, server typecheck, web typecheck/build, UI visual checks.
- [ ] Update README, MCP/API guides, plugin contract docs, and self OpenAPI.
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
