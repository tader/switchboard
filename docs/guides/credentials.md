---
title: Reusable credentials
order: 25
---

# Reusable credentials

Connections can reference one named credential. Rotate a PAT or API key once, or reconnect an OAuth account once, and every linked connection uses the updated credential. Secrets stay encrypted on the Switchboard server.

## Repair a forgotten token update

If Jira has the new token and Confluence still has the old one, open **Credentials**, choose the Confluence connection, and select **Use from Jira**. Give the shared credential a name and click **Link credentials**. Switchboard promotes Jira's stored token and validates it against Confluence; you never need to reveal or paste it again.

Alternatively, choose **Manage credentials** from Jira's connection menu, create a reusable credential, and then select it for Confluence. New connection forms offer the same picker. Reuse is explicit; Switchboard never merges equal secrets automatically.

## Rotate and reconnect

The Credentials page shows each credential's account, status, last update, and linked connections. Static credentials offer **Rotate**. A replacement must validate on at least one linked service before activation; all links switch together, and failing/unreachable services are reported afterwards. If validation cannot succeed anywhere, the current credential is kept.

OAuth credentials offer **Reconnect**. Additional APIs request explicit additional consent when scopes are missing. The provider must return the existing account and all required permissions; denied consent, another account, or a stale callback does not replace the shared credential. Refresh is serialized across linked connections, including rotating refresh tokens.

Deleting a connection leaves its credential and other connections intact. Unused credentials are retained until explicitly deleted. **Revoke** disables all links immediately and requests provider revocation when the plugin supports it. Static PAT/API-key providers commonly require you to revoke the token on their own website as well.

**Make independent** copies static credentials entirely server-side. OAuth instead starts a fresh authorization, rather than copying a refresh token that could interfere with another connection's refresh.

## Permissions and compatibility

Only the owner with full access can manage reusable credentials or retrieve their SDK tokens. Connection-scoped callers can continue using their permitted proxies and operations; they cannot manage credentials, retrieve shared tokens, or inspect other linked connections. Broader OAuth grants also cannot be exported to connection-scoped callers after fresh independent consent.

Auth methods opt into reuse through a plugin contract. Tokens can be projected between bearer and header/query authentication without exposing them. OAuth additionally checks provider/client identity, account, granted scopes, and the connection's request policy. Destination and permission changes require explicit reapproval. Secret client configuration is held centrally on the credential.

For named Google APIs, shared grants retain each connection's resource and access boundaries. Read-only connections use GET/HEAD in shared mode; use an independent authorization for read operations that require POST. File-only Drive connections cannot use broader Drive grants. Generic wildcard Google APIs, service accounts, and providers without safe request policies remain independent. OAuth reuse is limited to HTTP services in this release; MCP/WebSocket OAuth methods need dedicated operation/frame permission policies before sharing. Static credentials continue to work across supported transports.

## API

All management endpoints require an owner session or a full-access Switchboard API token. Cookie writes require the same origin.

| Endpoint | Purpose |
| --- | --- |
| GET `/api/credentials` | List metadata and linked connections. |
| POST `/api/credentials` | Promote `{ "connection": "jira", "name": "Work Atlassian" }`. |
| POST `/api/credentials/candidates` | Find candidates for `{ "connection": "confluence" }` or a new service/method/config. |
| GET/PATCH `/api/credentials/{id}` | Inspect metadata/rotation fields or rename with `{ "name": "Work", "version": 1 }`. |
| POST `/api/credentials/{id}/rotate` | Replace static fields using `{ "version": 1, "config": { "token": "replacement" } }`; returns metadata and per-connection health. |
| POST `/api/credentials/{id}/revoke` | Disable and request provider revocation using `{ "version": 1 }`. |
| DELETE `/api/credentials/{id}` | Delete an unused credential. |
| POST `/api/connections/{ref}/credential` | Link `{ "credentialId": "cred_…" }` or promote/link `{ "sourceConnection": "jira", "name": "Work Atlassian" }`. |
| POST `/api/connections/{ref}/credential/independent` | Make static credentials independent. |

Existing connect/reconnect endpoints accept `credentialId` for reuse and additional consent, or `independent: true` for fresh private OAuth authorization. Handle redirect/device responses through the existing connect-flow endpoints. Version conflicts return 409 and require reloading the current credential metadata. Management responses never contain secret values.
