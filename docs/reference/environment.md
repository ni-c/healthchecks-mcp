# Environment variables

| Variable                    | Required | Default                  | Description                                                                |
| --------------------------- | -------- | ------------------------ | -------------------------------------------------------------------------- |
| `HEALTHCHECKS_API_KEY`      | yes      | —                        | Project API key, exactly 32 characters. Read-only or read-write             |
| `HEALTHCHECKS_URL`          | no       | `https://healthchecks.io` | Site root of a self-hosted instance. A trailing `/api/vN` is trimmed        |
| `HEALTHCHECKS_READ_ONLY`    | no       | `false`                  | `true` registers only the read tools                                        |
| `HEALTHCHECKS_ALLOW_TOOLS`  | no       | —                        | Tool names, `list_*` prefixes or `essential`; only these register            |
| `HEALTHCHECKS_DENY_TOOLS`   | no       | —                        | Same syntax; subtracted from whatever the allow list left                    |
| `HEALTHCHECKS_INSECURE_TLS` | no       | `false`                  | `true` accepts self-signed certificates, scoped to this connection           |
| `ELICITATION`               | no       | `true`                   | `false` replaces the approval dialog with the two-call token. **Not prefixed** |

The `HEALTHCHECKS_*` booleans are the exact string `true`; anything else, including
`1` and `TRUE`, is false. `ELICITATION` is the exception in both directions — see
below.

## `ELICITATION`

Whether a client that *can* show a dialog is asked before `delete_check` acts.
Default `true`. `false` takes the two-call-token path instead — it does not remove
the guard, and a server started with it off prints one line saying so.

Two ways it differs from every other variable here:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the same
  environment, not just this one. That is the point of it and also its risk; see
  [Asking a person](/guide/approval).
- **Fatal on anything else.** `1`, `off` or a typo stop the server with exit code 1
  rather than falling back to the default. It is the only variable of this family
  that defaults to *on*, and a typo that fell back would leave the dialog running
  while you believed it was off.

Values are trimmed and matched case-insensitively. It is read *after*
`HEALTHCHECKS_API_KEY` is deleted from `process.env`, so the fatal path cannot leave
the key sitting there for a crash reporter.

## `HEALTHCHECKS_API_KEY`

Per **project**, not per account — Project Settings → API Access. Exactly 32
characters; the upstream answers any other length with `401 missing api key`,
which looks like a header that never arrived, so the server checks the length
itself at startup and before each call.

Read from the environment once and then deleted from `process.env`, so it is not
visible to child processes. It is sent as `X-Api-Key` and never in a request body.

A read-only key (`hcr_…` on the hosted service) reaches `list_checks`,
`get_check`, `list_flips` and `list_badges`. It does not reach `list_pings`,
`get_ping_body`, `list_integrations` or any write tool. See
[read-only and read-write keys](/guide/configuration#read-only-and-read-write-keys).

## `HEALTHCHECKS_URL`

The site root of a self-hosted instance: `https://hc.example.net`. Must be
`http:` or `https:` and must not carry `user:pass@` credentials — both are fatal
at startup, because a malformed target is the one misconfiguration that can send
the key to the wrong host. Plain `http` to a non-loopback host warns and
continues.

A value ending in `/api/v1`, `/api/v2` or `/api/v3` is trimmed back to the site
root, so a URL copied out of the API documentation works as well as the short one.

## Narrowing the tool list

The syntax, exactly; for why you would want it, see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

`HEALTHCHECKS_ALLOW_TOOLS` and `HEALTHCHECKS_DENY_TOOLS` are comma-separated.
Each entry is either an exact tool name or a prefix with a single trailing `*`:

| Value                      | Registers                                                             |
| -------------------------- | --------------------------------------------------------------------- |
| `essential`                | the curated preset, marked in the [tool reference](/reference/tools)   |
| `list_*,get_check`         | exactly those                                                          |
| `list_*`                   | every tool whose name starts with `list_`                              |
| `*`                        | everything — the same as leaving it unset                              |

Entries are trimmed and matched case-insensitively; empty entries are ignored, and a
value that is empty or only whitespace counts as unset — `HEALTHCHECKS_ALLOW_TOOLS=`
in a compose file does not mean "allow nothing". `essential` is recognised only in the
allow list.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_check` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `HEALTHCHECKS_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive list is
written.
