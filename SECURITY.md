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

`delete_check` **asks a person** through MCP elicitation: a dialog raised by the
server and shown by the client, which the model cannot answer on its behalf. Nothing
happens until an answer comes back, and the approval is bound to that operation on
that check.

Where the client cannot show a dialog it falls back to a server-generated token bound
the same way. That fallback is weaker and this server says so rather than implying
somebody approved: it proves the call was made twice with the same arguments, and
nothing more. `ELICITATION=false` moves a capable client onto it deliberately — it
does not remove the guard, and the server prints one line at startup saying it is
off.

`pause_check` is deliberately **not** guarded: `resume_check` puts it back and
nothing is lost in between.

### Binding is not freshness

`mcp-approval` seals the request state it carries out through the client and back
(HMAC, via the SDK's `createRequestStateCodec`), and that seal proves **binding**: a
reply whose state does not open, or opens onto a different resource key, is treated as
no answer at all. It does not prove **freshness** — nothing in it says an answer has
not been used before. Within the state's lifetime, a replayed approval for the _same_
operation on the _same_ check is indistinguishable from the original.

For this server that is currently unreachable rather than merely unlikely, and the
reason is worth writing down because it will change:

- The sealed `requestState` only travels over the wire on protocol revision
  `2026-07-28`, where the person's answer comes back as `inputResponses` on a retry.
- The SDK pinned here (`@modelcontextprotocol/server` 2.x) reports
  `LATEST_PROTOCOL_VERSION = "2025-11-25"` and
  `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26",
"2024-11-05", "2024-10-07"]`. `2026-07-28` is not among them.
- On a `2025-11-25` connection the SDK bridges the elicitation server-side: the
  question and the answer never leave the process, so there is no token to replay.

The fallback path has an answer of its own regardless: `ConfirmationStore` tokens are
single-use and spent on consumption, which the integration suite pins by deleting a
check and then failing to delete it again with the same token.

So there is **no anti-replay mechanism here, deliberately** — building one against a
path that does not exist would be untestable code guarding nothing. What this section
is for: when this server starts negotiating `2026-07-28`, the guarantee changes from
"the answer cannot be replayed" to "the answer cannot be redirected", and
`delete_check` is the tool that would want the stronger one.

## Everything the instance says is untrusted input

Confirmation prompts never quote upstream content, and every result that carries it
is prefixed with an explicit marker. That is **every tool except `get_status` on its
happy path and `get_api_key_info`**, which report on the server's own configuration
and nothing else.

It was not, before. `get_ping_body` was marked from the start, and the reason given in
`result.ts` was "above all logged ping bodies" — but the ping _header_ comes through
the same door as the ping _body_ and had no marker. A ping object carries `ua`, the
raw User-Agent of whoever pinged the check, kept to 200 characters upstream, together
with `remote_addr`, `scheme` and `method`. Nothing validates a User-Agent. Whoever
knows a ping URL sets it freely — and a ping URL is, by design, sitting in a cron job
on every monitored host, which makes it the most widely-shared secret in the system.
Fifty pings is roughly ten thousand characters of somebody else's text arriving as if
the server had said it. The same held for check names and descriptions through
`list_checks`, for `list_flips` and `list_integrations`, for the badge URLs (which
carry the project's tags), for every write tool that echoes the check back, and for
`get_status`, which put up to 4 KB of an unexpected response inside a sentence of its
own — on the one endpoint that takes no key, and is therefore exactly where something
that is not Healthchecks answers.

There is deliberately **no unmarked list renderer left in the code**. The plain
variants were removed rather than left available, because an unmarked variant next to
a marked one is something to reach for by accident.
`test/untrusted.test.ts` asserts this over the whole catalogue: every tool must appear
in its table, and every tool not explicitly excused must return the marker.
