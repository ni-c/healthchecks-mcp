# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/healthchecks-mcp.git && cd healthchecks-mcp
npm install
npm test          # no network access — every test runs against a stubbed fetch
npm run build
```

A minimal dev environment:

```sh
# Point it at your own Healthchecks project. A read-only key (hcr_… on the
# hosted service) is enough for everything except the write tools.
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
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/healthchecks-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/healthchecks-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/healthchecks-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
