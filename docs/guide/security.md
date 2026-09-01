# Security

This page is the prose version of [SECURITY.md](https://github.com/ni-c/healthchecks-mcp/blob/main/SECURITY.md).

## Trust model

A Healthchecks API key is scoped to **one project**. A read-write key grants
everything the web UI can do to that project's checks: read them, change their
schedules and notification integrations, pause them, delete them.

Two of those deserve naming individually.

- **Deleting a check destroys its UUID irrecoverably.** Every deployed script
  still pinging that URL breaks, and no new check can take the old UUID.
- **Pausing a check switches its alerting off.** It is reversible and it is quiet,
  which is the dangerous combination: the dashboard stops complaining and so does
  the job that stopped running.

The key also reads **ping bodies** — the output jobs POST when they report in.
That is often the most sensitive data in a monitoring system: stack traces,
hostnames, file paths, occasionally a credential a script printed by accident.
A read-only key cannot reach ping bodies at all, which makes it the right key for
most uses of this server.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a project whose ping bodies you would not put in a model's context.

## What the key cannot do

It cannot ping. Ping URLs are authenticated by a **ping key**, a separate
per-project secret that the Management API does not expose, and this server never
calls one.

That is a deliberate boundary, not an omission. Pinging is a job's statement that
it ran. A tool able to ping would let a model report success for something that
never executed — and since this same server hands the model ping bodies written by
whatever pings the check, that would close a loop from untrusted text to falsified
monitoring. There is no such tool, so there is no such loop.

## The confirmation, honestly

One tool asks a person before it acts: `delete_check`. Where the MCP client supports
elicitation that is a **dialog** shown to whoever is sitting there — the model cannot
answer it on their behalf, and nothing happens until an answer comes back.

A boolean could be set on the very first call, including by a model that read an
instruction telling it to.

Where the client cannot show a dialog, the tool falls back to a random 32-hex token
with a five-minute lifetime, single-use, bound to a SHA-256 fingerprint of *this
operation on this check*. Be clear about what that proves, because this server is:
**the call was made twice with the same arguments, and nothing more.** A model can
read the token out of the first result and quote it back in the same turn. The
fallback text says so rather than implying somebody approved, and names whether it
was the client that could not be asked or the operator who switched the dialog off
with `ELICITATION=false`.

::: info `pause_check` used to be gated, and is not any more
Pausing switches alerting off, which is quiet rather than loud — but `resume_check`
puts it back and nothing is lost in between. A dialog in front of a reversible state
change is how people learn to tick without reading, and that attention is what
`delete_check` needs. What pausing costs is stated in the tool's description
instead.
:::

The prompt quotes **no** name, description or tag from Healthchecks. Those are free
text this server does not control and that text is read by a model.

See [Asking a person](/guide/approval) for what the dialog contains, which clients
show one, and what `ELICITATION=false` does and does not change.

## Untrusted content

`get_ping_body` returns whatever POSTed it. `get_check` returns a free-text
description. Both are wrapped with an explicit marker saying they are data and not
instructions.

The marker is a signal, not a sandbox: it makes the boundary visible to the model
rather than enforcing it. The enforcement is elsewhere — in the confirmation
tokens, which no amount of text in a ping body can satisfy, and in
`HEALTHCHECKS_READ_ONLY`, which removes the write tools from existence rather than
declining them.

## Limits and truncation

Every response is read with a byte ceiling enforced *while it streams*, not after,
because `content-length` is absent on a chunked response. A JSON document that
would have to be cut is refused rather than returned half-parsed. Ping bodies are
capped at 64 KB and say when they were truncated. Upstream error bodies are cut to
2000 characters, and HTML error pages — a reverse proxy's or a WAF's — are dropped
entirely rather than pasted into the context.

The Management API paginates nothing, so `list_checks` and `list_pings` apply
their own ceiling, drop whole entries rather than cutting the JSON, and name the
argument that narrows the request.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/healthchecks-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
API keys, hostnames or ping bodies in a report.
