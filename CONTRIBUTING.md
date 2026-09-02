# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/healthchecks-mcp.git && cd healthchecks-mcp
npm install
npm test          # no network access — every test runs against a stubbed fetch
npm run build
```

## Running the integration suite

The unit tests stub `fetch`. The integration suite spawns the built server over
stdio against a throwaway Healthchecks in Docker and calls **every tool in the
catalogue**.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

Two things it establishes that a stub cannot, and both are claims this
repository makes about itself:

- **A read-only key really is refused by three tools that only read.** The
  suite runs a second server holding one. It also shows the shape of the
  problem: a read-only key never sees a `uuid`, so `list_pings` cannot even be
  _addressed_ with one — the argument it wants cannot be produced by that key.
- **This server deliberately cannot ping**, because a monitoring client that
  can report success is a monitoring client that can lie. So the suite pings
  over plain HTTP itself, and `list_pings`, `get_ping_body` and `list_flips`
  then read real events rather than fixtures — including a real up→down flip.

Four things about running Healthchecks headlessly, all in `compose.yml`:

- **The image ignores `SUPERUSER_EMAIL` and `SUPERUSER_PASSWORD`.** They are in
  plenty of examples on the internet and they create nothing; the login form
  then answers "Incorrect" for an account that was never made. `manage.py` is
  the only headless way in, so the container creates the account, the project
  and both API keys before uwsgi starts.
- **A project needs a `badge_key`.** Healthchecks' own creation flow sets one;
  a project without it makes `GET /api/v3/badges/` raise `NoReverseMatch` — a
  500 with an HTML body, which reads like the endpoint being broken.
- **The database tmpfs needs `mode: 0o1777`.** The default 0755 is root-owned,
  the image runs as a non-root user, and SQLite then fails with "unable to open
  database file" while the container keeps answering 500s.
- The keys are fixed strings, so the suite can assert against them.

For poking at one tool by hand — or against your own project — the inspector:

```sh
export HEALTHCHECKS_API_KEY=...                     # 32 characters, per project
export HEALTHCHECKS_URL=https://hc.example.net      # omit for healthchecks.io
npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the suite on Node 22 and 24, plus npm audit, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/healthchecks-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/healthchecks-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/healthchecks-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
