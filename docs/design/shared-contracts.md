# Shared Calendar, Email and Messaging contracts

Status: staged implementation, disabled by default (`SWITCHBOARD_SHARED_CONTRACTS=1` enables it).
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
- [x] Canonical Messaging schemas, explicit partial/restricted content and optional operations.
- [ ] Email schemas and cross-provider adapter conformance.
- [ ] Calendar: Google Calendar and Outlook list/get/create/update/delete with versions,
      all-day exclusive ends, timezones, recurrence instances and deletion coverage.
- [ ] Email: Gmail and Outlook folders/labels, messages, drafts, read/organize/trash,
      send/reply/forward, with explicit partial coverage and optional capabilities.
- [ ] Messaging: Signal, WhatsApp, Teams and Slack conversations, history and send;
      advertise optional edit/delete/thread/reaction/read-state capabilities separately.
- [x] Core native receiver lifecycle and durable, separately checkpointed publication.
- [ ] Native provider wiring: Signal callback; durable WhatsApp helper feed; optional
      Slack/Google/Microsoft subscriptions without automatic cloud setup or scope expansion.
- [x] Peer transport: feature negotiation beside protocol 3, scoped calls, upstream
      subscriptions and durable local replay; reconnect/gap conformance tests.
- [ ] Rollout: release the core and adapters after category and transport conformance.

Consumer-specific interfaces, local data models, synchronization policies and
application deployments belong in each consumer's own repository.
Provider write tests must use mocks unless a specific real test destination is authorized.
Do not merge or deploy this staging flag as a claim of completed provider support.

## Core HTTP surface

All paths are relative to `/api`, use normal session/bearer authentication and enforce
current user, token and connection permissions. Peer-backed connections use the same
contracts through explicitly shared links. A hop without the negotiated `contracts.v1`
feature returns `501 contract_peer_upgrade_required`; classic peer operations remain
available without this extension.

- `GET /contracts/v1/connections?category=calendar|email|messaging`: effective operations.
- `GET /connections/:ref/contracts/v1`: operation schemas and mutation classification.
- `POST /connections/:ref/contracts/v1/call`: `{operation, arguments, idempotencyKey?}`.
- `POST /contracts/v1/subscriptions`: `{connections: [connectionId, ...]}` -> `{id,cursor}`.
- `POST /contracts/v1/subscriptions/:id/activity`: `{active: boolean}`.
- `POST /contracts/v1/subscriptions/:id/refresh`: `{connectionId}`.
- `GET /contracts/v1/subscriptions/:id/status`: activity expiry and sanitized source state; no provider calls.
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

Terminal credential/scope failures persist an `auth_required` pause across
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
`watch({checkpoint}, context)` is the optional native receive loop. It runs until
`context.signal` aborts and must release its listeners/sockets in `finally`. Use
`await context.publish({events,checkpoint})` before acknowledging the corresponding
upstream delivery. Publication checks live permissions/activity, commits events and
its native checkpoint atomically, and wakes the same durable SSE feed. Native and
polling checkpoints are independent; delivery ids share a deduplication namespace.

Core shares one native receiver per active connection and starts it on a foreground
heartbeat. The receiver stops after the last activity grace, on access/config/plugin
changes, or during shutdown. Unexpected closures use exponential reconnect delays
(60 seconds up to 15 minutes); provider Retry-After is honored up to 24 hours and
backoff survives restart. Terminal authentication pauses both native and polling
work. Credential changes invalidate old jobs; late successes or failures cannot
overwrite a newer authentication state. Native availability and reconciliation
support appear in discovery as `changes.native` and `changes.reconciliation`.

Provider callbacks/subscription registration are adapter-specific. A polling collector
plus local SSE is not native provider push; adding this core receive lifecycle does
not make an unwired provider push-capable.


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


## Messaging schema snapshot

`server/contracts/messaging-v1.json` defines common conversation/message reads,
message send, and optional conversation creation, edits, deletion, threads,
reactions and read-state updates. Advertise only implemented operations. A read
must not send read receipts or mutate read state. The explicit read-state mutation
requires a target message id; clients must not infer it from opening a history page.

`Message.contentState` distinguishes available, unavailable, restricted and deleted
content. The latter three require `text: null`; never map missing/restricted text to
an empty successful message. `contentType` describes text/media/poll/system/unknown.
`Message.isOwn` identifies the sender relative to the connected account without
provider-specific user-id mapping. Optional conversation `updatedAt` lets consumers
merge activity across sources. Unknown unread counts, ownership, authors, timestamps, reaction totals and own-reaction state
remain null. Partial history uses `coverage.complete: false` with a reason, even on
a final page with no next cursor. Clients cannot treat partial absence as deletion.
Conversation/message ids and page cursors are opaque and connection-bound.

Discovery returns the common `inputSchema`/`outputSchema` plus `inputConstraints`.
Validate the common input and the constraints independently; do not naively nest
schemas with root-relative `$ref` definitions into a single `allOf`. This allows a
provider to advertise a smaller text limit or exclude unsupported optional fields
without inventing provider-specific operation names. Core enforces both schemas.

Write invocation contexts include the original intent `idempotencyKey`. Adapters
with their own durable ledger must namespace/reuse it rather than generate a fresh
key on retry. Core receipts are reduced to metadata before common schema validation
and persistence. Provider message bodies cannot be stored in a write receipt.
Native-only sources have an unsupported reconciliation status, with a bounded
capability recheck; they do not generate fake polling failures or empty snapshots.

An individual forbidden resource returns a permission error without pausing the
whole connection. Native/reconciliation support is advertised only when the
connection has an effective read operation; write-only bindings remain usable.


## Peer extension

Peer protocol remains version 3. Enabled nodes advertise `contracts.v1` in welcome
and catalogue messages. Legacy peers omit it and retain their existing HTTP/MCP/
WebSocket operations. No provider credentials are added to contract RPCs. Each hop
checks the current peer grant, owner, connection and caller; upstream subscription
identifiers are bound to that peer principal and a single shared connection.

Describe/call, subscription open/activity/read/close and explicit refresh use the
existing authenticated WebSocket RPC transport. Writes use the same canonical
validation and durable intent/receipt engine as HTTP calls. A per-hop namespace
preserves retry identity while isolating independent downstream connection handles.
Ambiguous dispatch remains uncertain and must never cause an automatic resend.

A node maintains one upstream relay per locally needed connection. Relay reads are
20-second long polls of the upstream durable log, not provider polling. Each node
atomically commits relayed metadata events and its upstream checkpoint, then serves
its own durable SSE log. Local sequence numbers and relay generations scope delivery
identity. Transport reconnects replay the stored cursor; an evicted/future upstream
cursor emits `resync.required` so consumers take a fresh snapshot. Delivery remains
at least once. Lost upstream subscriptions can be recreated without discarding a
retained cursor. Closing a relay best-effort closes its upstream subscription; if a
link is down, its finite lease still expires.

Activity forwards only the remaining active/poll TTL, capped at the same local
limits. An upstream read, peer heartbeat or reconnect never grants a new activity
lease. Only the owning node runs the provider collector/native receiver. Explicit
refresh travels to that owner and obeys its coalescing/cooldown/authentication state.
A terminal owner authentication pause propagates downstream. An opaque random
credential revision travels through catalogues after credentials change, allowing
persistent downstream pauses to clear without exposing tokens or credential hashes.
Unchanged credentials, normal heartbeats and refresh requests do not clear the pause.

The offline transport test starts real servers in a two-hop chain. It checks scoped
reads, canonical writes and uncertain-write replay, SSE durability, reconnect and
retention gaps, share revocation, terminal authentication and reconnection, remaining
lease expiry, metadata-only persistence, native receiver cleanup and compatibility
with peers that do not advertise this extension. Provider writes use a local fixture.

`messaging.messages.list` accepts an optional opaque `threadId` to read a root and
its replies within a conversation. Omit it for the normal conversation history.
An adapter that cannot filter by thread must exclude the property in its
`inputConstraints` and reject it, never silently return the unfiltered history.
Thread history carries its own query-bound cursor and explicit coverage.
