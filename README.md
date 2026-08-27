# healthchecks-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/healthchecks-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/healthchecks-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/healthchecks-mcp)](https://www.npmjs.com/package/healthchecks-mcp)
[![npm downloads](https://img.shields.io/npm/dm/healthchecks-mcp)](https://www.npmjs.com/package/healthchecks-mcp)
[![node](https://img.shields.io/node/v/healthchecks-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/healthchecks-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fhealthchecks--mcp-blue)](https://github.com/ni-c/healthchecks-mcp/pkgs/container/healthchecks-mcp)
[![docs](https://img.shields.io/badge/docs-healthchecks--mcp.ni--c.de-informational)](https://healthchecks-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Healthchecks](https://healthchecks.io), the dead man's switch for cron jobs and
scheduled tasks — it alerts you when a job stops checking in. Works against the
hosted service and against a self-hosted instance alike.

Lets MCP clients like Claude Code, Claude Desktop or Codex see which scheduled
jobs are healthy, read the output the failing one reported, and create or adjust
checks — with the irreversible operations behind a confirmation token and the
write tools switchable off entirely.

Fourteen tools is the ceiling, not the floor:
`HEALTHCHECKS_ALLOW_TOOLS=essential` registers a curated seven instead, and a
model picks the right tool far more reliably from seven than from fourteen — see
[choosing which tools load](#choosing-which-tools-load).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://healthchecks-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://healthchecks-mcp.ni-c.de/architecture-light.svg">
  <img src="https://healthchecks-mcp.ni-c.de/architecture.svg" alt="An MCP client talks to healthchecks-mcp over stdio; the server calls the Healthchecks Management API v3 over HTTPS." width="800">
</picture>

![Listing the tools, narrowing them to the essential preset, and the startup abort a mistyped tool name produces](https://healthchecks-mcp.ni-c.de/demo.gif)

## What makes it different

**It reads the ping bodies.** `get_ping_body` returns what a job actually printed
when it reported failure. Every other question — which check is down, since when,
how often — is one step away from that one, and it is the endpoint the other
Healthchecks MCP servers leave out.

**Read-only API keys work properly.** Healthchecks hands a read-only key a
different object: no `uuid`, no `ping_url`, no `channels` — a 40-character
`unique_key` instead. This server addresses checks by either, and
`get_api_key_info` tells you up front which kind of key you configured and which
tools it cannot reach, rather than leaving you with a `401 missing api key` for a
key that was sent.

**It never pings a check.** Pinging is how a job reports that it ran. A tool that
could ping would let a model make a dead job look alive, which is the one thing
monitoring must not allow — see [Not exposed, on purpose](#not-exposed-on-purpose).

**It knows where this API is sharp.** `timeout` and `schedule` cannot be combined
because the upstream silently discards one of them; tags are validated against
their space separator and keywords against their comma; a new check is given
every integration unless you say otherwise, because the API's own default is a
check that alerts nobody.

## Requirements

- Node.js ≥ 22
- A **Healthchecks** project API key — Project Settings → API Access. Keys are per
  project, not per account, and are exactly 32 characters long.

## Configuration

| Variable                    | Required | Description                                                                                           |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `HEALTHCHECKS_API_KEY`      | yes      | Project API key. A read-only key works for part of the tool surface — see below                       |
| `HEALTHCHECKS_URL`          | no       | Site root of a self-hosted instance, e.g. `https://hc.example.net`. Default `https://healthchecks.io` |
| `HEALTHCHECKS_READ_ONLY`    | no       | `true` registers only the read tools                                                                  |
| `HEALTHCHECKS_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset                    |
| `HEALTHCHECKS_DENY_TOOLS`   | no       | Same syntax; removed from whatever `HEALTHCHECKS_ALLOW_TOOLS` left                                    |
| `HEALTHCHECKS_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection)                                   |

`HEALTHCHECKS_URL` is the site root, not the API root: `https://hc.example.net`,
not `https://hc.example.net/api/v3`. Both are accepted — the suffix is trimmed —
because the API documentation spells every example the long way.

> **Use `https://`.** Over plain http the API key travels unencrypted; the server
> prints a warning unless the host is local. For self-signed certificates prefer a
> proper internal CA over `HEALTHCHECKS_INSECURE_TLS`.

Without an API key the server still starts and lists its tools (so registries and
inspectors can introspect it), but every call except `get_status` fails with setup
instructions instead of reaching the API.

**Read-only keys.** Healthchecks gates three tools that only read — `list_pings`,
`get_ping_body` and `list_integrations` — behind a read-write key anyway. With a
read-only key those fail, along with all five write tools.

The failure does not look like a permission problem: the API answers
`401 {"error": "wrong api key"}`, which reads as if the key were wrong or
missing. It is not — those three tools translate it into what actually happened.
`get_api_key_info` reports which kind of key is configured, and
`HEALTHCHECKS_DENY_TOOLS` is the tidy way to stop offering them at all.

### Choosing which tools load

`HEALTHCHECKS_ALLOW_TOOLS` and `HEALTHCHECKS_DENY_TOOLS` take comma-separated tool
names; a trailing `*` matches a whole family. `essential` is a curated preset —
`list_checks`, `get_check`, `list_pings`, `list_flips`, `create_check`,
`update_check` and `resume_check` — marked as such in the
[tool reference](https://healthchecks-mcp.ni-c.de/reference/tools).

```sh
HEALTHCHECKS_ALLOW_TOOLS=essential
HEALTHCHECKS_ALLOW_TOOLS=list_*,get_check
HEALTHCHECKS_DENY_TOOLS=delete_check,pause_check
```

An entry that matches no tool aborts startup and names it, so a typo cannot silently
hide a tool — an absent tool is not something anyone traces back to an environment
variable. A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike, exactly like a write tool under
`HEALTHCHECKS_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de) is
the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

## Installation

### Claude Code

```sh
claude mcp add healthchecks-mcp -- npx -y healthchecks-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "healthchecks-mcp": {
      "command": "npx",
      "args": ["-y", "healthchecks-mcp"],
      "env": {
        "HEALTHCHECKS_API_KEY": "…"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.healthchecks-mcp]
command = "npx"
args = ["-y", "healthchecks-mcp"]
env = { HEALTHCHECKS_API_KEY = "…" }
```

### Docker

```sh
docker run --rm -i \
  -e HEALTHCHECKS_API_KEY=… \
  ghcr.io/ni-c/healthchecks-mcp
```

Add `-e HEALTHCHECKS_URL=https://hc.example.net` for a self-hosted instance.

## Tools

Read tools are always registered. 🔑 marks the ones Healthchecks requires a
read-write key for even though they only read; 👤 marks the ones that ask for a
confirmation token before acting.

| Tool                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `list_checks`          | Checks in the project, with `tag`, `slug` and `status` filters |
| `get_check`            | One check with every field, by UUID or `unique_key`            |
| `list_pings` 🔑        | Recent pings of a check, newest first                          |
| `get_ping_body` 🔑     | The body a job POSTed with one ping — its output               |
| `list_flips`           | Up/down transitions of a check, with a time window             |
| `list_integrations` 🔑 | Notification integrations and the UUIDs the write tools accept |
| `list_badges`          | Status badge URLs, per tag and for the project                 |
| `get_status`           | Whether the instance is reachable — needs no API key at all    |
| `get_api_key_info`     | Which instance, which kind of key, and what that key cannot do |

Write tools are registered unless `HEALTHCHECKS_READ_ONLY=true`.

| Tool              | Description                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `create_check`    | Creates a check. Notifies every integration unless `channels` says otherwise                              |
| `update_check`    | Changes the given fields. `channels` replaces the list rather than adding to it; an empty list is refused |
| `pause_check` 👤  | Stops the check expecting pings — and alerting                                                            |
| `resume_check`    | Puts a paused check back into the `new` state                                                             |
| `delete_check` 👤 | Deletes a check. The UUID is not recoverable                                                              |

## Not exposed, on purpose

- **Pinging.** The server never calls a ping URL. Pinging is how a job says it
  ran; a tool that could ping would let a model — or text a model read — report
  success for a job that never executed, and a monitoring system that can be
  talked into a green status is worse than none.
- **Ping keys.** They are not readable through the Management API, and this server
  does not ask for one.
- **Creating integrations.** The API has no endpoint for it; they are configured
  in the web UI. `list_integrations` reads them.
- **The `unique` upsert as a default.** `create_check` accepts it and says loudly
  in its result when it was used, because it turns a create into a silent update
  of a check that already exists.

## Safety

- **`pause_check` and `delete_check` are two-step.** The first call returns a
  short-lived confirmation token bound to that exact check and that exact
  operation; only a second call carrying that token acts. A model cannot satisfy
  this gate on its own, and a pause token is not a delete token.
- **Confirmation prompts never quote content from Healthchecks** — a check's name
  and description are free text this server does not control, and that text is
  read by a model.
- **Ping bodies and check descriptions are marked as untrusted data**, because
  anything that can ping a check can write into them.
- Error bodies are truncated, HTML error pages are dropped, and every response has
  a byte ceiling enforced while it streams — the Management API paginates nothing.
- `HEALTHCHECKS_READ_ONLY=true` does not register the write tools at all, and
  `HEALTHCHECKS_DENY_TOOLS` cuts finer along the same line — a filtered tool is
  never built, not refused at call time.
- The API key is deleted from `process.env` once it has been read, and never
  travels in a request body.

## Development

```sh
npm install
npm run lint && npm run build && npm run test:coverage
```

## Releasing

1. Add the CHANGELOG entry and bump `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`
3. Commit, then push a signed tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin main vX.Y.Z`

The release workflow publishes to npm (Trusted Publishing, with provenance), creates
the GitHub release from the CHANGELOG section and updates the MCP Registry entry.

## License

MIT © Willi Thiel
