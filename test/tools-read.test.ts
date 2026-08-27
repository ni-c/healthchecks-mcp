import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_UUID,
  UNIQUE_KEY,
  RO_KEY,
  call,
  checkFixture,
  connect,
  jsonOf,
  stubFetch,
  textOf,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('list_checks', () => {
  it('summarises the project and says how many checks it holds', async () => {
    stubFetch({ 'GET /checks/': { json: { checks: [checkFixture()] } } });
    const result = jsonOf(await call(await connect(), 'list_checks'));
    expect(result.total_in_project).toBe(1);
    expect((result.checks as unknown[])[0]).toMatchObject({
      name: 'Nightly backup',
    });
  });

  it('passes tags through as repeated query parameters', async () => {
    const stub = stubFetch({ 'GET /checks/': { json: { checks: [] } } });
    await call(await connect(), 'list_checks', { tag: ['prod', 'backup'] });
    expect(stub.calls[0]?.path).toBe('/checks/?tag=prod&tag=backup');
  });

  it('passes a slug filter through, because slugs are not addressable', async () => {
    const stub = stubFetch({ 'GET /checks/': { json: { checks: [] } } });
    await call(await connect(), 'list_checks', { slug: 'nightly-backup' });
    expect(stub.calls[0]?.path).toBe('/checks/?slug=nightly-backup');
  });

  it('filters by status client-side, since the API offers no such filter', async () => {
    stubFetch({
      'GET /checks/': {
        json: {
          checks: [
            checkFixture({ status: 'up' }),
            checkFixture({ status: 'down', name: 'Broken' }),
          ],
        },
      },
    });
    const result = jsonOf(
      await call(await connect(), 'list_checks', { status: 'down' })
    );
    expect(result.checks).toHaveLength(1);
    expect((result.checks as Record<string, unknown>[])[0]?.name).toBe(
      'Broken'
    );
    expect(result.total_in_project).toBe(2);
  });

  it('applies its own limit and names how to see more', async () => {
    // The endpoint has no pagination at all, so every ceiling here is ours.
    stubFetch({
      'GET /checks/': {
        json: { checks: Array.from({ length: 10 }, () => checkFixture()) },
      },
    });
    const result = jsonOf(
      await call(await connect(), 'list_checks', { limit: 3 })
    );
    expect(result.checks).toHaveLength(3);
    expect(String(result.note)).toMatch(/Raise limit/);
  });

  it('rejects a tag with a space instead of quietly making it two', async () => {
    const stub = stubFetch({ 'GET /checks/': { json: { checks: [] } } });
    const result = await call(await connect(), 'list_checks', {
      tag: ['two words'],
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('get_check', () => {
  it('returns the full check, marked as untrusted content', async () => {
    stubFetch({ [`GET /checks/${CHECK_UUID}`]: { json: checkFixture() } });
    const result = await call(await connect(), 'get_check', {
      check: CHECK_UUID,
    });
    expect(textOf(result)).toMatch(/untrusted content from Healthchecks/);
    expect(jsonOf(result)).toMatchObject({
      desc: 'Runs at 02:00 on the backup host',
      id_kind: 'uuid',
    });
  });

  it('accepts the unique_key a read-only key returns instead of a UUID', async () => {
    const readOnlyView = checkFixture({ unique_key: UNIQUE_KEY });
    delete readOnlyView.uuid;
    stubFetch({ [`GET /checks/${UNIQUE_KEY}`]: { json: readOnlyView } });
    const result = jsonOf(
      await call(await connect({ apiKey: RO_KEY }), 'get_check', {
        check: UNIQUE_KEY,
      })
    );
    expect(result.id).toBe(UNIQUE_KEY);
    expect(result.id_kind).toBe('unique_key');
  });

  it('refuses a slug rather than spending a 404 on it', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'get_check', {
      check: 'nightly-backup',
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('explains a 403 as the wrong project rather than the wrong object', async () => {
    stubFetch({
      [`GET /checks/${CHECK_UUID}`]: {
        status: 403,
        json: { error: 'forbidden' },
      },
    });
    const result = await call(await connect(), 'get_check', {
      check: CHECK_UUID,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/different project/);
  });
});

describe('list_pings', () => {
  const path = `GET /checks/${CHECK_UUID}/pings/`;

  it('lists pings and reports how many the instance returned', async () => {
    stubFetch({
      [path]: {
        json: {
          pings: [
            { type: 'success', n: 42 },
            { type: 'fail', n: 41 },
          ],
        },
      },
    });
    const result = jsonOf(
      await call(await connect(), 'list_pings', { check: CHECK_UUID })
    );
    expect(result.pings).toHaveLength(2);
    expect(result.returned_by_instance).toBe(2);
  });

  it('filters by type client-side', async () => {
    stubFetch({
      [path]: {
        json: {
          pings: [
            { type: 'success', n: 2 },
            { type: 'fail', n: 1 },
          ],
        },
      },
    });
    const result = jsonOf(
      await call(await connect(), 'list_pings', {
        check: CHECK_UUID,
        type: 'fail',
      })
    );
    expect(result.pings).toEqual([{ type: 'fail', n: 1 }]);
  });

  it('says in its description that a read-only key cannot use it', async () => {
    // The API gates this behind a read-write key although it only reads, which
    // is the least guessable thing about it.
    stubFetch();
    const { tools } = await (await connect()).listTools();
    const tool = tools.find((t) => t.name === 'list_pings');
    expect(tool?.description).toMatch(/read-write API key/);
  });
});

describe('get_ping_body', () => {
  const path = `GET /checks/${CHECK_UUID}/pings/7/body`;

  it('returns the logged body as untrusted content', async () => {
    // This is the least trusted thing the server returns: whatever pings the
    // check wrote it.
    stubFetch({ [path]: { text: 'rsync: connection unexpectedly closed' } });
    const result = await call(await connect(), 'get_ping_body', {
      check: CHECK_UUID,
      n: 7,
    });
    expect(textOf(result)).toMatch(/untrusted content from Healthchecks/);
    expect(textOf(result)).toContain('rsync: connection unexpectedly closed');
  });

  it('lists all four meanings of a 404 rather than passing the number on', async () => {
    stubFetch({ [path]: { status: 404, text: 'not found' } });
    const result = await call(await connect(), 'get_ping_body', {
      check: CHECK_UUID,
      n: 7,
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/check does not exist/);
    expect(text).toMatch(/ping number does not exist/);
    expect(text).toMatch(/carried no body/);
    expect(text).toMatch(/older than the instance keeps/);
  });

  it('reports a 503 as transient rather than as a missing body', async () => {
    stubFetch({ [path]: { status: 503, text: 'storage down' } });
    const result = await call(await connect(), 'get_ping_body', {
      check: CHECK_UUID,
      n: 7,
    });
    expect(textOf(result)).toMatch(/transient/);
  });

  it('says so when the ping simply had no content', async () => {
    stubFetch({ [path]: { text: '' } });
    const result = await call(await connect(), 'get_ping_body', {
      check: CHECK_UUID,
      n: 7,
    });
    expect(textOf(result)).toMatch(/empty body/);
  });
});

describe('list_flips', () => {
  const path = `GET /checks/${CHECK_UUID}/flips/`;

  it('accepts the documented bare-array shape as well as the implemented one', async () => {
    stubFetch({
      [path]: { json: [{ timestamp: '2026-08-27T00:00:00+00:00', up: 0 }] },
    });
    const result = jsonOf(
      await call(await connect(), 'list_flips', { check: CHECK_UUID })
    );
    expect(result.flips).toHaveLength(1);
  });

  it('passes the time window through', async () => {
    const stub = stubFetch({ [path]: { json: { flips: [] } } });
    await call(await connect(), 'list_flips', {
      check: CHECK_UUID,
      start: 1_700_000_000,
      end: 1_700_003_600,
    });
    expect(stub.calls[0]?.path).toContain('start=1700000000');
    expect(stub.calls[0]?.path).toContain('end=1700003600');
  });

  it('refuses a window that runs backwards before asking the API', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'list_flips', {
      check: CHECK_UUID,
      start: 2,
      end: 1,
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('accepts a unique_key, unlike the ping endpoints', async () => {
    stubFetch({
      [`GET /checks/${UNIQUE_KEY}/flips/`]: { json: { flips: [] } },
    });
    const result = await call(await connect({ apiKey: RO_KEY }), 'list_flips', {
      check: UNIQUE_KEY,
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('list_integrations and list_badges', () => {
  it('lists the integrations with the UUIDs the write tools accept', async () => {
    stubFetch({
      'GET /channels/': {
        json: { channels: [{ id: 'abc', name: 'ntfy', kind: 'ntfy' }] },
      },
    });
    const result = jsonOf(await call(await connect(), 'list_integrations'));
    expect(result.integrations).toEqual([
      { id: 'abc', name: 'ntfy', kind: 'ntfy' },
    ]);
  });

  it('unwraps the badges envelope', async () => {
    stubFetch({
      'GET /badges/': {
        json: { badges: { '*': { svg: 'https://example.net/a.svg' } } },
      },
    });
    const result = jsonOf(await call(await connect(), 'list_badges'));
    expect(result.badges).toMatchObject({
      '*': { svg: 'https://example.net/a.svg' },
    });
  });
});

describe('get_status', () => {
  it('works without an API key at all', async () => {
    const stub = stubFetch({ 'GET /status/': { text: 'OK' } });
    const result = await call(
      await connect({ apiKey: undefined }),
      'get_status'
    );
    expect(textOf(result)).toMatch(/reachable/);
    expect(stub.calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('reports an unexpected answer verbatim instead of claiming success', async () => {
    stubFetch({ 'GET /status/': { text: 'database is down' } });
    expect(textOf(await call(await connect(), 'get_status'))).toContain(
      'database is down'
    );
  });

  it('reports an HTTP error as an error', async () => {
    stubFetch({ 'GET /status/': { status: 500, text: 'nope' } });
    expect((await call(await connect(), 'get_status')).isError).toBe(true);
  });
});

describe('get_api_key_info', () => {
  it('says what is missing when no key is configured', async () => {
    stubFetch();
    const result = jsonOf(
      await call(await connect({ apiKey: undefined }), 'get_api_key_info')
    );
    expect(result.api_key).toBe('not configured');
  });

  it('reports a read-write key and the identifier it implies', async () => {
    stubFetch({
      'GET /checks/': { json: { checks: [] } },
      'GET /channels/': { json: { channels: [] } },
    });
    const result = jsonOf(await call(await connect(), 'get_api_key_info'));
    expect(result.kind).toBe('read-write');
    expect(result.checks_identified_by).toBe('uuid');
    expect(result.unavailable_tools).toEqual([]);
  });

  it('detects a read-only key and names the tools it cannot reach', async () => {
    // The whole point of this tool: with a read-only key eight of the fourteen
    // tools fail, and the bare 401 they produce says "missing api key".
    stubFetch({
      'GET /checks/': { json: { checks: [] } },
      'GET /channels/': { status: 401, json: { error: 'wrong api key' } },
    });
    const result = jsonOf(
      await call(await connect({ apiKey: RO_KEY }), 'get_api_key_info')
    );
    expect(result.kind).toBe('read-only');
    expect(result.prefixed_hcr).toBe(true);
    expect(result.checks_identified_by).toBe('unique_key');
    expect(result.unavailable_tools).toContain('get_ping_body');
    expect(result.unavailable_tools).toContain('delete_check');
  });

  it('reports a key the instance rejects outright', async () => {
    stubFetch({
      'GET /checks/': { status: 401, json: { error: 'wrong api key' } },
      'GET /channels/': { status: 401, json: { error: 'wrong api key' } },
    });
    const result = jsonOf(await call(await connect(), 'get_api_key_info'));
    expect(result.accepted).toBe(false);
    expect(String(result.kind)).toMatch(/not accepted/);
    expect(result.error).toBe('HTTP 401');
  });

  it('flags a key of the wrong length', async () => {
    stubFetch();
    const result = jsonOf(
      await call(await connect({ apiKey: 'short' }), 'get_api_key_info')
    );
    expect(result.key_length_ok).toBe(false);
  });
});
