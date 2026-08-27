# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/healthchecks-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

A Healthchecks API key is scoped to **one project**, and a read-write key grants
everything the web UI can do to that project's checks: read them, change their
schedules and notification integrations, pause them, and delete them. Deleting a
check destroys its UUID irrecoverably, which breaks every deployed script still
pinging that URL — and pausing one is quieter but no less consequential, because a
paused check raises no alerts at all.

The key also reads **ping bodies**: the output that jobs POST when they report in.
That is often the most sensitive data in a monitoring system — stack traces,
hostnames, file paths, occasionally a credential a script printed by accident. A
read-only key (`hcr_…` on the hosted service) cannot reach ping bodies at all,
which makes it the right key for most uses of this server.

What the key does **not** grant is the ability to ping. Ping URLs are authenticated
by a separate ping key that the Management API does not expose, and this server
never calls one — see "Not exposed, on purpose" in the README. A model driving it
therefore cannot make a job that never ran look as if it had.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Destructive operations require a server-generated confirmation token that is bound to
the specific target; a model cannot satisfy that gate on its own. Data returned from
the upstream API is untrusted input: it is marked as such, and confirmation prompts
never quote it.
