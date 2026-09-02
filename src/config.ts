/** Where the SaaS lives. Self-hosted instances set `HEALTHCHECKS_URL` instead. */
export const DEFAULT_URL = 'https://healthchecks.io';

/**
 * Healthchecks validates the key by length before it ever looks it up:
 * `if len(api_key) != 32: return error("missing api key", 401)`. A key of any
 * other length therefore produces "missing api key" rather than "wrong api key",
 * which reads like the header never arrived.
 */
export const API_KEY_LENGTH = 32;

export interface Config {
  /**
   * Site root of the Healthchecks instance, e.g. `https://healthchecks.io` or
   * `https://hc.example.net`. The `/api/v3` prefix is added by the API client —
   * a URL that already ends in `/api/vN` is accepted and trimmed back.
   */
  url: string;
  /** True when the URL came from {@link DEFAULT_URL} rather than the environment. */
  usingDefaultUrl: boolean;
  /**
   * May be undefined: the server still starts and lists its tools, and every
   * authenticated call then fails with {@link missingConfigMessage}. Only
   * `get_status` works without it.
   */
  apiKey: string | undefined;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

  /**
   * Raw value of `HEALTHCHECKS_ALLOW_TOOLS` — comma-separated tool names,
   * `list_*` prefixes, or `essential`. Kept unparsed on purpose: this file is a
   * mirror of the environment, and the names can only be checked against the
   * tool catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `HEALTHCHECKS_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: HEALTHCHECKS_API_KEY (a project API key, exactly 32 characters, ' +
    'from Project Settings → API Access)\n' +
    `Optional: HEALTHCHECKS_URL for a self-hosted instance (default ${DEFAULT_URL}), ` +
    'HEALTHCHECKS_READ_ONLY=true to expose only read tools, ' +
    'HEALTHCHECKS_INSECURE_TLS=true to accept self-signed certificates, ' +
    'HEALTHCHECKS_ALLOW_TOOLS / HEALTHCHECKS_DENY_TOOLS to narrow the tool list ' +
    '(comma-separated names, "list_*" prefixes, or "essential")'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return config.apiKey ? [] : ['HEALTHCHECKS_API_KEY'];
}

/**
 * Complaint about a key that is present but cannot work, or `undefined`.
 *
 * Separate from {@link missingConfigKeys} because the failure mode is different:
 * a key of the wrong length is answered with "missing api key" by the upstream,
 * which sends the reader looking for a header that was in fact sent.
 */
export function malformedApiKeyMessage(config: Config): string | undefined {
  if (config.apiKey === undefined) return undefined;
  if (config.apiKey.length === API_KEY_LENGTH) return undefined;
  return (
    `HEALTHCHECKS_API_KEY is ${config.apiKey.length} characters long, but ` +
    `Healthchecks only accepts keys of exactly ${API_KEY_LENGTH} characters and ` +
    'answers anything else with HTTP 401 "missing api key". Copy the key again ' +
    'from Project Settings → API Access — note that keys are per project, not ' +
    'per account, and that a ping key is not an API key.'
  );
}

/**
 * True for a key the upstream will treat as read-only.
 *
 * healthchecks.io marks read-only keys with an `hcr_` prefix
 * (`request.readonly = api_key.startswith("hcr_") or …`). A self-hosted instance
 * can also have an unprefixed read-only key, which is why every caller of this
 * treats a false answer as "probably read-write", never as a guarantee.
 */
export function looksReadOnlyKey(apiKey: string | undefined): boolean {
  return apiKey !== undefined && apiKey.startsWith('hcr_');
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `healthchecks-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * Reads the configuration from environment variables.
 *
 * A missing API key is only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without one, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the key to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.HEALTHCHECKS_URL;
  const apiKey = env.HEALTHCHECKS_API_KEY;
  // `HEALTHCHECKS_INSECURE_TLS` stays exact on purpose: it *weakens* the
  // server, so only the one spelling that unambiguously asks for it should do
  // it.
  const insecureTls = env.HEALTHCHECKS_INSECURE_TLS === 'true';
  // `HEALTHCHECKS_READ_ONLY` is the other direction — it only ever takes
  // capability away — so the fleet form is generous with the spelling. An
  // operator who wrote `1` or `yes` meant the safe thing, and
  // `HEALTHCHECKS_READ_ONLY=true ` with a trailing space used to mean the
  // unsafe one.
  const readOnly = /^(1|true|yes)$/i.test(
    env.HEALTHCHECKS_READ_ONLY?.trim() ?? ''
  );
  const allowTools = env.HEALTHCHECKS_ALLOW_TOOLS;
  const denyTools = env.HEALTHCHECKS_DENY_TOOLS;

  // Don't keep the key in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ.
  delete env.HEALTHCHECKS_API_KEY;

  // After the delete, deliberately: this one can exit the process, and an exit
  // above would leave the credential in the environment for whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  if (!apiKey) {
    console.error(
      `healthchecks-mcp: ${missingConfigMessage(['HEALTHCHECKS_API_KEY'])}`
    );
  }

  const config: Config = {
    url: DEFAULT_URL,
    usingDefaultUrl: true,
    apiKey,
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };

  const malformed = malformedApiKeyMessage(config);
  if (malformed) console.error(`healthchecks-mcp: WARNING: ${malformed}`);

  if (!rawUrl) return config;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`healthchecks-mcp: HEALTHCHECKS_URL is not a valid URL`);
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `healthchecks-mcp: HEALTHCHECKS_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'healthchecks-mcp: HEALTHCHECKS_URL must not contain credentials — use HEALTHCHECKS_API_KEY'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'healthchecks-mcp: WARNING: HEALTHCHECKS_URL uses plain http to a non-local host — ' +
        'the API key will be sent unencrypted. Use https:// instead.'
    );
  }

  // From `parsed`, not `rawUrl`: normalizeSiteRoot only trims slashes and an
  // API suffix, so a query or fragment would survive it and end up glued in
  // front of /api/v3 on every request.
  config.url = normalizeSiteRoot(`${parsed.origin}${parsed.pathname}`);
  config.usingDefaultUrl = false;
  return config;
}

/**
 * Trims a configured URL back to the site root.
 *
 * People copy the value out of the API documentation, where every example is a
 * full `https://healthchecks.io/api/v3/checks/` URL, and the neighbouring MCP
 * servers ask for the `/api/v3` suffix — so both spellings arrive here. Keeping
 * only the origin and any path *above* the API prefix means both work, instead
 * of one of them producing `/api/v3/api/v3/checks/` and a bare 404.
 */
export function normalizeSiteRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/api\/v[123]$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps the brackets around an IPv6 literal, may carry a %zone
  // suffix, and 'localhost.' with its root label is the same name as
  // 'localhost'. The comparison this replaced saw none of them — which is why
  // its bare '::1' branch could never match a hostname taken from a URL.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/%.*$/, '')
    .replace(/\.+$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '::1' ||
    // Every dual-stack client dials ::ffff:127.0.0.1 as plain 127.0.0.1, and
    // URL normalises the mapped form to hex (::ffff:7f00:1).
    /^::ffff:(?:7f[0-9a-f]{0,2}:|127\.)/.test(host)
  );
}
