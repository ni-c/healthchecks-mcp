# Configuration

See the [environment variable reference](/reference/environment) for the full table.

## The API key

`HEALTHCHECKS_API_KEY` is a **project** API key from Project Settings → API
Access, exactly 32 characters long. Keys do not span projects: a key from project
A answers `403` for a check in project B, and because the API looks the object up
globally before checking ownership, that `403` means "right UUID, wrong key" far
more often than it means "not allowed".

The key is read once and then deleted from `process.env`, so it is not visible to
child processes or in `/proc/<pid>/environ`, and it is never placed in a request
body — the API would accept it there on POST, and it would end up in access logs.

## Read-only and read-write keys

Every project can issue both. The difference reaches further than it looks:

| With a read-only key                            | Consequence                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| checks carry no `uuid`, only a 40-char `unique_key` | `get_check` and `list_flips` accept either; nothing else can be addressed |
| no `ping_url`, `update_url` or `channels`       | you cannot see where a check is pinged                              |
| `list_pings`, `get_ping_body`, `list_integrations` are rejected | even though all three only read — that is how the API gates them |
| every write tool is rejected                    | pair it with `HEALTHCHECKS_READ_ONLY=true` so they are not offered  |

`get_api_key_info` performs two harmless GETs and tells you which kind you have,
which identifier your checks will use, and exactly which tools are out of reach.
Run it first when something answers `401` that you expected to work.

## Read-only mode

`HEALTHCHECKS_READ_ONLY=true` does not register the five write tools at all. They
are absent from `tools/list` and unknown to `tools/call` — not refused at call
time, because advertising a capability and then declining it is worse than not
advertising it.

This is the right setting whenever the model is meant to answer questions rather
than change monitoring. It also pairs naturally with a read-only API key: without
it, a model can see `delete_check`, try it, and get an opaque authorisation error
instead of a clear absence.

## TLS and self-hosted instances

`HEALTHCHECKS_URL` must be `http://` or `https://`, must carry no `user:pass@`,
and is trimmed to the site root. Over plain `http` to anything but a loopback
address the server prints a warning: the API key travels unencrypted there.

`HEALTHCHECKS_INSECURE_TLS=true` accepts a self-signed certificate. It is scoped
to this server's own connections through a dedicated undici dispatcher — it never
touches `NODE_TLS_REJECT_UNAUTHORIZED`, which would disable verification for the
whole process. Prefer putting your internal CA in the trust store; this switch is
for the afternoon when that is not yet true.

<!-- The heading below is fixed: every repository uses "Choosing the tools that
     load", so /guide/configuration#choosing-the-tools-that-load is the same anchor
     everywhere and the README, the FAQ and the tool reference can all link to it.
     Put it directly after the read-only section — they are the same knob family,
     and that adjacency does half the explaining. -->

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`HEALTHCHECKS_ALLOW_TOOLS` and `HEALTHCHECKS_DENY_TOOLS` let you draw your own:

```sh
HEALTHCHECKS_ALLOW_TOOLS=essential
HEALTHCHECKS_ALLOW_TOOLS=list_*,get_check
HEALTHCHECKS_DENY_TOOLS=delete_check,pause_check
```

Why bother, when all of them work: a model chooses the right tool far more reliably
from a handful than from a long list, and every tool it can see costs context on
every single request. If this is the only MCP server in a session, the full set is
fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or a
prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_thing` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset: `list_checks`, `get_check`, `list_pings`, `list_flips`, `create_check`, `update_check` and `resume_check`. It is marked per tool in the
[tool reference](/reference/tools), generated from the same constant the filter
reads, so the two cannot drift. It composes — naming a tool alongside it puts that
one back, and `HEALTHCHECKS_DENY_TOOLS` takes one away.

**Both together.** `HEALTHCHECKS_ALLOW_TOOLS` decides what is in;
`HEALTHCHECKS_DENY_TOOLS` is then subtracted from the result. With only a deny
list, everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable. The
same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming one
explicitly in `HEALTHCHECKS_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write tools is
fine and simply contributes nothing, which is what makes `get_*,create_*` a usable
template for both kinds of deployment; and `HEALTHCHECKS_ALLOW_TOOLS=essential`
narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and unknown to
`tools/call` alike — exactly what `HEALTHCHECKS_READ_ONLY` does to a write tool.
There is no "hidden but callable" state to reason about.
:::
