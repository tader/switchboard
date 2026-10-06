---
title: Satellites
order: 5
adminOnly: true
---

# Satellites

Satellites make services on a private or intermittently connected machine available through this Switchboard. The private machine opens an outbound WebSocket; it does not need a public address or inbound firewall rule.

## Connect a machine

1. Open **Satellites**, choose **Add satellite**, and give the machine a name.
2. Copy the two environment variables. The device credential is shown only once.
3. Run a separate Switchboard instance on the private machine with those variables and its own persistent data directory.

```yaml
environment:
  SWITCHBOARD_SATELLITE_CENTRAL_URL: "{{publicUrl}}"
  SWITCHBOARD_SATELLITE_TOKEN: "sws_…"
```

The satellite still needs `SWITCHBOARD_PUBLIC_URL` for provider sign-in flows and a persistent `SWITCHBOARD_DATA_DIR`. Install machine-specific plugins on that instance. Their services appear on the central Connections page after the satellite connects.

> [!IMPORTANT]
> Keep the satellite data directory and device token private. Local application credentials are encrypted in that data directory and are not copied to the central instance.

## User access

The satellite owner is allowed automatically. Select additional users on the Satellites page if they should be able to create their own connections. Each connection has exactly one owner; users cannot invoke or discover another user's connection.

Allowing a user to access the machine does not give them an existing connection. It only lets them create their own connection using an advertised service.

## Offline behavior

Connections remain visible while their machine is offline. Calls fail immediately with `503 Service Unavailable` and `satellite_offline`; Switchboard does not queue them. The connection becomes usable again when the outbound WebSocket reconnects.

Rotating a satellite credential disconnects it immediately. Configure the newly shown token on the private machine before restarting it.
