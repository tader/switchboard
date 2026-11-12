---
title: Peers
order: 5
adminOnly: true
---

# Peers

Connect two Switchboard instances once. Both can share selected connections and use connections received from the other, over the same WebSocket. Only one machine needs to accept inbound traffic; the other can remain behind a firewall.

## Pair two instances

1. On a reachable instance, open **Peers → Add peer**, choose **Accept a connection from the other machine**, and copy the URL and device token.
2. On the other instance, add a peer, choose **Connect to the other machine**, and enter that URL and token.
3. On each instance, choose which local users may use connections received from this peer. The local peer owner is always included.
4. Each connection owner opens **Peers → Sharing** and selects cells in the matrix to share their connections with peers.

Incoming and outgoing describe how the network session is established. Permissions and sharing work identically in both directions. Nothing is shared by default. Ordinary sharing keeps provider credentials and settings on the instance that owns the original connection. Authentication providers have a separate, explicit credential-sharing grant, described below.

## Sharing matrix

Rows are your connections; columns are all configured peers, including incoming and outgoing peers. Check a cell to share, or clear it to revoke. Changes save immediately. Search connections and peers independently. Offline peers retain their sharing selections. Received connections show their origin and can be explicitly shared onward; cells that would create a cycle are blocked.

Only local owners can change their connections and sharing grants. A peer can invoke explicitly shared HTTP or MCP connections and inspect their OpenAPI descriptions. It cannot create, rename, reconnect or delete a connection on another instance, or retrieve raw provider credentials through ordinary sharing.

## Local names for received connections

In **Connections**, open a received connection’s actions and choose **Rename locally**. This changes only your local handle, including while the peer is offline or the handle is no longer shared. Other users’ names and the original connection on the peer stay unchanged. Names follow the usual connection name rules and must be unique among your connections.

New received connections get an available local name when first imported. Later peer name changes never replace your local name automatically. When the names differ, Connections and the peer’s received list show the name on the peer; offline, this is labeled as the last known name. A handle no longer present in the accessible catalog has no peer name to display.

Update scripts that refer to the old local name after renaming. Connection IDs, saved calls, sharing grants and routing stay unchanged. Reconnection and restarts retain your chosen name. If an original connection is deleted and recreated, it gets a separate handle and ID, even if its name is reused. Existing saved calls remain attached to the old handle; choose the new connection explicitly to use it. To reclaim a name such as `work` when the replacement is named `work-2`, first rename or remove the stale handle, then rename the replacement. Saved calls never move to the replacement automatically.

## Authentication sources

Some plugins provide authentication that another local connection can consume. On the source connection, first share it with the destination peer, then enable **Share authentication → Allow authentication on [peer]**. This additional grant allows that peer's backend to receive and store refresh-capable credentials. Ordinary sharing alone never enables credential transfer.

On the destination, create a local service connection and select the received authentication source. The service calls its provider directly and can refresh its cached credentials while the source device is offline. If renewal requires a fresh browser sign-in, sign in to the authentication connection on its original device, then retry. Token lifetimes and provider policy still apply.

Only direct peers support authentication transfer; it cannot be forwarded through a chain. Removing either sharing grant stops future transfers. Once the destination receives the change, linked consumers stop using their cached credentials. Removing a grant cannot recall credentials already stored on an offline peer; use the provider's session revocation controls when needed. Both instances must support authentication providers for the selector and grant to appear. Credentials are never returned to the web app or exposed through the regular token API for an authentication source.

## Access and activity

Local administrators choose which local users may use received connections. This is separate from what local connection owners share out. Activity records identify the local owner, the authenticated peer and its claimed requesting user. Remote user identifiers describe the request; they never grant local permissions.

Removing a grant, disabling a peer or revoking access cancels active work. A provider may already have committed a change, so inspect its state before repeating a cancelled request.

## Multiple peers and chains

Each peer receives an independent selection. Explicit onward sharing enforces grants and local user access at every hop. Instance identities prevent cycles; routes contain at most eight hops, with deadlines and cancellation propagated throughout the chain. Request IDs allow simultaneous requests in both directions.

## Offline behavior

Imported handles and saved calls remain visible when a peer is offline, removed or no longer shares a connection. They become unavailable. Offline calls fail immediately with `503` and `peer_offline`; calls are never queued or replayed. Reconnection restores eligible handles using their existing IDs.

Rotate credentials on the accepting instance, then update the token on the connecting instance. Removing or disabling a peer stops sharing in both directions without changing local provider connections or other peers. The remote instance identity is pinned after the authenticated first handshake. If it changes, remove the peer and pair again.

## Upgrading

Both instances require peer protocol 3. Previous satellite protocol versions are rejected with an upgrade response. Existing devices, outgoing links, access lists, imported handles and sharing grants migrate to peers. Existing IDs, saved calls and encrypted credentials are retained. No new grants are created by migration. Review new receiving-side user permissions before sharing in the reverse direction.

`SWITCHBOARD_PEER_URL` and `SWITCHBOARD_PEER_TOKEN` bootstrap one outgoing peer once; later changes belong in the UI. Historical satellite environment variables are accepted only as upgrade aliases. Legacy shadow-owned connections are assigned to the oldest active local administrator and remain unshared until explicitly selected.

Records from the retired connection-based peer integration are preserved but unavailable; create a peer and select sharing grants locally on each instance.

## WebSocket operations

Peers advertise WebSocket capabilities for explicitly shared connections. Commands
and subscriptions work through the same API, MCP tools, and console as local
connections; provider credentials stay on the owning instance. Each hop applies
sharing and caller permissions. Older peers without this capability continue to
support their existing HTTP/MCP operations.

Subscription events are copied through bounded background reads into the local
buffer. Each hop can report overflow; clients must inspect the returned gap. Peer
loss interrupts subscriptions and preserves events already retrieved. Stops and
revocations trigger remote cleanup; when a link is unavailable, remote lease expiry
releases the upstream resources. Subscriptions must be recreated after interruption.
