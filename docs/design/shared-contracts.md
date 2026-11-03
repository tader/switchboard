# Shared Calendar, Email and Messaging contracts

Status: staged implementation, disabled by default (`SHARED_CONTRACTS=1` enables it).
The v1 surface is provisional until the provider adapters and conformance suite land.
Existing plugin HTTP, saved-call, MCP and WebSocket APIs remain available.

## Scope and delivery

Clients use category operations on Switchboard without provider-specific operation
names or mapping expressions. The contracts apply equally to interactive clients,
server applications and other consumers. Client application architecture and rollout
are outside this repository.

The implementation is split into reviewable changes, in this order:

- [x] Core: optional plugin definitions, connection-scoped discovery and execution.
- [x] Core: durable write intent/receipt, atomic checkpoint/event persistence, SSE replay.
- [x] Core: activity leases, bounded polling, refresh coalescing and persistent auth pause.
- [x] Enforce canonical Calendar operation argument/result schemas.
- [ ] Email/Messaging schemas and cross-provider adapter conformance.
- [ ] Calendar: Google Calendar and Outlook list/get/create/update/delete with versions,
      all-day exclusive ends, timezones, recurrence instances and deletion coverage.
- [ ] Email: Gmail and Outlook folders/labels, messages, drafts, read/organize/trash,
      send/reply/forward, with explicit partial coverage and optional capabilities.
- [ ] Messaging: Signal, WhatsApp, Teams and Slack conversations, history and send;
      advertise optional edit/delete/thread/reaction/read-state capabilities separately.
- [ ] Native change sources: Signal callback; durable WhatsApp helper feed; optional
      Slack/Google/Microsoft subscriptions without automatic cloud setup or scope expansion.
- [ ] Peer transport: feature negotiation beside protocol 3, scoped calls, upstream
      subscriptions and durable local replay; reconnect/gap conformance tests.
- [ ] Rollout: release the core and adapters after category and transport conformance.

Consumer-specific interfaces, local data models, synchronization policies and
application deployments belong in each consumer's own repository.
Provider write tests must use mocks unless a specific real test destination is authorized.
Do not merge or deploy this staging flag as a claim of completed provider support.

## Core HTTP surface

All paths are relative to `/api`, use normal session/bearer authentication and enforce
current user, token and connection permissions. Peer-backed connections currently
return `501 contract_peer_upgrade_required` rather than silently bypassing peers.

- `GET /contracts/v1/connections?category=calendar|email|messaging`: effective operations.
- `GET /connections/:ref/contracts/v1`: operation schemas and mutation classification.
- `POST /connections/:ref/contracts/v1/call`: `{operation, arguments, idempotencyKey?}`.
- `POST /contracts/v1/subscriptions`: `{connections: [connectionId, ...]}` -> `{id,cursor}`.
- `POST /contracts/v1/subscriptions/:id/activity`: `{active: boolean}`.
- `POST /contracts/v1/subscriptions/:id/refresh`: `{connectionId}`.
- `GET /contracts/v1/subscriptions/:id/events`: SSE; `Last-Event-ID` or `?cursor=`.
- `DELETE /contracts/v1/subscriptions/:id`: stop that consumer's subscription.

Create a subscription before taking the initial snapshot; replay from the returned
cursor after the snapshot, tolerating duplicate changes. An SSE `change` contains
metadata only (connection, category, resource ids, version, time); fetch current
resource state through the category operation. Heartbeats carry the scanned cursor.
A client must persist the last successfully handled cursor, not merely the last
received frame. Initial invalid/expired/future cursors return 409 `invalid_cursor`;
perform a new snapshot/subscription. Mid-stream loss requires reconnect and replay.
Subscriptions and durable intent/receipt rows survive process restarts.

## Activity and polling

The UI sends an active heartbeat every 30 seconds while foreground and usable.
An active lease lasts 90 seconds; fallback polling may continue for 15 minutes after
that lease expires. An explicit inactive signal starts the grace immediately and
cannot extend it. Several consumers share one connection collector. Keeping a server
SSE socket connected or repeatedly posting inactive does not renew activity.

Reconciliation is at most once per 15 minutes per connection. A manual refresh
bypasses that interval, but obeys a 60-second cooldown and provider backoff. Concurrent
refreshes coalesce. An idle manual refresh temporarily grants a 30-second authorization
window; it does not mark the UI active. The runtime checks due work every 30 seconds
and aborts reads that lose their last activity lease. Events and checkpoint commit in
one SQLite transaction; a failed/aborted read cannot advance the checkpoint.

Terminal authentication/permission failures persist an `auth_required` pause across
restarts, blocking new polling and writes. An actual credentials-change event resets
it; mere activity or refresh does not. Revoked client permissions are rechecked before
network operations and before commit. A new authorized heartbeat may clear only an
`access_revoked` client-authority pause, never a provider-authentication pause.
Automatic token refresh still uses the normal connection proxy.

## Delivery and writes

SSE ids are durable increasing global sequence numbers. Source ids deduplicate
provider deliveries within retained history. Retain at most 7 days, 100,000 events
and 128 MiB of event payload/identifier bytes. A monotonic eviction watermark makes
gaps detectable. Do not embed message bodies, tokens or provider error text in events.
Transport delivery is at least once; consumers must tolerate duplicate replay.

A write requires a caller-generated key (max 128 characters), reused for the exact
same operation/arguments on retry. The key and canonical argument hash are committed
before invoking the provider. A duplicate returns the saved receipt; a changed payload
returns 409. Interrupted/ambiguous dispatch stays `uncertain`, never automatically
resends. This is duplicate dispatch prevention, not an exactly-once provider guarantee.
Receipts contain only status, resource id, version and code. Metadata-only audit entries
never capture contract argument bodies. Input bodies are limited to 1 MiB.

## Plugin implementation contract

`ServiceDefinition.contracts` is optional. Version 1 defines `available(connection)`
and named operations with category, readOnly, JSON input/output schema and invoke.
Only list/get operations are read-only. Report effective permissions; do not assume
configured scope selection equals granted provider scope. Unsupported features are
absent, never empty-success responses. All pages include explicit coverage.

`collect({checkpoint}, context)` is optional read-only reconciliation. Return stable
provider delivery ids and a checkpoint only after completing the corresponding page
or scope. Use invalidation/resync events where exact deltas or delete coverage are
unavailable. Route HTTP through `context.request`, bound to the connection's normal
credential/host enforcement and cancellation. Never perform writes in collect.
Native push registration/lifecycle and peer forwarding are still pending; a polling
collector plus local SSE is not native provider push.


## Calendar schema snapshot

`server/contracts/calendar-v1.json` is the normative Calendar input/output schema
for this staging revision. `calendar-schema.ts` attaches its shared definitions to
each operation. Core execution validates it in addition to any stricter adapter
schema, and discovery returns the canonical schema. Adapters vendor the exact JSON
and wrapper without runtime imports from the core; update the snapshots together
while this surface is provisional.

Calendar resources include `id`, `name`, nullable `timeZone`, and nullable
`canWrite`. The capability list describes account/binding permissions; an individual
calendar may still be read-only. Event list requests have a calendar id and explicit
`timeMin`/`timeMax` window and return expanded occurrences. Page cursors are opaque
and bound to the connection and query; clients must not inspect or reuse them for a
different query. `coverage.complete` is false when more pages remain. A completed
bounded snapshot describes active events within that range, not an unbounded delta
or tombstone feed.

Create accepts title/start/end and optional description/location. Update accepts
nonempty changes to those fields; update/delete require a previously read opaque
version. Stale versions return a rejected conflict receipt. Recurrence-rule editing,
attendee management, reminders and invitation policies are not in this first common
schema; provider-specific operations remain available. Series/occurrence identifiers
preserve identity when reading expanded events.
