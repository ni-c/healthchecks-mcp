import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertHeaderValue,
  describeContentType,
  HealthchecksApi,
  HealthchecksApiError,
  MAX_ERROR_BODY_BYTES,
  ResponseTooLargeError,
} from '../src/api.js';
import { call, connect, stubFetch, testConfig, textOf } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the status is decided before the body is read', () => {
  it('answers a 401 with a huge body as a 401, not as a size complaint', async () => {
    // What a reverse proxy or an SSO portal answers: a login page, megabytes of
    // it, with the status that actually matters. Reading first turned that into
    // "the response exceeds the 5 MB ceiling" — the size, not the status, and
    // no hint about the credential.
    stubFetch({
      'GET /checks/': {
        status: 401,
        text: 'x'.repeat(6 * 1024 * 1024),
        contentType: 'text/plain',
        headers: { 'content-length': String(6 * 1024 * 1024) },
      },
    });
    const error = await new HealthchecksApi(testConfig())
      .get('/checks/')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HealthchecksApiError);
    expect((error as HealthchecksApiError).status).toBe(401);
  });

  it('reaches the caller with the hint that names the read-only key case', async () => {
    stubFetch({
      'GET /checks/': {
        status: 401,
        text: 'x'.repeat(6 * 1024 * 1024),
        contentType: 'text/plain',
        headers: { 'content-length': String(6 * 1024 * 1024) },
      },
    });
    const answered = textOf(await call(await connect(), 'list_checks'));
    expect(answered).toContain('HTTP 401');
    expect(answered).toContain('read-only');
    expect(answered).not.toContain('ceiling');
  });

  it('cuts an oversized error body instead of refusing it', async () => {
    stubFetch({
      'GET /checks/': {
        status: 500,
        text: 'e'.repeat(MAX_ERROR_BODY_BYTES * 2),
        contentType: 'text/plain',
      },
    });
    const error = (await new HealthchecksApi(testConfig())
      .get('/checks/')
      .catch((caught: unknown) => caught)) as HealthchecksApiError;
    expect(error).toBeInstanceOf(HealthchecksApiError);
    expect(error.body.length).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES);
    expect(error.body.length).toBeGreaterThan(0);
  });

  it('still refuses an oversized *successful* body', async () => {
    // The ceiling is unchanged where it belongs: half a JSON document is not a
    // smaller answer, it is an unparseable one.
    stubFetch({
      'GET /checks/': {
        json: {},
        headers: { 'content-length': String(6 * 1024 * 1024) },
      },
    });
    await expect(
      new HealthchecksApi(testConfig()).get('/checks/')
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('a header value is checked before the HTTP layer sees it', () => {
  const KEY_HEAD = 'aaaaaaaaaaaaaaa';
  const KEY_TAIL = 'bbbbbbbbbbbbbbbb';

  it('refuses a key with a line break, naming the position and not the value', () => {
    const key = `${KEY_HEAD}\n${KEY_TAIL}`;
    expect(() => assertHeaderValue('X-Api-Key', key)).toThrow(
      /position 16 of 32/
    );
    expect(() => assertHeaderValue('X-Api-Key', key)).not.toThrow(
      new RegExp(KEY_HEAD)
    );
  });

  it('refuses a value that is simply too long', () => {
    expect(() => assertHeaderValue('X-Api-Key', 'k'.repeat(2000))).toThrow(
      /2000 characters long/
    );
  });

  it('accepts an ordinary key', () => {
    expect(() => assertHeaderValue('X-Api-Key', 'k'.repeat(32))).not.toThrow();
  });

  it('never lets undici quote the key back into a tool result', async () => {
    // undici's refusal is `Headers.append: "<the value>" is an invalid header
    // value.` — the whole key, through the generic error path, into the model's
    // context. The check above runs first, so the runtime never gets there.
    stubFetch({ 'GET /checks/': { json: { checks: [] } } });
    const answered = textOf(
      await call(
        await connect({ apiKey: `${KEY_HEAD}\n${KEY_TAIL}` }),
        'list_checks'
      )
    );
    expect(answered).not.toContain(KEY_HEAD);
    expect(answered).not.toContain(KEY_TAIL);
    expect(answered).toContain('HEALTHCHECKS_API_KEY');
  });

  it('keeps no part of any malformed key, whatever it is made of', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{12}$/),
        fc.stringMatching(/^[a-z]{12}$/),
        // Not 0x20: a space is a shape the check refuses and a header value the
        // HTTP layer accepts, so it is a different case from a control
        // character and would prove the wrong thing here.
        fc.constantFrom(0x00, 0x0a, 0x0d, 0x09, 0x7f, 0x1b, 0xa0, 0x2028),
        async (head, tail, code) => {
          const key = `${head}${String.fromCodePoint(code)}${tail}`;
          stubFetch({
            'GET /checks/': { json: { checks: [] } },
            'GET /channels/': { json: { channels: [] } },
          });
          const client = await connect({ apiKey: key });
          for (const tool of ['list_checks', 'get_api_key_info']) {
            const answered = textOf(await call(client, tool));
            expect(answered).not.toContain(head);
            expect(answered).not.toContain(tail);
          }
        }
      ),
      { numRuns: Number(process.env.SHAPE_RUNS ?? 40) }
    );
  });
});

describe('a content type is described rather than echoed', () => {
  it('strips what a terminal would act on', () => {
    const described = describeContentType(
      `text/${String.fromCharCode(7)}weird`
    );
    expect(described).toBe('"text/weird"');
  });

  it('describes an absurdly long one by its length', () => {
    expect(describeContentType('x'.repeat(500))).toBe(
      'a 500-character content type'
    );
  });

  it('has a word for the empty case and for an unprintable one', () => {
    expect(describeContentType('')).toBe('no content type');
    expect(describeContentType(String.fromCharCode(0, 1, 2))).toBe(
      'a content type of unprintable characters'
    );
  });

  it('reaches the tool result that way', async () => {
    stubFetch({
      'GET /checks/': {
        json: {},
        contentType: `text/${String.fromCharCode(27)}html`,
      },
    });
    const answered = textOf(await call(await connect(), 'list_checks'));
    expect(answered).toContain('"text/html"');
    expect(answered).not.toContain(String.fromCharCode(27));
  });
});
