import { internalHostKind } from 'mcp-internal-hosts';

import { describeValue } from './clean.js';

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
  // The shape comes first. A key with a line break inside it — a wrapped paste,
  // or a `$(cat key)` of a hard-wrapped file — has an ordinary length as far as
  // the count below is concerned, and reaches undici, whose refusal quotes the
  // whole value: `Headers.append: "<the key>" is an invalid header value.` That
  // message travels out through the generic error path into the model's
  // context. Position and length, never the value.
  const offending = firstNonPrintable(config.apiKey);
  if (offending !== undefined) {
    return (
      `HEALTHCHECKS_API_KEY contains a character outside printable ASCII at ` +
      `position ${offending + 1} of ${config.apiKey.length}. A key is 32 ` +
      'visible characters; a line break inside the value is what a wrapped ' +
      'paste leaves behind. Copy the key again from Project Settings → API ' +
      'Access. The value is not shown here.'
    );
  }
  if (config.apiKey.length === API_KEY_LENGTH) return undefined;
  return (
    `HEALTHCHECKS_API_KEY is ${config.apiKey.length} characters long, but ` +
    `Healthchecks only accepts keys of exactly ${API_KEY_LENGTH} characters and ` +
    'answers anything else with HTTP 401 "missing api key". Copy the key again ' +
    'from Project Settings → API Access — note that keys are per project, not ' +
    'per account, and that a ping key is not an API key.'
  );
}

/** Index of the first character the HTTP layer would refuse, if any. */
function firstNonPrintable(value: string): number | undefined {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return i;
  }
  return undefined;
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
  // Quoted only when it has the shape of a word somebody typed instead of
  // "true" — the point is to show the operator their typo. Anything else is
  // described by length: ELICITATION is unprefixed and sits in the same block
  // as HEALTHCHECKS_API_KEY in every compose file, so it is one shifted line
  // away from holding the key.
  const shown = /^[A-Za-z0-9_-]{1,12}$/.test(raw ?? '')
    ? `"${raw ?? ''}"`
    : describeValue(raw ?? '', 0);
  console.error(
    'healthchecks-mcp: ELICITATION must be "true" or "false" — got ' +
      `${shown}. Refusing to start rather than guess.`
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
  // Trimmed: `HEALTHCHECKS_API_KEY=$(cat key)` leaves the file's trailing
  // newline on the value, which makes a correct key 33 characters long and
  // produces "missing api key" from the instance — the length rule is checked
  // upstream before the key is ever looked up.
  const rawApiKey = env.HEALTHCHECKS_API_KEY;
  const trimmedApiKey = rawApiKey?.trim();
  const apiKey =
    trimmedApiKey === undefined || trimmedApiKey.length === 0
      ? undefined
      : trimmedApiKey;
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
    // Described, never quoted — not even the part that looks like a scheme.
    // The value that fails to parse is the one most likely to be a secret
    // pasted into the wrong line, and this message goes to stderr, which is the
    // MCP client's log. The sibling servers of this family quote a value
    // containing "://" on the grounds that a URL is not a password; that is a
    // weaker rule than the one this file already had, and a query string
    // carries tokens too.
    console.error(
      'healthchecks-mcp: HEALTHCHECKS_URL is not a valid URL ' +
        `(a ${rawUrl.length}-character value). The value is not shown here — ` +
        'if a key was pasted into this variable by mistake, it belongs in ' +
        'HEALTHCHECKS_API_KEY.'
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // The scheme is deliberately not printed. A 56-character hexadecimal key
    // with a colon after it is a valid URL whose *scheme* is the key, so `got
    // ${parsed.protocol}` is one paste away from printing the credential — and
    // the branch above, which refuses a value `new URL()` cannot parse, was
    // already written not to echo for exactly that reason.
    console.error(
      'healthchecks-mcp: HEALTHCHECKS_URL must use http:// or https:// — the ' +
        `configured value uses neither (${parsed.protocol.length - 1} ` +
        'characters before the colon). If a key was pasted into this variable ' +
        'by mistake, it belongs in HEALTHCHECKS_API_KEY.'
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
  // An index walk rather than `/\/+$/`. That pattern is tried from every
  // position of a run of slashes and consumes the run each time, which is
  // quadratic: 80 000 slashes followed by anything the pattern rejects cost 1.8
  // seconds here, on the operator's own configuration value.
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--;
  return url.slice(0, end).replace(/\/api\/v[123]$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  // The same classifier the SSRF guard uses, so a loopback URL written as
  // http://[::1]:3000 or http://[::ffff:127.0.0.1]:3000 is recognised here too
  // and the plain-http warning does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
