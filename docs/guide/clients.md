# Connecting clients

## Claude Code

```sh
claude mcp add healthchecks-mcp -- npx -y healthchecks-mcp
```

Add `HEALTHCHECKS_URL` for a self-hosted instance:

```sh
claude mcp add healthchecks-mcp \
  -e HEALTHCHECKS_API_KEY=… \
  -e HEALTHCHECKS_URL=https://hc.example.net \
  -- npx -y healthchecks-mcp
```

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "healthchecks-mcp": {
      "command": "npx",
      "args": ["-y", "healthchecks-mcp"],
      "env": {
        "HEALTHCHECKS_API_KEY": "…",
        "HEALTHCHECKS_READ_ONLY": "true"
      }
    }
  }
}
```

`HEALTHCHECKS_READ_ONLY` is shown here on purpose: a desktop assistant is usually
the place you want to ask about monitoring, not the place you want to delete a
check from.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.healthchecks-mcp]
command = "npx"
args = ["-y", "healthchecks-mcp"]
env = { HEALTHCHECKS_API_KEY = "…", HEALTHCHECKS_ALLOW_TOOLS = "essential" }
```

## MCP Inspector

To see the tool list and try a call without a client:

```sh
npx -y @modelcontextprotocol/inspector npx -y healthchecks-mcp -e HEALTHCHECKS_API_KEY=…
```

Or non-interactively, which is also how the tool filter is easiest to verify:

```sh
npx -y @modelcontextprotocol/inspector --cli npx -y healthchecks-mcp \
  -e HEALTHCHECKS_ALLOW_TOOLS=essential \
  --method tools/list | jq -r '.tools[].name'
```

::: warning `-e` goes after the command, and exporting does not work
The Inspector does **not** pass your shell's environment to the server it spawns,
so `HEALTHCHECKS_ALLOW_TOOLS=essential npx … inspector …` runs with no filter at
all and prints all fourteen tools — looking exactly like a broken filter. Pass
every variable with `-e`, placed after the command being launched.
:::

## Docker

```sh
docker run --rm -i \
  -e HEALTHCHECKS_API_KEY=… \
  ghcr.io/ni-c/healthchecks-mcp
```

The image is multi-architecture (amd64 and arm64), runs as the unprivileged `node`
user, carries no npm, and speaks stdio only — there is no port to publish. `-i` is
required: without it the transport has no stdin.

<!-- "Through mcp-hub" goes here: after Docker, which is the last "how you actually
     run it" section, and before anything about the artifact (Pinning a version,
     From source, Verifying what you install). It is a peer of the other clients,
     never ranked above them.

     The third paragraph is the one that matters and must not be cut. It is the
     only place the two filters sit side by side, and "allowTools": ["essential"]
     in mcp.json — which does nothing — is exactly the mistake this section exists
     to prevent. -->

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so healthchecks-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have:

```json
{
  "mcpServers": {
    "healthchecks-mcp": {
      "command": "npx",
      "args": ["-y", "healthchecks-mcp"],
      "env": {
        "HEALTHCHECKS_URL": "https://hc.example.net",
        "HEALTHCHECKS_API_KEY": "…",
        "HEALTHCHECKS_ALLOW_TOOLS": "essential"
      },
      "denyTools": ["delete_check,pause_check"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is a healthchecks-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/healthchecks-mcp/mcp` as a connector and you get this server
alone. Register the hub's `/hub` endpoint instead and you reach _every_ server
behind it through six meta-tools, which is the answer worth having once you run
several of these at once.
