# Getting started

## Requirements

- Node.js ≥ 22
- A Healthchecks project and an API key for it. On the hosted service that is
  Project Settings → API Access; on a self-hosted instance the same page.
- Nothing else. There is no database, no state directory and no port.

## Get an API key

API keys in Healthchecks are **per project, not per account**. A key that works
for one project answers `403` for every check in another, which is the single most
common confusion with this API.

Each project offers two kinds:

| Kind           | Good for                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| **Read-only**  | Asking questions. On the hosted service it starts with `hcr_`. Cannot reach ping bodies, integrations or any write tool. |
| **Read-write** | Everything, including deleting a check.                                                                       |

Start with a read-only key if you only want to look. Note the asymmetry: three
tools that plainly only read — `list_pings`, `get_ping_body` and
`list_integrations` — still require a **read-write** key, because that is how the
API is gated. `get_api_key_info` reports which kind you gave it, so you never have
to guess from a `401`.

Whichever you use, the key is exactly 32 characters. Anything else is answered
with `401 missing api key`, which reads as if no header was sent at all — so this
server checks the length itself and says so before spending a request on it.

## Run it

```sh
HEALTHCHECKS_API_KEY=… npx -y healthchecks-mcp
```

Against a self-hosted instance, add the site root:

```sh
HEALTHCHECKS_API_KEY=… HEALTHCHECKS_URL=https://hc.example.net npx -y healthchecks-mcp
```

That is the **site root**, not the API root — `https://hc.example.net`, not
`https://hc.example.net/api/v3`. Both are accepted, because the API documentation
spells every example the long way and the suffix is trimmed, but the short form is
the one to write.

Without an API key the server still starts and lists its tools, so registries and
sandbox inspectors can introspect it. Every call except `get_status` then fails
with setup instructions instead of reaching the API.

## First calls

Three tools, in the order they are useful when something is wrong:

```
get_status          → is the instance reachable at all (no API key needed)
list_checks         → which checks exist, and which are down
get_ping_body       → what the failing job actually printed
```

From there, [connecting clients](/guide/clients) covers Claude Code, Claude
Desktop, Codex, Docker and mcp-hub, and [configuration](/guide/configuration)
covers narrowing the tool list before you hand it to a model.
