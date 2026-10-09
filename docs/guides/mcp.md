---
title: AI assistants (MCP)
order: 10
---

# Use Switchboard from AI assistants

Switchboard is an [MCP](https://modelcontextprotocol.io) server. Claude, Codex, Copilot, OpenCode and other assistants can use your connections through it, without ever seeing your passwords or tokens.

```text
{{mcpUrl}}
```

## What an assistant can do

| Tool | What it does |
|---|---|
| `list_connections` | See the connections it may use |
| `search_operations`, `get_operation` | Look up endpoints in a service's API reference, e.g. "list gmail messages" |
| `call_operation` | Call a discovered operation with validated, automatically mapped parameters |
| `call` | Make a lower-level request for an undocumented or unusual endpoint |
| `search_mcp_tools`, `get_mcp_tool`, `call_mcp_tool` | Discover, inspect and call tools on an MCP connection |
| `list_mcp_resources`, `read_mcp_resource` | List resources or templates and read a resource |
| `list_mcp_prompts`, `get_mcp_prompt`, `complete_mcp_argument` | Retrieve prompt messages and complete supported arguments |
| `list_saved_calls`, `run_saved_call` | Use the calls you saved in the console |

For documented APIs, use `list_connections` → `search_operations` → `get_operation` → `call_operation`. Switchboard maps named inputs to the operation's path, query string, headers and body. Paginated operations explain how to pass `nextToken`; keep the same filters and continue until the response no longer contains one.

Everything an assistant does is listed under [Activity](/activity?source=mcp) with source **MCP**.

## Connecting an MCP server

On [Connections](/connections), choose **MCP server** and enter the exact HTTP endpoint. Choose OAuth, a bearer token, an API-key header, or no authentication. OAuth discovers the server's resource and issuer metadata, then uses a pre-registered client, client metadata document, or dynamic registration supported by that server. If a pre-registered client is required, enter its issuer, client ID and optional secret under advanced fields. Use Switchboard's callback URL when registering it:

```text
{{callbackUrl}}
```

Explicitly configured endpoints may be on a private network. Separate OAuth discovery endpoints must be public HTTPS unless you enable **Allow OAuth servers on private networks**. Redirecting HTTP endpoints are refused; enter the final URL. Reconnect if consent expires or a tool requires additional scopes.

The [console](/console) provides Tools, Resources and Prompts, with schemas, editable arguments, rich results and saved requests. A tool result marked `isError` is shown as a tool error and recorded as failure in Activity.

Assistants use `search_mcp_tools` → `get_mcp_tool` → `call_mcp_tool`. Native MCP resources, templates and prompts are also available to clients that expose them. Resource URIs begin with `switchboard-mcp:<connection-id>:`; prompt names begin with `<connection-id>:`. Pass those values back unchanged. The namespace uses immutable IDs, so renaming a connection does not break it. Each token sees only its shared connections, including peer connections; upstream credentials stay on their owning instance.

Upstream connections support Streamable HTTP JSON and SSE responses, MCP 2026-07-28 and negotiated 2025 versions. Lists collect at most 16 pages; results are limited to 2 MiB and operations to two minutes. Cancelled or failed mutating calls can have an unknown outcome; inspect upstream state before repeating them. Stdio, deprecated standalone SSE endpoints, subscriptions, sampling, elicitation and task extensions are not supported.

## Signing in

Most assistants sign in through your browser: they open Switchboard, you approve, and you choose which connections to share. You can also choose **Everything**, but sharing only what the assistant needs is safer. The assistant then appears on the [API tokens](/tokens) page as *name (MCP)*, where you can revoke it. That token only works for MCP, not for the rest of the API.

If an assistant cannot sign in through the browser, [create a token](/tokens) limited to the connections it needs and pass it as a header: `Authorization: Bearer swb_…`. The examples below read it from the `SWITCHBOARD_TOKEN` environment variable.

## Claude Code

```bash
claude mcp add --scope user --transport http switchboard {{mcpUrl}}
```

Then sign in: run `/mcp` in a Claude Code session and choose **switchboard**, or run `claude mcp login switchboard`. `--scope user` makes Switchboard available in all your projects; leave it out to add it to the current project only.

With a token instead:

```bash
claude mcp add --scope user --transport http switchboard {{mcpUrl}} \
  --header "Authorization: Bearer $SWITCHBOARD_TOKEN"
```

## Claude Desktop and claude.ai

1. In claude.ai, open **Customize → Connectors** ([claude.ai/customize/connectors](https://claude.ai/customize/connectors)), or **Settings → Connectors** in Claude Desktop.
2. Choose **Add custom connector**, name it *Switchboard* and enter `{{mcpUrl}}`.
3. Choose **Connect** and approve in the Switchboard window that opens.

Connectors you add here are also available in Claude Desktop and in Claude Code when you are signed in with the same account. On Team and Enterprise plans, an owner may have to add the connector for the organization.

> [!NOTE]
> Claude connects from Anthropic's servers, so Switchboard must be reachable from the internet.

## Codex (CLI, app and IDE extension)

```bash
codex mcp add switchboard --url {{mcpUrl}}
codex mcp login switchboard
```

The CLI, the Codex app and the IDE extension share `~/.codex/config.toml`. With a token, the entry looks like this:

```toml
[mcp_servers.switchboard]
url = "{{mcpUrl}}"
bearer_token_env_var = "SWITCHBOARD_TOKEN"
```

or add it with `codex mcp add switchboard --url {{mcpUrl}} --bearer-token-env-var SWITCHBOARD_TOKEN`.

## GitHub Copilot CLI

In a Copilot CLI session, run `/mcp add`, choose **HTTP**, and enter `{{mcpUrl}}`. Copilot signs in through the browser the first time Switchboard is used.

Or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "switchboard": {
      "type": "http",
      "url": "{{mcpUrl}}"
    }
  }
}
```

To use a token, add `"headers": { "Authorization": "Bearer ${SWITCHBOARD_TOKEN}" }` to the entry.

## GitHub Copilot in VS Code

Add Switchboard to `.vscode/mcp.json` in a project, or run **MCP: Open User Configuration** for all projects:

```json
{
  "servers": {
    "switchboard": {
      "type": "http",
      "url": "{{mcpUrl}}"
    }
  }
}
```

VS Code asks you to sign in when Copilot first uses Switchboard. To use a token without storing it in the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "switchboard-token", "description": "Switchboard token", "password": true }],
  "servers": {
    "switchboard": {
      "type": "http",
      "url": "{{mcpUrl}}",
      "headers": { "Authorization": "Bearer ${input:switchboard-token}" }
    }
  }
}
```

## OpenCode

Add Switchboard to `opencode.json` (in a project) or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "switchboard": {
      "type": "remote",
      "url": "{{mcpUrl}}",
      "enabled": true
    }
  }
}
```

Then sign in with `opencode mcp auth switchboard`. With a token, add `"headers": { "Authorization": "Bearer {env:SWITCHBOARD_TOKEN}" }` and `"oauth": false` to the entry.

## Other assistants

Any assistant that supports remote MCP servers over HTTP ("Streamable HTTP") works the same way: give it `{{mcpUrl}}`, and either let it sign in or give it a token header. For assistants that only run local MCP servers, [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridges the gap, including the browser sign-in:

```json
{
  "mcpServers": {
    "switchboard": { "command": "npx", "args": ["-y", "mcp-remote", "{{mcpUrl}}"] }
  }
}
```

> [!TIP]
> Menus in these apps change from time to time; the URL and the sign-in stay the same.

## Troubleshooting

| Problem | What to do |
|---|---|
| The assistant says Switchboard needs authentication | Sign in again (`/mcp` in Claude Code, `codex mcp login switchboard`, `opencode mcp auth switchboard`). Tokens that were revoked on the API tokens page stop working. |
| A connection is missing | The assistant only sees the connections you shared when signing in. Revoke its token and sign in again to choose others, or edit the token. |
| "This client may not use …" | Same as above: that connection was not shared. |
| A token works for MCP but not for the API | Tokens from an assistant's sign-in are for MCP only. Create a token on the API tokens page for scripts. |
| Requests fail with "not an allowed host" | Requests can only go to the service's own hosts, so credentials never leak elsewhere. |

Switchboard speaks MCP 2026-07-28, and 2025-03-26 to 2025-11-25 for older clients.
