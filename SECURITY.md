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

### Binding, and freshness

`mcp-approval` seals the request state it carries out through the client and back
(HMAC, via the SDK's `createRequestStateCodec`), and that seal proves **binding**: a
reply whose state does not open, or opens onto a different resource key, is treated as
no answer at all.

A seal alone does not prove **freshness** — nothing in it says an answer has not been
used before — so `mcp-approval` 0.8.1 added a nonce to the sealed state and spends it
on the first answer, accepted or declined. A second presentation of the same state is
treated as no answer and the person is asked again. This server carries 0.8.2.

This section used to say the opposite, and the way it was wrong is worth keeping. It
argued that the sealed state only crosses the wire on protocol revision `2026-07-28`,
that `SUPPORTED_PROTOCOL_VERSIONS` does not list it, and that there was therefore
nothing to replay and nothing to build. That constant is the list of **legacy**
revisions and never carries the modern one: `serveStdio`, which `src/index.ts` has
used since 0.3.0, negotiates it separately through `server/discover`. So the era the
argument ruled out is an era this server serves, and the paragraph stayed true-looking
through two releases.

`test/approval-replay.test.ts` now asks the question directly rather than reading a
constant next to it: a sealed state is minted, answered once, and presented again — and
the second presentation comes back as a fresh question. A test of a countermeasure has
to exercise the countermeasure.

What remains true: the record of spent states is **per process**, so a restart forgets
it. And the fallback path has an answer of its own: `ConfirmationStore` tokens are
single-use and spent on consumption, which the integration suite pins by deleting a
check and then failing to delete it again with the same token.

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

### Marking is not the whole job

A marker tells the model what the text is. It does nothing about a terminal escape in a
check name repainting the log of whoever reads the client's output, and nothing about a
lone surrogate — legal JSON, half a character — that makes a Python client raise
`UnicodeEncodeError` on the way to its own console.

So text is also **cleaned** on the way out, in both channels, by `src/clean.ts`: C0 and
C1 control characters and DEL are removed (tab, line feed and carriage return stay),
and lone surrogates become U+FFFD. Format characters — bidi marks, joiners — are kept,
because they are content in a check named in Arabic or Hindi.

Ping bodies are the interesting case. A job that prints colour writes escape sequences,
so this is the one place where a control character is _plausible_ — and it is also the
least controlled text this server touches, written by whatever holds a ping URL. They
are cleaned too, and `get_ping_body` reports `control_characters_removed` so a reader
who wonders why the output differs from what the job printed has an answer.

### What the instance sends is not what the schema promises

Every tool declares an `outputSchema`, and the SDK validates `structuredContent`
against it before the answer leaves. Until this release every response was a TypeScript
cast, which is not a check — so a `name` the instance sent as a number, an `n_pings` of
`1e999` (legal JSON, `Infinity` after parsing, refused by zod), or a `null` where a
check belonged did not spoil one field: it failed the whole call, and a listing lost
four hundred good checks over one bad one.

`src/boundary.ts` reads every field the schemas name. A field of the wrong type is
**absent** and the check keeps its row; only a value that is not an object at all
cannot be shown, and those are counted and reported rather than dropped in silence. A
`uuid` that is not shaped like one is absent too — it is spliced into request paths and
quoted into the sentence a person reads before approving a deletion.

`test/boundary.property.test.ts` drives every tool with generated responses and asserts
that `Output validation error`, `Cannot read properties` and `is not a function` never
reach the caller.
