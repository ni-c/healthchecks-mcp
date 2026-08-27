# FAQ & troubleshooting

<!-- Keep this entry. "A tool is missing" is the one question the tool filter
     creates, and the answer people reach for first — a bug — is the wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `HEALTHCHECKS_READ_ONLY` is set, and it is a write tool.
- `HEALTHCHECKS_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `HEALTHCHECKS_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## `list_checks` says the project is empty, but it is not

Two causes, in order of likelihood.

**Something in front of the instance answered instead of the API.** An SSO
portal, a captive proxy or a login page replies `200 text/html` to
`/api/v3/checks/`. The server refuses that rather than reading it as an empty
list — an answer of "you have no checks" would be an error dressed up as data —
so you get a message naming the content type it got. Check `HEALTHCHECKS_URL`,
and try `get_status`, which needs no API key.

**The key belongs to a different project.** API keys are per project, not per
account, so a key for project A genuinely sees no checks from project B. Run
`get_api_key_info`: it reports which instance is configured and whether the key
is accepted at all.

## Everything answers 401, but the key is right

Healthchecks validates the key by **length** before it looks it up, so a key
that is not exactly 32 characters produces `401 missing api key` — which reads
as if no header was sent. This server checks the length itself and says so at
startup and on the first call, but if you are looking at a raw 401 from
somewhere else, count the characters first.

The other half of the same confusion, and the more common one: `list_pings`,
`get_ping_body` and `list_integrations` require a **read-write** key even though
they only read. A read-only key is refused there with `401 {"error": "wrong api
key"}` — the same status and the same wording as a key that does not exist,
because the API cannot distinguish "not allowed" from "not a key" at that point.

Those three tools translate it rather than passing it on, so you get a sentence
saying the key is read-only instead of one implying it is broken.
`get_api_key_info` lists exactly which tools are out of reach.

## Why can it not ping a check?

Deliberately. Pinging is a job's statement that it ran, and this same server
hands the model ping bodies written by whatever pings the check — a ping tool
would close a loop from untrusted text to falsified monitoring. Ping URLs are
also authenticated by a separate ping key that the Management API does not
expose. See [Security](/guide/security#what-the-key-cannot-do).
