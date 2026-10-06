---
title: AI assistants (MCP)
order: 10
---

# Use Hub from AI assistants

Hub is an [MCP](https://modelcontextprotocol.io) server. Claude, Codex, Copilot, OpenCode and other assistants can use your connections through it, without ever seeing your passwords or tokens.

```text
{{mcpUrl}}
```

## What an assistant can do

| Tool | What it does |
|---|---|
| `list_connections` | See the connections it may use |
| `search_operations`, `get_operation` | Look up endpoints in a service's API reference, e.g. "list gmail messages" |
| `call` | Make a request through a connection; Hub adds the credentials |
| `list_saved_calls`, `run_saved_call` | Use the calls you saved in the console |

Everything an assistant does is listed under [Activity](/activity?source=mcp) with source **MCP**.

## Signing in

Most assistants sign in through your browser: they open Hub, you approve, and you choose which connections to share. You can also choose **Everything**, but sharing only what the assistant needs is safer. The assistant then appears on the [API tokens](/tokens) page as *name (MCP)*, where you can revoke it. That token only works for MCP, not for the rest of the API.

If an assistant cannot sign in through the browser, [create a token](/tokens) limited to the connections it needs and pass it as a header: `Authorization: Bearer hub_…`. The examples below read it from the `HUB_TOKEN` environment variable.

## Claude Code

```bash
claude mcp add --scope user --transport http hub {{mcpUrl}}
```

Then sign in: run `/mcp` in a Claude Code session and choose **hub**, or run `claude mcp login hub`. `--scope user` makes Hub available in all your projects; leave it out to add it to the current project only.

With a token instead:

```bash
claude mcp add --scope user --transport http hub {{mcpUrl}} \
  --header "Authorization: Bearer $HUB_TOKEN"
```

## Claude Desktop and claude.ai

1. In claude.ai, open **Customize → Connectors** ([claude.ai/customize/connectors](https://claude.ai/customize/connectors)), or **Settings → Connectors** in Claude Desktop.
2. Choose **Add custom connector**, name it *Hub* and enter `{{mcpUrl}}`.
3. Choose **Connect** and approve in the Hub window that opens.

Connectors you add here are also available in Claude Desktop and in Claude Code when you are signed in with the same account. On Team and Enterprise plans, an owner may have to add the connector for the organization.

> [!NOTE]
> Claude connects from Anthropic's servers, so Hub must be reachable from the internet.

## Codex (CLI, app and IDE extension)

```bash
codex mcp add hub --url {{mcpUrl}}
codex mcp login hub
```

The CLI, the Codex app and the IDE extension share `~/.codex/config.toml`. With a token, the entry looks like this:

```toml
[mcp_servers.hub]
url = "{{mcpUrl}}"
bearer_token_env_var = "HUB_TOKEN"
```

or add it with `codex mcp add hub --url {{mcpUrl}} --bearer-token-env-var HUB_TOKEN`.

## GitHub Copilot CLI

In a Copilot CLI session, run `/mcp add`, choose **HTTP**, and enter `{{mcpUrl}}`. Copilot signs in through the browser the first time Hub is used.

Or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "hub": {
      "type": "http",
      "url": "{{mcpUrl}}"
    }
  }
}
```

To use a token, add `"headers": { "Authorization": "Bearer ${HUB_TOKEN}" }` to the entry.

## GitHub Copilot in VS Code

Add Hub to `.vscode/mcp.json` in a project, or run **MCP: Open User Configuration** for all projects:

```json
{
  "servers": {
    "hub": {
      "type": "http",
      "url": "{{mcpUrl}}"
    }
  }
}
```

VS Code asks you to sign in when Copilot first uses Hub. To use a token without storing it in the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "hub-token", "description": "Hub token", "password": true }],
  "servers": {
    "hub": {
      "type": "http",
      "url": "{{mcpUrl}}",
      "headers": { "Authorization": "Bearer ${input:hub-token}" }
    }
  }
}
```

## OpenCode

Add Hub to `opencode.json` (in a project) or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hub": {
      "type": "remote",
      "url": "{{mcpUrl}}",
      "enabled": true
    }
  }
}
```

Then sign in with `opencode mcp auth hub`. With a token, add `"headers": { "Authorization": "Bearer {env:HUB_TOKEN}" }` and `"oauth": false` to the entry.

## Other assistants

Any assistant that supports remote MCP servers over HTTP ("Streamable HTTP") works the same way: give it `{{mcpUrl}}`, and either let it sign in or give it a token header. For assistants that only run local MCP servers, [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridges the gap, including the browser sign-in:

```json
{
  "mcpServers": {
    "hub": { "command": "npx", "args": ["-y", "mcp-remote", "{{mcpUrl}}"] }
  }
}
```

> [!TIP]
> Menus in these apps change from time to time; the URL and the sign-in stay the same.

## Troubleshooting

| Problem | What to do |
|---|---|
| The assistant says Hub needs authentication | Sign in again (`/mcp` in Claude Code, `codex mcp login hub`, `opencode mcp auth hub`). Tokens that were revoked on the API tokens page stop working. |
| A connection is missing | The assistant only sees the connections you shared when signing in. Revoke its token and sign in again to choose others, or edit the token. |
| "This client may not use …" | Same as above: that connection was not shared. |
| A token works for MCP but not for the API | Tokens from an assistant's sign-in are for MCP only. Create a token on the API tokens page for scripts. |
| Requests fail with "not an allowed host" | Requests can only go to the service's own hosts, so credentials never leak elsewhere. |

Hub speaks MCP 2026-07-28, and 2025-03-26 to 2025-11-25 for older clients.
