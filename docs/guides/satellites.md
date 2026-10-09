---
title: Satellites
order: 5
adminOnly: true
---

# Satellites

Satellites open an outbound WebSocket to an upstream Switchboard. Provider credentials and configuration stay on the machine that owns the connection.

## Connect and share

1. On the upstream, open **Satellites**, add the machine and copy its device token. Select which upstream users may use its shared connections.
2. On the private machine, run a separate Switchboard with its own persistent data directory. Open **Satellites → Upstreams → Add upstream** and enter the upstream URL and token.
3. Install plugins and create connections on that private machine.
4. From a connection's menu, select **Share with upstreams**, choose the upstreams and save. Nothing is shared by default.

Each upstream can receive a different selection. Only a connection's local owner can change its sharing grants. Upstream users automatically receive read-only handles; they can invoke shared HTTP and MCP connections and inspect their OpenAPI descriptions. Upstreams cannot create, reconnect, rename or delete connections on satellites, nor request raw provider tokens.

## Access and activity

The upstream device owner is allowed automatically; administrators can allow additional upstream users. This grants use of the connections that the satellite explicitly shares with that upstream. Local Activity records identify the local owner, upstream and claimed requesting upstream user. Removing a grant cancels active work, whose outcome may already be committed by the provider.

## Multiple upstreams and chains

Add several upstreams in the local UI and choose grants independently. A connection received from a downstream satellite can be explicitly shared onward; each hop enforces its own user access and sharing grants. Instance identifiers prevent cycles, routes have at most eight hops, and deadlines and cancellation propagate through the chain.

## Offline behavior

Imported handles and saved calls remain visible while the providing machine is offline or a grant is revoked. They become unavailable; calls are not queued or replayed. Offline requests return `503` with `satellite_offline`. Reconnecting restores eligible handles with their existing IDs.

Rotate a device token upstream and update the corresponding upstream entry on the satellite. Removing an upstream or disabling it stops its agent without changing local connections or other upstreams.

## Upgrading

Both sides require satellite protocol 2; older peers are rejected with an upgrade message. The legacy `SWITCHBOARD_SATELLITE_CENTRAL_URL` and `SWITCHBOARD_SATELLITE_TOKEN` variables bootstrap one upstream once. Later changes belong in the UI. Legacy shadow-owned connections are assigned to the oldest active local administrator, preserving IDs and credentials. No grants are created automatically; review and share each connection locally.
