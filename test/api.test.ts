import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_VERSION,
  assertPathSegment,
  HealthchecksApi,
  HealthchecksApiError,
  MAX_RESPONSE_BYTES,
  query,
  ResponseTooLargeError,
  UnexpectedContentTypeError,
  type RawResponse,
} from '../src/api.js';
import { API, RW_KEY, stubFetch, testConfig } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request shape', () => {
  it('addresses the versioned API under the configured site root', async () => {
    const stub = stubFetch({ 'GET /checks/': { json: { checks: [] } } });
    await new HealthchecksApi(testConfig()).get('/checks/');
    expect(stub.calls[0]?.url).toBe(`${API}/checks/`);
    expect(API).toContain(`/api/${API_VERSION}`);
  });

  it('sends the key in the header, never in the body', async () => {
    const stub = stubFetch({ 'POST /checks/': { json: {} } });
    await new HealthchecksApi(testConfig()).post('/checks/', { name: 'x' });
    expect(stub.calls[0]?.headers['x-api-key']).toBe(RW_KEY);
    expect(JSON.stringify(stub.calls[0]?.body)).not.toContain(RW_KEY);
  });

  it('refuses to follow a redirect and gives every request a deadline', async () => {
    // A redirect would resend the API key to whatever host the upstream names.
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    await new HealthchecksApi(testConfig()).get('/checks/');
    expect(calls[0]?.redirect).toBe('error');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends JSON on every POST, including the empty-bodied ones', async () => {
    // The API rejects form encoding outright, pause and resume included.
    const stub = stubFetch({ 'POST /checks/x/pause': { json: {} } });
    await new HealthchecksApi(testConfig()).post('/checks/x/pause');
    expect(stub.calls[0]?.headers['content-type']).toBeUndefined();
    const stub2 = stubFetch({ 'POST /checks/': { json: {} } });
    await new HealthchecksApi(testConfig()).post('/checks/', {});
    expect(stub2.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('omits the key entirely for the unauthenticated status endpoint', async () => {
    const stub = stubFetch({ 'GET /status/': { text: 'OK' } });
    await new HealthchecksApi(testConfig()).get('/status/', {
      anonymous: true,
      raw: true,
    });
    expect(stub.calls[0]?.headers['x-api-key']).toBeUndefined();
  });
});

describe('missing or malformed credentials', () => {
  it('refuses an authenticated call without a key, and says what to set', async () => {
    stubFetch();
    await expect(
      new HealthchecksApi(testConfig({ apiKey: undefined })).get('/checks/')
    ).rejects.toThrow(/HEALTHCHECKS_API_KEY/);
  });

  it('still allows the unauthenticated call', async () => {
    stubFetch({ 'GET /status/': { text: 'OK' } });
    await expect(
      new HealthchecksApi(testConfig({ apiKey: undefined })).get('/status/', {
        anonymous: true,
        raw: true,
      })
    ).resolves.toMatchObject({ body: 'OK' });
  });

  it('refuses a key of the wrong length before spending a request on it', async () => {
    const stub = stubFetch();
    await expect(
      new HealthchecksApi(testConfig({ apiKey: 'short' })).get('/checks/')
    ).rejects.toThrow(/exactly 32 characters/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('responses', () => {
  it('parses JSON', async () => {
    stubFetch({ 'GET /checks/': { json: { checks: [1] } } });
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).resolves.toEqual({
      checks: [1],
    });
  });

  it('hands back plain text only where the caller asked for it raw', async () => {
    stubFetch({ 'GET /status/': { text: 'OK' } });
    await expect(
      new HealthchecksApi(testConfig()).get('/status/', {
        anonymous: true,
        raw: true,
      })
    ).resolves.toMatchObject({ body: 'OK' });
  });

  it('refuses a 200 that is not JSON instead of passing the body on', async () => {
    // An SSO portal, a captive proxy or a login page in front of the instance
    // answers 200 text/html. Returning that body would reach listOf(), find no
    // array, and report an empty project — an error replaced by a plausible
    // wrong answer, and the likeliest misconfiguration for a self-hosted setup.
    stubFetch({
      'GET /checks/': {
        text: '<!DOCTYPE html><html>Sign in</html>',
        contentType: 'text/html',
      },
    });
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).rejects.toThrow(UnexpectedContentTypeError);
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).rejects.toThrow(/SSO portal|captive proxy|login page/);
  });

  it('refuses a JSON content type whose body does not parse', async () => {
    stubFetch({
      'GET /checks/': { text: 'not json', contentType: 'application/json' },
    });
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).rejects.toThrow(UnexpectedContentTypeError);
  });

  it('turns a non-2xx into an error carrying the status and the body', async () => {
    stubFetch({
      'GET /checks/x': { status: 403, json: { error: 'wrong project' } },
    });
    const error = await new HealthchecksApi(testConfig())
      .get('/checks/x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HealthchecksApiError);
    expect((error as HealthchecksApiError).status).toBe(403);
    expect((error as HealthchecksApiError).body).toContain('wrong project');
  });

  it('returns undefined for an empty body rather than failing to parse it', async () => {
    stubFetch({ 'DELETE /checks/x': { status: 204 } });
    await expect(
      new HealthchecksApi(testConfig()).delete('/checks/x')
    ).resolves.toBe(undefined);
  });
});

describe('the response size ceiling', () => {
  it('refuses an oversized answer on the declared length, before reading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            headers: {
              'content-type': 'application/json',
              'content-length': String(MAX_RESPONSE_BYTES + 1),
            },
          })
      )
    );
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).rejects.toThrow(ResponseTooLargeError);
  });

  it('also stops a chunked answer that declares no length at all', async () => {
    // The half people forget: content-length is absent on a streamed response,
    // so the only bound left is counting the bytes as they arrive.
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent > 5000) {
                controller.close();
                return;
              }
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { headers: { 'content-type': 'text/plain' } }
        );
      })
    );
    const raw = (await new HealthchecksApi(testConfig()).get(
      '/checks/x/pings/1/body',
      {
        raw: true,
        maxBytes: 2048,
      }
    )) as RawResponse;
    expect(raw.truncated).toBe(true);
    expect(raw.body).toHaveLength(2048);
  });

  it('truncates rather than refuses when the caller reads raw, even with a declared length', async () => {
    // get_ping_body promises "truncated at 64 KB". Healthchecks serves ping
    // bodies with a content-length, so without this the promise held only for
    // chunked responses — a contract that depended on the transfer encoding.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x'.repeat(4096), {
            headers: {
              'content-type': 'text/plain',
              'content-length': '4096',
            },
          })
      )
    );
    const raw = (await new HealthchecksApi(testConfig()).get(
      '/checks/x/pings/1/body',
      {
        raw: true,
        maxBytes: 1024,
      }
    )) as RawResponse;
    expect(raw.truncated).toBe(true);
    expect(raw.body).toHaveLength(1024);
  });

  it('names the limit that actually applied, not the global one', async () => {
    // "exceeds 5 MB" for a 6 KB status response is an error nobody believes.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            headers: {
              'content-type': 'application/json',
              'content-length': '6000',
            },
          })
      )
    );
    await expect(
      new HealthchecksApi(testConfig()).get('/status/', { maxBytes: 4096 })
    ).rejects.toThrow(/4 KB ceiling/);
  });

  it('refuses to hand back a JSON document it had to cut', async () => {
    // Half a JSON document is not a smaller answer, it is an unparseable one.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"checks":[1,2,3]}', {
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/', { maxBytes: 5 })
    ).rejects.toThrow(ResponseTooLargeError);
  });
});

describe('assertPathSegment', () => {
  it('accepts a UUID and a unique_key', () => {
    expect(
      assertPathSegment('f618072a-7bde-4eee-af63-71a77c5723bc', 'id')
    ).toBe('f618072a-7bde-4eee-af63-71a77c5723bc');
    expect(assertPathSegment('a'.repeat(40), 'id')).toBe('a'.repeat(40));
  });

  it.each(['../admin', 'a/b', '..', '.', 'a b', 'a?b=c', ''])(
    'refuses %j',
    (value) => {
      expect(() => assertPathSegment(value, 'id')).toThrow(/invalid id/);
    }
  );
});

describe('query', () => {
  it('omits everything that is not set', () => {
    expect(query({ a: undefined, b: 1 })).toBe('?b=1');
    expect(query({ a: undefined })).toBe('');
  });

  it('repeats an array parameter, which is how tag filtering works', () => {
    expect(query({ tag: ['prod', 'backup'] })).toBe('?tag=prod&tag=backup');
  });

  it('escapes values instead of letting them extend the query', () => {
    expect(query({ slug: 'a&b=c' })).toBe('?slug=a%26b%3Dc');
  });
});
