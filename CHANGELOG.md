# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Security

- **Text written by strangers came back unmarked.** `get_ping_body` carried the
  untrusted-content marker from the start, and `result.ts` gave the reason as
  "above all logged ping bodies" — but the ping _header_ comes through the same
  door as the ping _body_ and had no marker at all. A ping object carries `ua`,
  the raw User-Agent of whoever pinged, kept to 200 characters upstream, plus
  `remote_addr`, `scheme` and `method`. Nothing validates a User-Agent, and a
  ping URL is by design sitting in a cron job on every monitored host, so this is
  the most widely-shared secret in the system. Fifty pings is roughly ten
  thousand characters of somebody else's text arriving as if the server had said
  it.

  The same held for check names and descriptions through `list_checks`, for
  `list_flips`, `list_integrations` and `list_badges` (whose URLs carry the
  project's tags), for every write tool that echoes the check back, and for
  `get_status`, which put up to 4 KB of an unexpected response inside a sentence
  of its own — on the one endpoint that takes no key, and therefore exactly where
  something that is not Healthchecks answers.

  Every tool now marks its result except `get_api_key_info` and `get_status` on
  its happy path, which report on the server's own configuration and nothing
  else. The unmarked renderers were **removed** rather than left available: an
  unmarked variant sitting next to a marked one is something to reach for by
  accident. `test/untrusted.test.ts` asserts this over the whole catalogue, so a
  tool added later cannot skip the decision.

- **A 401 was answered with "Nothing is wrong with the key itself" regardless.**
  A 401 has at least four causes — a read-only key on a read-write endpoint, a
  mistyped or rotated key, a key from a deleted project, a ping key pasted in
  place of an API key — and that sentence is false for three of them. It is also
  the first thing the operator reads, so after a key rotation it sent them to
  enter a _second_ wrong key and hunt for the fault where it was not: the exact
  confusion the translation exists to prevent, pointing the other way. The claim
  is now checked before it is made, by probing `/checks/`, which either kind of
  key can read. If that is refused too, the original 401 goes through with the
  generic hint, which names both possibilities instead of picking one.

### Fixed

- **A truncated ping body ended with its own source code.** The 64 KB truncation
  note was a single template literal with leftover `" + "` string concatenation
  inside it, so a body cut at the ceiling ended with a stray quote, a newline,
  fourteen spaces, `+ "` and then the rest of the sentence.

### Added

- Tools that need a confirmation now **ask the user**, on clients that can show
  a prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**: it is the only variable here that defaults to _on_, so
  failing open on a typo would leave the dialog running while the operator
  believed it was off. It is read after `HEALTHCHECKS_API_KEY` is wiped from the
  environment, so that exit cannot leave the key behind.

- A `docs/guide/approval.md` page.

- A test that asserts the promise this server would least like to break: every
  outgoing request, across every tool in the catalogue, starts with
  `${site}/api/v3/`. Ping URLs live outside that prefix, so a tool that gained
  the ability to ping — telling a monitoring system a backup succeeded when it
  did not, silently, because silence is what the system is watching for — would
  now fail the suite instead of being noticed by nobody. Five separate things
  held that promise up and none of them were tested.

### Removed

- **`pause_check` no longer asks for a confirmation**, and no longer declares
  `confirm_token` at all — a caller that still sends one is told rather than
  quietly ignored.

  Pausing switches alerting off, which is quiet rather than loud, and that was
  the argument for gating it. But `resume_check` puts it back and nothing is lost
  in between, and a dialog in front of a reversible state change is how people
  learn to tick without reading — which spends exactly the attention that
  `delete_check` needs. What pausing costs is stated in the tool's description
  instead.

### Changed

- `HEALTHCHECKS_READ_ONLY` now accepts `1`, `true` and `yes` in any case and
  ignores surrounding whitespace, matching the rest of the family. It only ever
  takes capability away, so an operator who wrote `HEALTHCHECKS_READ_ONLY=True`
  meant the safe thing and now gets it — where before that spelling silently left
  every write tool registered. `HEALTHCHECKS_INSECURE_TLS` stays exactly `true`
  on purpose: it weakens the server, so only the one unambiguous spelling should
  do it.

- The shared libraries move to `mcp-approval` 0.7.1, `mcp-tool-allowlist` 0.2.1,
  `mcp-integration-harness` 0.2.0 and `svg-asset-set` 0.2.0.

- Two integration assertions that could pass without the thing they name. The
  guard test used `expectError: true` plus a `read-only` substring — but
  `statusHint(401)` also contains "read-only", and `run()` appends it to any 401,
  so deleting the translation outright left the test green. Measured: with
  `needsReadWriteKey` removed the old assertions passed and the new ones fail on
  all three tools. The two "the check is really gone" checks now require
  `HTTP 404` rather than any error, which a timeout or a 429 satisfied equally.

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the confirmation store and the documentation-asset generator
  now come from **`mcp-tool-allowlist`**, **`mcp-approval`** and
  **`svg-asset-set`** rather than from copies kept here — 752 fewer lines, and
  one place to fix each. None of them has a runtime dependency of its own.

## [Unreleased]

## [0.1.0] - 2026-08-29

### Added

- Initial release: an MCP server for the
  [Healthchecks](https://healthchecks.io) Management API v3, against the hosted
  service or a self-hosted instance.
- A multi-architecture container image at `ghcr.io/ni-c/healthchecks-mcp`
  (amd64 and arm64), published with an SBOM and build provenance. It runs as an
  unprivileged user with no npm in the runtime layer and speaks stdio only, so
  it needs `-i` and exposes no port.
- Nine read tools: `list_checks`, `get_check`, `list_pings`, `get_ping_body`,
  `list_flips`, `list_integrations`, `list_badges`, `get_status` and
  `get_api_key_info`.
- Five write tools: `create_check`, `update_check`, `pause_check`, `resume_check`
  and `delete_check`.
- `get_ping_body` reads the body a job POSTed with its ping — the fastest way to
  see why a check failed, and an endpoint no other Healthchecks MCP server
  exposes.
- Read-only API keys are supported end to end: checks are addressed by
  `unique_key` where no `uuid` is returned, and `get_api_key_info` reports which
  kind of key is configured and which tools it cannot reach.
- `HEALTHCHECKS_READ_ONLY` registers only the read tools;
  `HEALTHCHECKS_ALLOW_TOOLS` / `HEALTHCHECKS_DENY_TOOLS` narrow the list further,
  with `essential` as a curated seven-tool preset.
- `pause_check` and `delete_check` are two-step: the first call returns a
  short-lived confirmation token bound to that one check.
- Results are budgeted — the Management API paginates nothing, so `list_checks`
  drops whole entries rather than overflowing the model's context, and says so.
- The server cannot ping a check, deliberately. A ping is a job's own claim that
  it ran, and the same server hands the model ping bodies written by whatever
  pings the check — a ping tool would close the loop from untrusted text to
  forged monitoring.

<!-- #endregion changelog -->
