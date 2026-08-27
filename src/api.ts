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

/** Thrown when a response is larger than {@link MAX_RESPONSE_BYTES}. */
export class ResponseTooLargeError extends Error {
  constructor(path: string) {
    super(
      `the Healthchecks response for ${path} exceeds ${Math.round(
        MAX_RESPONSE_BYTES / 1024 / 1024
      )} MB and was not read. Narrow the request — list_checks accepts tag and slug filters.`
    );
    this.name = 'ResponseTooLargeError';
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

    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const { text, truncated } = await readCapped(
      response as unknown as Response,
      limit,
      path
    );

    if (!response.ok) {
      throw new HealthchecksApiError(response.status, text, method, path);
    }
    if (truncated && !options.raw) {
      // A truncated JSON document cannot be parsed, so there is nothing useful
      // to hand back — say so rather than failing in JSON.parse.
      throw new ResponseTooLargeError(path);
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
    if (raw.contentType.includes('application/json')) {
      try {
        return JSON.parse(raw.body) as unknown;
      } catch {
        return raw.body;
      }
    }
    // `/status/` answers with the literal string "OK" and no JSON content type.
    return raw.body;
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
  path: string
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Nothing has been read yet, so the body can simply be discarded.
    await response.body?.cancel();
    throw new ResponseTooLargeError(path);
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
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
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
