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
4. Each connection owner opens **Connections → Sharing** and selects cells in the matrix to share their connections with peers.

Incoming and outgoing describe how the network session is established. Permissions and sharing work identically in both directions. Nothing is shared by default. Provider credentials and settings stay on the instance that owns the original connection.

## Sharing matrix

Rows are your connections; columns are all configured peers, including incoming and outgoing peers. Check a cell to share, or clear it to revoke. Changes save immediately. Search connections and peers independently. Offline peers retain their sharing selections. Received connections show their origin and can be explicitly shared onward; cells that would create a cycle are blocked.

Only local owners can change their connections and sharing grants. A peer can invoke explicitly shared HTTP or MCP connections and inspect their OpenAPI descriptions. It cannot create, rename, reconnect or delete a connection on another instance, or retrieve raw provider credentials.

## Access and activity

Local administrators choose which local users may use received connections. This is separate from what local connection owners share out. Activity records identify the local owner, the authenticated peer and its claimed requesting user. Remote user identifiers describe the request; they never grant local permissions.

Removing a grant, disabling a peer or revoking access cancels active work. A provider may already have committed a change, so inspect its state before repeating a cancelled request.

## Multiple peers and chains

Each peer receives an independent selection. Explicit onward sharing enforces grants and local user access at every hop. Instance identities prevent cycles; routes contain at most eight hops, with deadlines and cancellation propagated throughout the chain. Request IDs allow simultaneous requests in both directions.

## Offline behavior

Imported handles and saved calls remain visible when a peer is offline, removed or no longer shares a connection. They become unavailable. Offline calls fail immediately with `503` and `peer_offline`; calls are never queued or replayed. Reconnection restores eligible handles using their existing IDs.

Rotate credentials on the accepting instance, then update the token on the connecting instance. Removing or disabling a peer stops sharing in both directions without changing local provider connections or other peers. The remote instance identity is pinned after the authenticated first handshake. If it changes, remove the peer and pair again.

## Upgrading

Both instances require peer protocol 3. Update the Shell command plugin alongside Switchboard because its context flag is now `ctx.peer`. Previous satellite protocol versions are rejected with an upgrade response. Existing devices, outgoing links, access lists, imported handles and sharing grants migrate to peers. Existing IDs, saved calls and encrypted credentials are retained. No new grants are created by migration. Review new receiving-side user permissions before sharing in the reverse direction.

`SWITCHBOARD_PEER_URL` and `SWITCHBOARD_PEER_TOKEN` bootstrap one outgoing peer once; later changes belong in the UI. Historical satellite environment variables are accepted only as upgrade aliases. Legacy shadow-owned connections are assigned to the oldest active local administrator and remain unshared until explicitly selected.

The `switchboard-plugin-switchboard` integration is retired in favor of Peers. Its records are preserved but unavailable; create a peer and select sharing grants locally on each instance.
