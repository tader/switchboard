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

There are four ways to use a connection.

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
