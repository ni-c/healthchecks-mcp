# Tools

One section per tool: what it does, its parameters, and — for the one guarded
tool — what a person is asked.

All of them are registered unless you say otherwise. `HEALTHCHECKS_ALLOW_TOOLS` and
`HEALTHCHECKS_DENY_TOOLS` narrow the list to the ones you want, and `essential`
selects the ones marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Every tool declares an `outputSchema` and answers with `structuredContent` beside
the text block, so a client can use a result without parsing prose. Every tool
that reports anything from the instance carries `untrusted: true` and
`source: "healthchecks"` as fields of that object — `get_api_key_info` is
without it, and `get_status` carries it only when the instance answered
something other than `OK`.

Three markers recur:

- 👤 **asks a person** — through MCP elicitation, a dialog the model cannot answer
  on its behalf. Where the client cannot show one, the tool falls back to a
  two-call `confirm_token`. See [Asking a person](/guide/approval).
- 🔑 **needs a read-write key** — the tool only reads, but Healthchecks gates the
  endpoint behind a read-write key anyway, and refuses a read-only one with
  `401 "wrong api key"`. The tool says what that really means.
- 🆔 **needs a UUID** — a `unique_key` will not do, because the API routes that
  path on a UUID-shaped segment and answers anything else with a bare 404.

<!-- test/docs.test.ts asserts that the headings here are exactly ALL_TOOLS and
     that the **essential** markers are exactly ESSENTIAL_TOOLS, so this page
     cannot drift from src/tools/catalogue.ts. -->

## Read tools

Registered always, including under `HEALTHCHECKS_READ_ONLY`.

### `list_checks`

**essential**

Lists the checks of the project the API key belongs to, as compact summaries —
identifier, name, slug, tags, status, last and next ping, and either `timeout` or
`schedule`. Descriptions are omitted; `get_check` has them.

| Parameter | Type                                          | Notes                                                        |
| --------- | --------------------------------------------- | ------------------------------------------------------------ |
| `tag`     | string[]                                      | Only checks carrying **all** of these. A tag cannot contain a space |
| `slug`    | string                                        | Slugs are not unique, so this can match several               |
| `status`  | `new` `up` `grace` `down` `paused`            | Filtered client-side — the API offers no status filter        |
| `limit`   | number, 1…500                                 | Default 50                                                    |

The endpoint has no pagination whatsoever: it returns every check in the project
in one response. `limit` and the result budget are this server's, and the result
says how many checks the project actually holds.

### `get_check`

**essential**

One check with every field, including `desc` and the keyword filters. `channels`
is split into a list, the legacy derived `subject` / `subject_fail` are dropped,
and `schedule_kind` says whether the check is driven by `timeout` or by
`schedule` — the API has no `kind` field, only the presence of one or the other.

| Parameter | Type   | Notes                                                       |
| --------- | ------ | ----------------------------------------------------------- |
| `check`   | string | A UUID **or** a 40-character `unique_key`. Not a slug        |

Returned as untrusted content: `desc` is free text.

### `list_pings` 🔑 🆔

**essential**

Recent pings of a check, newest first, each with type, timestamp, ping number,
source address, method and — where one was recorded — duration and `body_url`.

| Parameter | Type                                        | Notes                     |
| --------- | ------------------------------------------- | ------------------------- |
| `check`   | string                                      | UUID                      |
| `type`    | `success` `start` `fail` `log` `ign`        | Filtered client-side      |
| `limit`   | number, 1…500                               | Default 50                |

The instance caps this at 100 pings on a free plan and 1000 on a paid one, and
there is no pagination, so older pings cannot be reached at all.

### `get_ping_body` 🔑 🆔

The body a job POSTed with one ping — usually its output, and the fastest way to
see why a check failed. Returned as untrusted content, truncated at 64 KB.

| Parameter | Type   | Notes                            |
| --------- | ------ | -------------------------------- |
| `check`   | string | UUID                             |
| `n`       | number | Ping number, as `list_pings` reports it |

A 404 here means any of four things — no such check, no such ping, the ping
carried no body, or the ping is older than the instance keeps — and the tool says
all four rather than passing the number on. A 503 is the object storage being
briefly unavailable and is worth retrying.

### `list_flips`

**essential**

The up/down transitions of a check: the history behind its current status.

| Parameter | Type   | Notes                                              |
| --------- | ------ | -------------------------------------------------- |
| `check`   | string | UUID or `unique_key`                                |
| `seconds` | number | Only flips from the last N seconds                  |
| `start`   | number | Unix timestamp — only flips newer than this         |
| `end`     | number | Unix timestamp — only flips older than this         |
| `limit`   | number | Default 50                                          |

The instance keeps the current month and the two before it. A window that runs
backwards is refused here rather than at the API.

### `list_integrations` 🔑

The project's notification integrations, with the UUIDs that `create_check` and
`update_check` accept in `channels`. Integrations themselves can only be created
in the web UI; the Management API has no endpoint for it.

No parameters.

### `list_badges`

The project's status badge URLs, one entry per tag plus `*` for the project as a
whole. The plain variants treat a check in its grace period as up; the ones
suffixed `3` report up, late and down separately.

No parameters.

### `get_status`

Whether the configured instance is reachable and its database is answering. This
endpoint needs **no API key**, which makes it the first thing to try when
something is not working — it separates "wrong key" from "wrong URL".

No parameters.

### `get_api_key_info`

Which instance is configured, whether the key is accepted, and whether it is
read-only or read-write — which in turn decides whether checks are identified by
`uuid` or by `unique_key` and which tools are reachable at all. Runs two harmless
GETs to find out rather than guessing from the `hcr_` prefix, which only the
hosted service uses.

No parameters.

## Write tools

Registered unless `HEALTHCHECKS_READ_ONLY=true`. All of them need a read-write API
key and a UUID.

### `create_check`

**essential**

Creates a check.

| Parameter                                                   | Type       | Notes                                                     |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| `name`, `slug`, `desc`                                       | string     | `slug` needs an instance with API v3                       |
| `tags`                                                       | string[]   | Stored space-delimited, so no tag may contain a space      |
| `timeout`                                                    | number     | Seconds, 60…31536000                                       |
| `schedule`, `tz`                                             | string     | Cron or systemd OnCalendar, plus an IANA zone              |
| `grace`                                                      | number     | Seconds, 60…31536000                                       |
| `channels`                                                   | `*` or string[] | Integration UUIDs or exact names. **Default `*`**     |
| `manual_resume`                                              | boolean    | A paused check then ignores pings until `resume_check`     |
| `methods`                                                    | `""` or `POST` | `""` accepts HEAD, GET and POST                        |
| `start_kw`, `success_kw`, `failure_kw`                       | string[]   | Stored comma-delimited, so no keyword may contain a comma  |
| `filter_subject`, `filter_body`, `filter_http_body`, `filter_default_fail` | boolean | Where the keywords apply                |
| `unique`                                                     | string[]   | `name` `slug` `tags` `timeout` `grace` — turns this into an upsert |

Three things the API does that this tool does not simply forward:

- **`timeout` and `schedule` cannot be combined.** Upstream, `schedule` wins and
  `timeout` is discarded without a word. Passing both is an error here.
- **`channels` defaults to `*`.** The API's own default is *no* integrations,
  which produces a check that looks healthy, reports correctly and never tells
  anyone when it stops. The result says which default was applied.
- **An empty `channels` list is refused.** It serialises to the empty string,
  which the API reads as "no integrations" — the same silent loss of alerting
  that `pause_check` is gated for. Clearing every integration is done in the
  web UI, in front of someone who can see what it means.
- **`unique` turns a create into an update.** When it matches, the API returns
  200 and the modified existing check instead of 201. The result says so.

### `update_check` 🆔

**essential**

Changes the given fields of a check; anything not passed stays as it was. Takes
the same parameters as `create_check` (minus `unique`) plus `check`.

Two exceptions to "not passed stays as it was": `channels` **replaces** the
integration list rather than adding to it, and setting `schedule` on a check that
used `timeout` switches it over. An update with no fields at all is refused rather
than sent.

### `pause_check` 🆔

Pauses a check: it stops expecting pings, and stops alerting.

| Parameter | Type   | Notes |
| --------- | ------ | ----- |
| `check`   | string | UUID  |

**Not gated**, and it used to be. `resume_check` puts it back and nothing is lost in
between; a dialog in front of a reversible state change is how people learn to tick
without reading, and that attention is what `delete_check` needs. What pausing costs
is stated in the description instead: while paused, a job that stops running goes
unnoticed.

### `resume_check` 🆔

**essential**

Puts a paused check back into the `new` state, waiting for its next ping. Not
gated: it restores alerting rather than removing it. Answers 409 if the check was
not paused.

| Parameter | Type   | Notes |
| --------- | ------ | ----- |
| `check`   | string | UUID  |

### `delete_check` 👤 🆔

Deletes a check permanently.

| Parameter       | Type   | Notes                          |
| --------------- | ------ | ------------------------------ |
| `check`         | string | UUID                            |
| `confirm_token` | string | From the first call of this tool |

**Asks a person first**, and marked destructive to the client. The UUID cannot be
recovered and no new check can take it, so everything still pinging that URL breaks.
The confirmation text says so and points at `pause_check` as the reversible
alternative. `confirm_token` is only used on the fallback path, where the client
cannot show a dialog. The API returns the deleted object, and this tool keeps it in the
result — the last record of what the check was.
