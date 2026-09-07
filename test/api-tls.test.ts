import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The one code path that weakens TLS, which is the one that had no test.
 *
 * `HEALTHCHECKS_INSECURE_TLS=true` builds an undici `Agent` with
 * `rejectUnauthorized: false` and routes requests through undici's own `fetch`
 * so the dispatcher applies. Two things are worth pinning, and neither is
 * visible from the outside: that the relaxed agent is built *only* under the
 * switch, and that it is scoped to this client's requests rather than set
 * process-wide, where it would silently weaken every other TLS connection the
 * host process makes.
 *
 * `vi.mock` is hoisted above the imports, so the fake has to be built inside
 * `vi.hoisted` — a factory cannot see a top-level `const`.
 */
const undiciMock = vi.hoisted(() => {
  const constructed: unknown[] = [];
  const fetchCalls: { url: string; hasDispatcher: boolean }[] = [];
  class FakeAgent {
    constructor(public readonly options: unknown) {
      constructed.push(options);
    }
  }
  const fetchSpy = vi.fn(
    async (url: string | URL, init?: { dispatcher?: unknown }) => {
      fetchCalls.push({
        url: String(url),
        hasDispatcher: init?.dispatcher !== undefined,
      });
      return new Response('{"checks":[]}', {
        headers: { 'content-type': 'application/json' },
      });
    }
  );
  return { constructed, fetchCalls, FakeAgent, fetchSpy };
});

vi.mock('undici', () => ({
  Agent: undiciMock.FakeAgent,
  fetch: undiciMock.fetchSpy,
}));

const { HealthchecksApi } = await import('../src/api.js');
const { testConfig } = await import('./harness.js');

afterEach(() => {
  undiciMock.constructed.length = 0;
  undiciMock.fetchCalls.length = 0;
  undiciMock.fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the insecure-TLS switch', () => {
  it('builds no dispatcher and uses the global fetch when it is off', async () => {
    const global = vi.fn(
      async () =>
        new Response('{"checks":[]}', {
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', global);

    await new HealthchecksApi(testConfig()).get('/checks/');

    expect(undiciMock.constructed).toHaveLength(0);
    expect(undiciMock.fetchSpy).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledOnce();
  });

  it('builds one dispatcher that disables certificate validation when it is on', async () => {
    const global = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', global);

    const api = new HealthchecksApi(testConfig({ insecureTls: true }));
    await api.get('/checks/');
    await api.get('/checks/');

    // One agent for the client, not one per request.
    expect(undiciMock.constructed).toHaveLength(1);
    expect(undiciMock.constructed[0]).toEqual({
      connect: { rejectUnauthorized: false },
    });
    // And the requests went through undici's fetch carrying it, never through
    // the global one, which would ignore the dispatcher and validate normally.
    expect(undiciMock.fetchCalls).toHaveLength(2);
    expect(undiciMock.fetchCalls.every((c) => c.hasDispatcher)).toBe(true);
    expect(global).not.toHaveBeenCalled();
  });

  it('never touches the process-wide TLS setting', async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}'))
    );
    await new HealthchecksApi(testConfig({ insecureTls: true })).get(
      '/checks/'
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });

  it('still sends the key and still refuses a redirect on the insecure path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}'))
    );
    await new HealthchecksApi(testConfig({ insecureTls: true })).get(
      '/checks/'
    );
    const init = undiciMock.fetchSpy.mock.calls[0]?.[1] as
      { headers?: Record<string, string>; redirect?: string } | undefined;
    expect(init?.headers?.['X-Api-Key']).toBe('k'.repeat(32));
    expect(init?.redirect).toBe('error');
  });
});
