import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  booleanOf,
  checkIdShapeOf,
  MAX_DISPLAY_CHARS,
  nullableStringOf,
  objectOf,
  recordOr,
  recordsOf,
  safeIntegerOf,
  skippedNote,
  stringOf,
} from '../src/boundary.js';
import {
  CHECK_UUID,
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

/**
 * What the instance sends, against what the tools promise to return.
 *
 * Every response used to be a TypeScript cast, and a cast is not a check. The
 * SDK validates `structuredContent` against each tool's declared output schema
 * on every success path — so a `name` the instance sent as a number was not a
 * cosmetic problem, it was `Output validation error` for the whole listing, and
 * a `null` where a check belonged was `Cannot read properties of null (reading
 * 'schedule')` out of the projection.
 *
 * These are the exact bodies that produced those two sentences before the
 * boundary existed. The claim they hold is narrow and worth stating: *the tool
 * answers*. Not that the odd value is preserved — it is not — but that one bad
 * field never costs the caller the other four hundred checks.
 *
 * The harness lists tools on connect, so every `call` here runs the client-side
 * schema check that the suite used to skip.
 */
async function listChecks(body: unknown): Promise<{
  text: string;
  error: boolean;
  parsed: Record<string, unknown>;
}> {
  stubFetch({
    'GET /checks/': {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      contentType: 'application/json',
    },
  });
  const result = await call(await connect(), 'list_checks');
  return {
    text: textOf(result),
    error: result.isError === true,
    parsed: result.isError === true ? {} : jsonOf(result),
  };
}

describe('a check whose fields are not what the schema promises', () => {
  const cases: Record<string, unknown> = {
    'a name that is a number': { ...checkFixture(), name: 5 },
    'a grace that is null': { ...checkFixture(), grace: null },
    'a status that is null': { ...checkFixture(), status: null },
    'a started that is a string': { ...checkFixture(), started: 'yes' },
    'a last_ping that is a number': { ...checkFixture(), last_ping: 12 },
    'tags that are a number': { ...checkFixture(), tags: 5 },
    'a tz that is null': { ...checkFixture(), tz: null, schedule: '* * * * *' },
    'a timeout that is an object': { ...checkFixture(), timeout: {} },
  };

  for (const [label, check] of Object.entries(cases)) {
    it(`still lists the check with ${label}`, async () => {
      const { error, parsed } = await listChecks({ checks: [check] });
      expect(error).toBe(false);
      const checks = parsed.checks as Record<string, unknown>[];
      expect(checks).toHaveLength(1);
      // The identifier is what makes the row worth having at all.
      expect(checks[0]?.id).toBe(CHECK_UUID);
    });
  }

  it('answers a count of 1e999 without Infinity reaching the schema', async () => {
    // Legal JSON. `JSON.parse` makes it Infinity, `typeof` says "number", and
    // zod refuses it — so the informative field took the answer down with it.
    const body = JSON.stringify({ checks: [checkFixture()] }).replace(
      '"n_pings":7',
      '"n_pings":1e999'
    );
    const { error, parsed } = await listChecks(body);
    expect(error).toBe(false);
    const checks = parsed.checks as Record<string, unknown>[];
    expect(checks[0]?.n_pings).toBe(0);
  });
});

describe('entries that are not objects at all', () => {
  it('counts them instead of failing the listing or hiding them', async () => {
    const { error, parsed } = await listChecks({
      checks: [null, checkFixture(), 42, 'a string'],
    });
    expect(error).toBe(false);
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.total_in_project).toBe(1);
    expect(String(parsed.note)).toContain('3 entries');
    expect(String(parsed.note)).toContain('not an object');
  });

  it('says so for pings, and the type filter does not throw over one', async () => {
    stubFetch({
      [`GET /checks/${CHECK_UUID}/pings/`]: {
        json: { pings: [null, { n: 1, type: 'success' }] },
      },
    });
    const result = await call(await connect(), 'list_pings', {
      check: CHECK_UUID,
      type: 'success',
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOf(result).pings).toHaveLength(1);
  });

  it('says so for flips and integrations', async () => {
    stubFetch({
      [`GET /checks/${CHECK_UUID}/flips/`]: { json: { flips: [5, { up: 1 }] } },
      'GET /channels/': { json: { channels: ['not an object'] } },
    });
    const client = await connect();
    const flips = await call(client, 'list_flips', { check: CHECK_UUID });
    expect(flips.isError).not.toBe(true);
    expect(jsonOf(flips).flips).toHaveLength(1);
    const integrations = await call(client, 'list_integrations');
    expect(integrations.isError).not.toBe(true);
    expect(jsonOf(integrations).integrations).toHaveLength(0);
  });
});

describe('a body that is not a check at all', () => {
  const bodies: Record<string, string> = {
    null: 'null',
    'a number': '42',
    'an array': '[]',
    'an empty 200': '',
  };

  for (const [label, body] of Object.entries(bodies)) {
    it(`answers ${label} without a TypeError`, async () => {
      stubFetch({
        [`GET /checks/${CHECK_UUID}`]: {
          text: body,
          contentType: 'application/json',
        },
      });
      const result = await call(await connect(), 'get_check', {
        check: CHECK_UUID,
      });
      // Either an honest answer or an honest error — never a crash quoting the
      // instance's field names back at the model.
      expect(textOf(result)).not.toContain('Cannot read properties');
      expect(textOf(result)).not.toContain('is not a function');
      expect(textOf(result)).not.toContain('Output validation error');
    });
  }

  it('reports a check with no usable identifier as id_kind none', async () => {
    const check = { ...checkFixture() };
    delete check.uuid;
    stubFetch({
      [`GET /checks/${CHECK_UUID}`]: { json: check },
    });
    const parsed = jsonOf(
      await call(await connect(), 'get_check', { check: CHECK_UUID })
    );
    expect(parsed.id_kind).toBe('none');
    expect(parsed.id).toBeUndefined();
  });

  it('refuses an identifier that is not shaped like one', async () => {
    // A uuid the instance made up — spliced into a request path and quoted into
    // the sentence a person reads after approving a deletion. It is dropped
    // from the passed-through record too: an unusable `uuid` sitting next to an
    // `id_kind` of "none" reads as an identifier to anything that does not know
    // the difference.
    stubFetch({
      [`GET /checks/${CHECK_UUID}`]: {
        json: { ...checkFixture(), uuid: '../../../etc/passwd' },
      },
    });
    const parsed = jsonOf(
      await call(await connect(), 'get_check', { check: CHECK_UUID })
    );
    expect(parsed.id).toBeUndefined();
    expect(parsed.id_kind).toBe('none');
    expect(parsed.uuid).toBeUndefined();
  });

  it('answers an empty 200 from a write without a TypeError', async () => {
    stubFetch({
      [`POST /checks/${CHECK_UUID}`]: { text: '', contentType: 'text/plain' },
    });
    const result = await call(await connect(), 'update_check', {
      check: CHECK_UUID,
      name: 'x',
    });
    expect(textOf(result)).not.toContain('Cannot read properties');
  });
});

describe('the badge document', () => {
  it('keeps the tags that are records and counts the ones that are not', async () => {
    stubFetch({
      'GET /badges/': {
        json: { badges: { prod: { svg: 'https://x/a.svg' }, staging: null } },
      },
    });
    const parsed = jsonOf(await call(await connect(), 'list_badges'));
    const badges = parsed.badges as Record<string, unknown>;
    expect(Object.keys(badges)).toEqual(['prod']);
    expect(String(parsed.note)).toContain('1 entry');
  });

  it('shows a bounded number of tags rather than answering nothing', async () => {
    // Six URLs per tag, none of them long enough to be worth shortening and no
    // array to halve — so a project with thousands of tags produced a document
    // the budget could not shrink and the tool answered an error instead of a
    // badge. The ceiling is the tool's, because the budget cannot help here.
    const badges: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) {
      badges[`tag${i}`] = { svg: `https://hc.example.net/badge/${i}.svg` };
    }
    stubFetch({ 'GET /badges/': { json: { badges } } });
    const result = await call(await connect(), 'list_badges');
    expect(result.isError).not.toBe(true);
    const parsed = jsonOf(result);
    expect(Object.keys(parsed.badges as object).length).toBeLessThanOrEqual(
      500
    );
    expect(String(parsed.note)).toContain('3000 tags');
  });

  it('answers a document that is null with a sentence, not a schema error', async () => {
    stubFetch({ 'GET /badges/': { json: { badges: null } } });
    const result = await call(await connect(), 'list_badges');
    expect(textOf(result)).not.toContain('Output validation error');
    expect(jsonOf(result).badges).toEqual({});
  });

  it('keeps a tag spelled __proto__ as an own property', async () => {
    stubFetch({
      'GET /badges/': {
        text: '{"badges":{"__proto__":{"svg":"x"},"prod":{"svg":"y"}}}',
        contentType: 'application/json',
      },
    });
    const parsed = jsonOf(await call(await connect(), 'list_badges'));
    const badges = parsed.badges as Record<string, unknown>;
    // A tag is whatever somebody typed, and `badges[tag] = value` would have
    // written the prototype and dropped the entry with no error anywhere.
    expect(Object.hasOwn(badges, '__proto__')).toBe(true);
    expect(Object.keys(badges).toSorted()).toEqual(['__proto__', 'prod']);
  });
});

describe('the boundary helpers themselves', () => {
  it('reads a record, and nothing else, as a record', () => {
    expect(objectOf({ a: 1 })).toEqual({ a: 1 });
    for (const value of [null, [], 'x', 5, undefined, true]) {
      expect(objectOf(value)).toBeUndefined();
    }
    // `recordOr` is for the places where an empty answer is a legitimate one:
    // an empty 200 arrives as `undefined`, and `Buffer.byteLength(undefined)`
    // is an `ERR_INVALID_ARG_TYPE` rather than anything a reader can act on.
    expect(recordOr(undefined)).toEqual({});
    expect(recordOr([1, 2])).toEqual({});
  });

  it('cuts a display string on the way in, and says it did', () => {
    const cut = stringOf('x'.repeat(MAX_DISPLAY_CHARS + 100));
    expect(cut).toContain('100 more characters omitted');
    expect(stringOf('short')).toBe('short');
    expect(stringOf(5)).toBeUndefined();
  });

  it('does not split a surrogate pair when it cuts', () => {
    const cut = stringOf('😀'.repeat(30), 11);
    expect(cut?.isWellFormed()).toBe(true);
  });

  it('answers a safe integer or nothing', () => {
    expect(safeIntegerOf(60)).toBe(60);
    // -0 serialises as 0 in one channel and -0 in the other.
    expect(Object.is(safeIntegerOf(-0), 0)).toBe(true);
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      1.5,
      '60',
      null,
    ]) {
      expect(safeIntegerOf(value)).toBeUndefined();
    }
  });

  it('keeps null apart from absent for the two nullable timestamps', () => {
    // `last_ping` is null upstream when a check has never been pinged, which is
    // different from the instance not sending the field at all.
    expect(nullableStringOf(null)).toBeNull();
    expect(nullableStringOf('2026-08-27T09:39:21+00:00')).toBe(
      '2026-08-27T09:39:21+00:00'
    );
    expect(nullableStringOf(12)).toBeUndefined();
  });

  it('counts what it skipped, and names it in a sentence', () => {
    expect(recordsOf([null, { a: 1 }, 5])).toEqual({
      records: [{ a: 1 }],
      skipped: 2,
    });
    expect(skippedNote(1, 'checks')).toContain('1 entry');
    expect(skippedNote(2, 'checks')).toContain('2 entries');
  });

  it('accepts both identifier shapes and nothing else', () => {
    expect(checkIdShapeOf(CHECK_UUID)).toBe(CHECK_UUID);
    expect(checkIdShapeOf('4616b2faa4483b13263e4adda4133688010b2794')).toBe(
      '4616b2faa4483b13263e4adda4133688010b2794'
    );
    expect(booleanOf(true)).toBe(true);
    expect(booleanOf('true')).toBeUndefined();
  });
});
