import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  malformedApiKeyMessage,
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ceiling on a single upstream response.
 *
 * `GET /checks/` has no pagination at all and returns every check in the
 * project, so the size of the answer is decided by the instance, not by us.
 * `await response.text()` would buffer whatever arrives; this bounds it before
 * the bytes are ever in memory as a string.
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** The API version this server speaks. v3 is the first one that accepts an explicit slug. */
export const API_VERSION = 'v3';

export class HealthchecksApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string
  ) {
    super(`Healthchecks API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'HealthchecksApiError';
  }
}

/**
 * Thrown when a response is larger than the ceiling that applied to it.
 *
 * The limit is a parameter rather than {@link MAX_RESPONSE_BYTES}, because
 * callers override it — 64 KB for a ping body, 4 KB for the status probe — and
 * an error announcing "exceeds 5 MB" for a 6 KB response is one nobody believes.
 */
export class ResponseTooLargeError extends Error {
  constructor(path: string, limit: number) {
    super(
      `the Healthchecks response for ${path} exceeds the ${formatLimit(limit)} ` +
        'ceiling and was not read.'
    );
    this.name = 'ResponseTooLargeError';
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Ceiling on a header value this server is willing to send. */
const MAX_HEADER_VALUE_LENGTH = 1024;

/**
 * Refuses a header value the HTTP layer would refuse — before it gets there.
 *
 * undici quotes the offending value in its `TypeError`: `Headers.append:
 * "<value>" is an invalid header value.` For `X-Api-Key` that value *is* the
 * API key, and the message travels out through `run()`'s generic catch into the
 * model's context. A key with a line feed in the middle is not exotic — it is
 * what a wrapped paste, or a `$(cat key)` of a file with a hard-wrapped line,
 * produces, and the length check that guards the API's 32-character rule counts
 * it as an ordinary character.
 *
 * So the check happens here, and the message names the variable, the position
 * and the length, and never the value. `loadConfig` refuses the same shapes at
 * startup; this is the second half, because a `Config` can be built without it —
 * the tests do exactly that.
 */
export function assertHeaderValue(name: string, value: string): void {
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new Error(
      `the ${name} header would be ${value.length} characters long, above the ` +
        `${MAX_HEADER_VALUE_LENGTH} this server will send. Check ` +
        'HEALTHCHECKS_API_KEY.'
    );
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new Error(
        `the ${name} header contains a character outside printable ASCII at ` +
          `position ${i + 1} of ${value.length}, which the HTTP layer refuses. ` +
          'Check HEALTHCHECKS_API_KEY — a wrapped paste leaves a line break ' +
          'inside the value. The value itself is not shown.'
      );
    }
  }
}

/**
 * A content type, made safe to quote.
 *
 * It is a header the instance chose, and on the one endpoint that takes no key
 * it may not be the instance at all. Visible ASCII and a short cap; anything
 * else is described rather than echoed.
 */
export function describeContentType(contentType: string): string {
  if (contentType.length === 0) return 'no content type';
  const visible = [...contentType]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e;
    })
    .join('');
  if (visible.length === 0) return 'a content type of unprintable characters';
  return visible.length > 100
    ? `a ${contentType.length}-character content type`
    : `"${visible}"`;
}

/**
 * Thrown when an endpoint that only reads was refused for needing a read-write key.
 *
 * Healthchecks gates `/channels/`, `/pings/` and `/pings/<n>/body` behind
 * `@authorize` even though all three are GETs, and refuses a read-only key there
 * with `401 {"error": "wrong api key"}`. Relaying that verbatim sends the reader
 * to re-check a key that is correct — so the three call sites translate it.
 */
export class ReadWriteKeyRequiredError extends Error {
  constructor(public readonly tool: string) {
    super(
      `${tool} needs a read-write Healthchecks API key. The configured key was ` +
        'rejected with HTTP 401 "wrong api key", which is how Healthchecks ' +
        'answers a read-only key on this endpoint — it only reads, but the API ' +
        'gates it behind a read-write key anyway. Nothing is wrong with the key ' +
        'itself. Use a read-write key from Project Settings → API Access, or ' +
        `HEALTHCHECKS_DENY_TOOLS=${tool} to stop offering the tool. ` +
        'get_api_key_info reports which kind of key is configured.'
    );
    this.name = 'ReadWriteKeyRequiredError';
  }
}

/** Thrown when a response that has to be JSON is not. */
export class UnexpectedContentTypeError extends Error {
  constructor(path: string, contentType: string) {
    super(
      `Healthchecks answered ${path} with ${describeContentType(contentType)} ` +
        'instead of JSON. A 200 that is not JSON usually means something in front ' +
        'of the instance answered instead of the API — an SSO portal, a captive ' +
        'proxy or a login page. Check HEALTHCHECKS_URL and try get_status.'
    );
    this.name = 'UnexpectedContentTypeError';
  }
}

export interface RequestOptions {
  /** Send no `X-Api-Key` header. Only `/status/`, which is unauthenticated. */
  anonymous?: boolean;
  /** Return the raw body instead of parsing it. `/pings/<n>/body` is text/plain. */
  raw?: boolean;
  /** Overrides {@link MAX_RESPONSE_BYTES} for endpoints with a known small ceiling. */
  maxBytes?: number;
}

export interface RawResponse {
  body: string;
  truncated: boolean;
  contentType: string;
}

/** Client for the Healthchecks Management API. */
export class HealthchecksApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  /**
   * Only set when HEALTHCHECKS_INSECURE_TLS is enabled. Scopes the relaxed
   * certificate validation to requests against the configured host instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = `${config.url}/api/${API_VERSION}`;
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /** The configured site root, for messages that need to name the instance. */
  get siteRoot(): string {
    return this.config.url;
  }

  get apiKey(): string | undefined {
    return this.config.apiKey;
  }

  async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<RawResponse> {
    // The key is only required here, not at startup, so the server can still be
    // started and introspected without one.
    if (!options.anonymous) {
      const missing = missingConfigKeys(this.config);
      if (missing.length > 0) throw new Error(missingConfigMessage(missing));
      const malformed = malformedApiKeyMessage(this.config);
      if (malformed) throw new Error(malformed);
    }

    const headers: Record<string, string> = { Accept: '*/*' };
    if (!options.anonymous && this.config.apiKey) {
      // The header, never the `api_key` body field the API also accepts: a body
      // field ends up in request logs, and it only works for POST anyway.
      //
      // Checked before it is set, so undici never gets to quote the key back at
      // us in a TypeError that ends up in the model's context.
      assertHeaderValue('X-Api-Key', this.config.apiKey);
      headers['X-Api-Key'] = this.config.apiKey;
    }

    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the API key to whatever host
      // the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      // The API rejects multipart and form encoding outright; every POST is
      // JSON, including the empty-bodied pause and resume calls.
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const url = `${this.baseUrl}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    // The status is decided before the body is read, and that order is the
    // whole point. Reading first meant a 401 whose body was a two-megabyte
    // login page — which is what a reverse proxy or an SSO portal answers —
    // surfaced as "the response exceeds the 5 MB ceiling": the size, not the
    // status, and no hint about the credential. An error body gets its own
    // small ceiling that cuts instead of refusing, so the sentence the instance
    // wrote always survives.
    if (!response.ok) {
      const errorBody = await readErrorBody(response as unknown as Response);
      throw new HealthchecksApiError(response.status, errorBody, method, path);
    }

    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    // A raw caller wants text and can live with less of it; a JSON caller
    // cannot, because half a document is not a smaller answer.
    const { text, truncated } = await readCapped(
      response as unknown as Response,
      limit,
      path,
      options.raw === true
    );

    if (truncated && !options.raw) {
      throw new ResponseTooLargeError(path, limit);
    }

    return {
      body: text,
      truncated,
      contentType: response.headers.get('content-type') ?? '',
    };
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const raw = await this.requestRaw(method, path, body, options);
    if (options.raw) return raw;
    if (raw.body.length === 0) return undefined;
    // Anything that is not JSON here is a foreign answer, not a Healthchecks
    // one. Returning the body would send an HTML login page into `listOf`,
    // which finds no array and reports an empty project — an error swallowed
    // and replaced with a plausible wrong answer. The endpoints that do speak
    // text (`/status/`, ping bodies) ask for `raw` and never reach this.
    if (!raw.contentType.includes('application/json')) {
      throw new UnexpectedContentTypeError(path, raw.contentType);
    }
    try {
      return JSON.parse(raw.body) as unknown;
    } catch {
      throw new UnexpectedContentTypeError(
        path,
        `${raw.contentType} (unparseable)`
      );
    }
  }

  get(path: string, options?: RequestOptions): Promise<unknown> {
    return this.request('GET', path, undefined, options);
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  delete(path: string): Promise<unknown> {
    return this.request('DELETE', path);
  }
}

/** Ceiling on the body of a failed response. It cuts; it never refuses. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Reads the body of a non-2xx response.
 *
 * Deliberately different from {@link readCapped} in the one way that matters: it
 * cannot throw. The status is already the answer, and an error while reading the
 * explanation must not replace it — that is how a 401 became a size complaint.
 * Whatever cannot be read comes back as the empty string, and the caller still
 * has the status.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const stream = response.body;
    if (!stream) return '';
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total + value.byteLength > MAX_ERROR_BODY_BYTES) {
        chunks.push(value.subarray(0, MAX_ERROR_BODY_BYTES - total));
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * Both halves matter: `content-length` catches an oversized answer before a
 * single byte is read, and the streaming count catches a chunked response,
 * which declares no length at all.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  path: string,
  allowTruncation: boolean
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes && !allowTruncation) {
    // Nothing has been read yet, so the body can simply be discarded.
    await response.body?.cancel();
    throw new ResponseTooLargeError(path, maxBytes);
  }

  const body = response.body;
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > maxBytes) {
      // `maxBytes - total` is exactly the remaining budget, and the `>` above
      // makes an exactly-maxBytes response legal rather than truncated.
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      // NOTE: `total` is deliberately left stale here — the loop exits on the
      // next line and nothing reads it afterwards. Anything added below this
      // point must recompute it from `chunks` rather than trusting it.
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Guards a value that ends up in a URL path. Path traversal here would let a
 * caller reach a different resource — or a different API entirely.
 *
 * Defence in depth: every caller already validated the value against a UUID or
 * SHA1 schema, and this catches the one that some day will not.
 */
export function assertPathSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(
      `invalid ${what}: only letters, digits, dot, underscore and hyphen are allowed`
    );
  }
  return value;
}

/** Builds a query string from the parameters that are actually set. */
export function query(
  params: Record<string, string | number | undefined | (string | number)[]>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      search.append(key, String(entry));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
