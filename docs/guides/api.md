---
title: Switchboard API
order: 30
---

# Switchboard API

Scripts and agents use Switchboard over HTTP: Switchboard signs in to the service and adds the credentials, so your scripts never need their own OAuth client or secret. Everything the web app does is available through the API too. For every endpoint, see the [API reference](/docs/guides/api-reference).

## Tokens

Create a token on the [API tokens](/tokens) page, one per script or agent, so you can see each one's [activity](/activity) and revoke it separately. Pass it with every request:

```http
Authorization: Bearer swb_…
```

A token has one of three kinds of access:

| Access | Can use |
|---|---|
| **Everything** | All your connections, and everything else you can do in the web app. For admins, that includes managing plugins and users. |
| **Selected connections** | Only those connections, to make calls and run saved calls. It cannot manage anything or read the activity log. |
| **MCP only** | Tokens that AI assistants get when signing in through [MCP](/docs/guides/mcp). They work only at `/mcp`. |

Connections are made in the web app, or with `POST /api/connections`. If a provider only accepts a redirect URI that does not lead to Switchboard (often `http://localhost`), pass it as `redirectUri`. After signing in, send the address the browser ended up on to `POST /api/connect/<flow>/complete`.

Connections are referred to by id or by name, for example `gmail-work`. Names can be changed on the [Connections](/connections) page.

## Calling a service

HTTP connections support the four methods below. MCP connections use the scoped MCP endpoints described afterwards.

### 1. Proxy

Send the request to `{{publicUrl}}/proxy/<connection>/<path>`, with the path relative to the service's base URL. Method, query, headers and body are passed on, and the response comes back as the service sent it. This is the easiest option for most scripts.

```bash
curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \
  "{{publicUrl}}/proxy/gmail-work/gmail/v1/users/me/messages?maxResults=5"
```

An absolute URL works too, as long as it is on one of the service's hosts: `{{publicUrl}}/proxy/gmail-work/https://www.googleapis.com/...`.

### 2. Call API

`POST /api/call` takes the request as JSON and returns status, headers and body as JSON. This is handy when a script wants to inspect the status or headers. `{placeholders}` in the URL are filled from `pathParams`.

```bash
curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H "content-type: application/json" \
  {{publicUrl}}/api/call -d '{
    "connection": "github-me",
    "method": "GET",
    "url": "/repos/{owner}/{repo}/issues",
    "pathParams": { "owner": "octocat", "repo": "hello-world" },
    "query": { "state": "open" }
  }'
```

```json
{ "status": 200, "headers": [["content-type", "application/json; charset=utf-8"]], "body": "[…]", "bodyEncoding": "utf8", "durationMs": 212, "size": 4519 }
```

Binary responses come back with `"bodyEncoding": "base64"`.

### 3. Saved calls

Calls saved in the [console](/console) can be run by name or id. The response is passed through like the proxy. The JSON body may override `connection`, `pathParams`, `query`, `headers` and `body`.

```bash
curl -X POST -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \
  "{{publicUrl}}/api/calls/Unread%20mail/run" -d '{ "query": { "maxResults": "20" } }'
```

### 4. Access token for an SDK

For libraries that want to talk to the service themselves, such as Google's client libraries or Octokit, Switchboard hands out a fresh access token, refreshed when needed:

```bash
curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" {{publicUrl}}/api/connections/gmail-work/token
```

```json
{ "access_token": "ya29.…", "token_type": "Bearer", "expires_at": 1791279999000 }
```

Ask again rather than storing it.

> [!NOTE]
> Calls made with this token go directly to the service, so they do not appear in the activity log. Only the hand-out itself is recorded.

## MCP connections

For a connection with `kind: "mcp"`, send JSON to `POST /api/connections/<id-or-name>/mcp/<operation>`. The operations are `tools/list`, `tools/get`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get` and `completion/complete`.

```bash
curl -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H "content-type: application/json" \
  {{publicUrl}}/api/connections/mcp-work/mcp/tools/call \
  -d '{ "name": "search", "arguments": { "query": "notes" } }'
```

`tools/list` accepts `query`; `tools/get` accepts `name` and returns the schema. Lists collect pages when `cursor` is omitted; supply a cursor (including an empty string for the first page) to request one page. Reads accept `uri`; prompt requests accept `name` and string-valued `arguments`. Completions accept `ref`, `argument` and optional `context` as defined by MCP.

Responses retain rich content, structured results and `isError`. Tool errors return HTTP 200 with `isError: true`; transport, protocol and authentication failures use error statuses. The proxy and raw token endpoint are for HTTP connections.

Save tool calls, reads and prompts with `POST /api/calls` using `kind: "mcp"`, `connectionId`, `name` and `mcpRequest` (an object with `operation` and its inputs). Run them through `/api/calls/<id-or-name>/run`; `arguments` overrides merge with saved arguments, and `uri` can override a resource URI. Existing saved HTTP calls keep their behavior.

## Examples

Python:

```python
import os, requests

sb = requests.Session()
sb.headers["Authorization"] = f"Bearer {os.environ['SWITCHBOARD_TOKEN']}"

r = sb.get("{{publicUrl}}/proxy/gmail-work/gmail/v1/users/me/messages", params={"q": "is:unread"})
r.raise_for_status()
print(r.json()["resultSizeEstimate"])
```

JavaScript:

```js
const sb = (path, init = {}) =>
  fetch(`{{publicUrl}}${path}`, { ...init, headers: { authorization: `Bearer ${process.env.SWITCHBOARD_TOKEN}`, ...init.headers } });

const res = await sb('/proxy/github-me/user/repos?per_page=5');
console.log((await res.json()).map((r) => r.full_name));
```

Using Google's own client library with a token from Switchboard:

```python
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

token = sb.get("{{publicUrl}}/api/connections/gmail-work/token").json()["access_token"]
gmail = build("gmail", "v1", credentials=Credentials(token))
```

## Good to know

- **Errors** from Switchboard itself are JSON, `{"error": "…"}`, with a 4xx or 5xx status. Errors from the service are passed through unchanged.
- **Allowed hosts:** credentials are only sent to the service's own hosts. Requests elsewhere fail with `400`.
- **Expired sign-ins:** Switchboard refreshes tokens itself, and retries once with fresh credentials after a `401`. If a sign-in can no longer be refreshed, the connection shows an error on the Connections page and needs **Reconnect**.
- **Activity:** every request is in the [activity log](/activity), with secrets masked.
- **API description:** an OpenAPI description of Switchboard's API is at [`/api/openapi.json`]({{publicUrl}}/api/openapi.json), for code generators and the console.

## WebSocket operations

The console's **API reference** includes a **WebSocket operations** section for connections that support it. Search for an operation and select it to open its description, input/output schemas, and command or subscription controls. Selecting an entry does not execute it.

For Home Assistant, the plugin provides `lovelace/dashboards/list` to discover dashboards, `lovelace/config` to get a configuration, `lovelace/config/save` to update the full configuration, and `system_log/list` to get condensed warnings and errors. These operations all use the server-managed WebSocket connection to Home Assistant. Dashboard calls accept an optional `url_path`; omit it for the default dashboard. Saves require an admin and a storage-mode dashboard. Live log operations and their requirements are listed alongside the commands.

Connections with `hasWebSocket: true` offer plugin-defined commands and subscriptions.
Switchboard keeps their sockets and credentials on the server. Clients cannot supply
an endpoint or authentication frame.

1. `GET /api/connections/:ref/websocket/operations?query=logs` discovers operations.
   Follow `nextOffset` with `offset` until absent. URL-encode the connection reference.
2. `GET /api/connections/:ref/websocket/operations/:operationId` returns the complete
   schema. URL-encode the operation id, including any slashes.
3. `POST /api/connections/:ref/websocket/call` with
   `{ "operationId": "example/read", "arguments": {} }` executes a command and
   returns `{ result, durationMs, auditId }`.

For an operation with `mode: "subscription"`, POST the same input to
`/api/connections/:ref/websocket/subscriptions`. The response contains an `id`.
POST `{ "cursor": 0, "waitMs": 25000 }` to
`/api/connections/:ref/websocket/subscriptions/:id/read`. Save `nextCursor` for the
next read; repeated cursors return the same retained events. Inspect `gap` for
lost events and `status` for interruptions. DELETE the subscription URL to stop it.
GET the subscriptions collection to list this caller's handles.

Handles belong to the creating token or browser session. Reads renew a five-minute
lease; unused subscriptions expire. Terminal buffers remain readable for five
minutes. Handles and events are in memory and are lost on restart. Disconnections
stop subscriptions; start a new one explicitly. Lost command replies are never
replayed because a write may already have completed.

Defaults: 100 events per page (maximum 500), 512 KiB pages, 1,000 events or 1 MiB per
buffer. Overflow drops the oldest events and reports a gap. Arguments and individual
events are limited to 256 KiB; frames/results to 1 MiB. Opening/authentication has a
30-second deadline and operations a 60-second deadline. Socket and retained
subscription quotas are eight per caller, sixteen per user, sixty-four per instance.
These are server limits, not client settings.

The console supports commands, saved commands, and subscriptions. It pauses event
reads while hidden and stops subscriptions it started when leaving the WebSocket
console. Abrupt closure is handled by lease expiry. Saved calls use
`kind: "websocket"` and `websocketRequest: { operationId, arguments }`; only commands
can be saved. `/api/calls/:id/run` accepts argument overrides.


### Raw WebSocket proxy and plugin REST endpoints

For a local connection whose plugin enables frame proxying, upgrade `/api/connections/:ref/websocket/proxy` to a WebSocket. Scripts pass a Switchboard bearer token in the upgrade request; browsers use the same-origin session cookie. Switchboard opens a dedicated upstream socket and authenticates before relaying frames, so clients send provider commands without the provider's authentication handshake. The console's **WebSocket proxy** mode uses this endpoint. Each proxy has its own socket and message ID namespace. Access revocation, credential changes, plugin changes, shutdown, and upstream disconnection close the relay. Frames are bounded to 1 MiB, with bounded send queues; slow clients are disconnected. Commands are never replayed.

Plugins may attach a `rest: { method, path }` binding to a declared WebSocket command. These endpoints are served under `/api/connections/:ref/plugin`; GET arguments come from query parameters and POST/PUT arguments from a JSON body. Boolean query arguments use `true` or `false`. The route validates against the command schema, executes the plugin adapter on an authenticated provider WebSocket, and returns the command's result directly as JSON. Its OpenAPI reference is at `/api/connections/:ref/plugin/openapi.json`. Raw proxies and plugin REST bindings currently require local connections.

The Home Assistant plugin declares GET `/plugin/lovelace/dashboards`, GET `/plugin/lovelace/config`, PUT `/plugin/lovelace/config`, and GET `/plugin/system/logs`, each prefixed by `/api/connections/:ref`. Dashboard configuration calls accept `url_path`; reads also accept `force=true`. PUT accepts the full `{ "url_path": "my-home", "config": { ... } }` configuration and returns JSON `null` when HA acknowledges the save. The logs endpoint returns condensed system-log warnings and errors. Both interfaces connect to Home Assistant over WebSocket.

## Connection errors and recovery

Connection errors clear after a confirmed successful HTTP request, MCP operation, WebSocket authentication/operation, token issue, or credential provision. Recovery does not require token rotation or reconnecting when the existing authentication already works. The Connections page refreshes automatically.

Failed requests and MCP tool errors do not count as recovery. An older in-flight success cannot erase a newer failure. Saving refreshed credentials alone does not clear an unresolved connection error; the operation must succeed.

At startup, Switchboard also reconciles errors saved by older versions when the latest audit entry proves a successful operation started after the error. Errors without that evidence, newer failures, and revoked/expired shared credentials remain flagged. This updates current connection health; historical failures stay in Activity.
