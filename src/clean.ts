/**
 * What is done to text before it leaves this server.
 *
 * Almost everything Healthchecks hands back was written by somebody else. A
 * check's name, description and tags come from whoever can edit the project; a
 * ping's `ua` and `remote_addr` come from whoever knows the ping URL, which by
 * design sits in a cron job on every monitored host; and a ping *body* is the
 * raw output of a job, which is the least controlled text in the system. All of
 * it goes into a model's context. Two things are removed on the way, and only
 * two:
 *
 * - **C0 and C1 control characters and DEL**, except tab, line feed and
 *   carriage return. A terminal escape in a check name can repaint the client's
 *   log, and a NUL ends the string early for whatever reads it next. A ping body
 *   is the one place where an escape is plausible — a job that prints colour —
 *   and also the place where it is least trustworthy, so it goes too, and the
 *   result says how many were removed rather than pretending there were none.
 * - **Lone surrogates.** Half of a surrogate pair is legal JSON and parses to
 *   half a character; `JSON.stringify` writes it back as an escape, so the wire
 *   stays valid, and a Python client encoding the text to UTF-8 then raises
 *   `UnicodeEncodeError: surrogates not allowed`. `toWellFormed()` replaces the
 *   half with U+FFFD — and it runs after every cut, because a cut can split a
 *   pair.
 *
 * Bidi marks, joiners and every other format character stay: they are content
 * in a check named in Arabic or Hindi, and removing them would change the name.
 *
 * The character classes are decided by code point in a loop rather than spelled
 * as a regular expression, so that no escape sequence has to be written into
 * this file — a backslash-u escape in a source file is one editing tool away
 * from becoming the byte itself.
 */

function isControl(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  return code >= 0x7f && code <= 0x9f;
}

/** Whether a string carries anything {@link cleanText} would remove. */
export function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) return true;
  }
  return false;
}

/** How many characters {@link cleanText} would remove. */
export function countControl(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) count++;
  }
  return count;
}

/**
 * Strips control characters and repairs lone surrogates.
 *
 * Linear, and cheap on the common case: a string with nothing to remove is
 * returned as it came, after the well-formedness check that costs one pass.
 */
export function cleanText(value: string): string {
  let out: string | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) {
      out = (out ?? '') + value.slice(start, i);
      start = i + 1;
    }
  }
  const stripped = out === undefined ? value : out + value.slice(start);
  return stripped.isWellFormed() ? stripped : stripped.toWellFormed();
}

/**
 * {@link cleanText} over a whole structure.
 *
 * Rebuilds every object with `Object.fromEntries`, so a key of `__proto__` — an
 * own property after `JSON.parse`, and legal JSON from any instance — stays an
 * own property in the copy instead of becoming its prototype. Keys are cleaned
 * as well as values: a key is text a model reads too, and the badge document is
 * keyed by tag, which is whatever somebody typed.
 *
 * Numbers, booleans and null pass through; `undefined` and functions cannot come
 * out of JSON and are dropped from objects, where `JSON.stringify` would drop
 * them anyway, and written as `null` in arrays, which is also what it would do.
 */
export function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined || typeof entry === 'function'
        ? null
        : cleanValue(entry)
    );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(
        ([key, entry]) =>
          entry === undefined || typeof entry === 'function'
            ? []
            : [[cleanText(key), cleanValue(entry)]]
      )
    );
  }
  return value;
}

/** How much of the instance's text an error message may carry. */
const MAX_UPSTREAM_TEXT = 2000;

/**
 * Text written by whatever answered a request, made safe to quote.
 *
 * Healthchecks' error bodies are small JSON documents and the sentence that
 * matters is in them. But the thing that answers is not always Healthchecks: a
 * reverse proxy, an SSO portal or a WAF writes its own body, and a mistyped
 * `HEALTHCHECKS_URL` reaches whatever is at that address. So the text is
 * cleaned, trimmed and cut, and markup-shaped bodies are dropped whole.
 */
export function upstreamText(text: string, max = MAX_UPSTREAM_TEXT): string {
  const trimmed = cleanText(text).trim();
  if (trimmed.length === 0) return '(empty body)';
  // Anything markup-shaped: a reverse proxy's error page or a WAF block page.
  // The check is deliberately loose — an XML declaration, a leading comment or
  // a doctype followed by a newline are all the same thing here.
  if (/^(<!doctype|<html[\s>]|<\?xml|<!--)/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).toWellFormed()}… (truncated)`;
}

/**
 * Removes credentials from a URL-shaped string before it is quoted.
 *
 * Anchored, so it is tried from one position only, and `[^/?#]*@` stops at the
 * *last* `@` before the path — a password may contain one. A value that failed
 * to parse as a URL is exactly the value this runs on, so it cannot rely on
 * `URL` to find the userinfo.
 */
export function redactUserinfo(value: string): string {
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i,
    '$1<credentials redacted>@'
  );
}

/**
 * A configured value quoted into a diagnostic, when quoting it is safe at all.
 *
 * The rule comes from the neighbouring variable: `HEALTHCHECKS_API_KEY` sits one
 * line above `HEALTHCHECKS_URL` in every compose file, so a value that fails to
 * parse as a URL is exactly the one that might be the key. Anything longer than
 * a short segment is described by its length instead of quoted.
 */
export function describeValue(value: string, max = 40): string {
  const cleaned = redactUserinfo(cleanText(value).trim());
  if (cleaned.length === 0) return 'an empty value';
  if (cleaned.length > max) return `a ${cleaned.length}-character value`;
  return `"${cleaned}"`;
}
