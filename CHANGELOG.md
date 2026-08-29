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
