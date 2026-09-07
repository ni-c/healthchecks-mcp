import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkIdOf,
  idKindOf,
  flipsOf,
  listOf,
  normalizeCheck,
  scheduleKindOf,
  tagsOf,
  type Check,
} from '../src/check.js';

/**
 * Properties of the reading layer.
 *
 * Two of these carry a rule stated in a comment rather than in a test. `tagsOf`
 * splits on whitespace, which is why `tagParam` refuses a tag containing a
 * space — the round trip through this function would turn one tag into two, and
 * the caller would have tagged something they did not name. `flipsOf` and
 * `listOf` accept two envelope shapes because a self-hosted instance can be any
 * release, and a reader that knew one would report an empty result against the
 * other.
 */

const RUNS = { numRuns: 500 };

/** A tag as `tagParam` would let through: no whitespace. */
const tag = fc.stringMatching(/^[A-Za-z0-9_.:-]{1,20}$/);

describe('tags survive the split they were written for', () => {
  /**
   * The round trip the comment argues from. A tag list joined with single
   * spaces splits back into exactly the tags it was built from — which is only
   * true because no tag may contain one.
   */
  it('a whitespace-free tag list round trips', () => {
    fc.assert(
      fc.property(fc.array(tag, { maxLength: 12 }), (tags) => {
        expect(tagsOf({ tags: tags.join(' ') } as Check)).toEqual(tags);
      }),
      RUNS
    );
  });

  /** Any run of whitespace is one separator, and no empty tag comes out. */
  it('never produces an empty tag, whatever the spacing', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(tag, fc.constantFrom(' ', '  ', '\t', '\n')), {
          maxLength: 20,
        }),
        (parts) => {
          for (const found of tagsOf({ tags: parts.join(' ') } as Check)) {
            expect(found.length).toBeGreaterThan(0);
            expect(found).not.toMatch(/\s/);
          }
        }
      ),
      RUNS
    );
  });

  it('a missing or non-string tags field is an empty list, not a crash', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.array(fc.string())
        ),
        (tags) => {
          expect(tagsOf({ tags } as unknown as Check)).toEqual([]);
        }
      ),
      RUNS
    );
  });
});

describe('a check is addressed by whichever id it carries', () => {
  /**
   * A read-only API key gets `unique_key` and never a `uuid`. Preferring one
   * and falling back to the other is what lets the same tools work under both
   * kinds of key, so the preference is stated rather than assumed.
   */
  it('prefers the uuid and falls back to the unique key', () => {
    fc.assert(
      fc.property(
        fc.option(fc.uuid(), { nil: undefined }),
        fc.option(fc.stringMatching(/^[a-f0-9]{40}$/), { nil: undefined }),
        (uuid, uniqueKey) => {
          const id = checkIdOf({ uuid, unique_key: uniqueKey } as Check);
          if (uuid !== undefined) expect(id).toBe(uuid);
          else if (uniqueKey !== undefined) expect(id).toBe(uniqueKey);
          else expect(id).toBeUndefined();
        }
      ),
      RUNS
    );
  });

  /**
   * The identifier is spliced into a request path and quoted into sentences —
   * `delete_check` says "check <id> is gone" after somebody approved deleting
   * it — so it is not enough for it to be a string. Anything that is not one of
   * the two shapes Healthchecks actually issues is *absent*: the check still
   * appears in a listing, without an id, and `id_kind` says "none".
   */
  it('an identifier of any other shape is absent, not passed on', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^[a-f0-9]{1,39}$/),
          fc.constantFrom(
            '../../etc/passwd',
            'not-a-uuid',
            '403c0ad2-72ac-4f0a-8802-69ee5c9e29fd extra',
            ''
          ),
          fc.integer(),
          fc.constant(null)
        ),
        (value) => {
          expect(
            checkIdOf({ uuid: value, unique_key: value } as unknown as Check)
          ).toBeUndefined();
          expect(
            idKindOf({ uuid: value, unique_key: value } as unknown as Check)
          ).toBe('none');
        }
      ),
      RUNS
    );
  });

  it('a check driven by a schedule is scheduled, everything else simple', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        (schedule) => {
          const kind = scheduleKindOf({ schedule } as Check);
          expect(kind).toBe(
            typeof schedule === 'string' && schedule.length > 0
              ? 'scheduled'
              : 'simple'
          );
        }
      ),
      RUNS
    );
  });
});

describe('normalisation drops the legacy fields and nothing else', () => {
  /**
   * The counterpart to a filter: what it removes has to be exactly what it
   * says. A normaliser that quietly dropped a field a caller needed would look
   * like the API had stopped returning it.
   *
   * "Nothing else" means the fields the *output schema does not name*. Those
   * are passed through exactly as the instance sent them, whatever they are —
   * a self-hosted Healthchecks is any release, and its extra fields are not
   * this server's to judge.
   */
  it('keeps every unnamed field but the two legacy ones', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            'ping_url',
            'update_url',
            'badge_url',
            'methods',
            'manual_resume',
            'start_kw'
          ),
          fc.jsonValue(),
          { maxKeys: 6 }
        ),
        fc.jsonValue(),
        (check, legacy) => {
          const normalized = normalizeCheck({
            ...check,
            subject: legacy,
            subject_fail: legacy,
          } as Check);
          expect('subject' in normalized).toBe(false);
          expect('subject_fail' in normalized).toBe(false);
          for (const [key, value] of Object.entries(check)) {
            expect(normalized[key]).toEqual(value);
          }
        }
      ),
      RUNS
    );
  });

  /**
   * And the other half, which is the change this review made. Every field the
   * output schema *does* name has to hold its declared type or be absent: the
   * SDK validates `structuredContent` against that schema on every success
   * path, so a `name` the instance sent as a number is not a cosmetic problem —
   * it is the whole listing answered with "Output validation error" instead.
   *
   * Absent, and not "skipped": the check keeps its row. A monitoring tool that
   * hides a check because one field is odd is worse than one that shows the
   * check without the field.
   */
  it('a named field of the wrong type is absent, and the check survives', () => {
    // Wrong *for that field*: a boolean is right for `started` and wrong for
    // `name`, so one shared list of "odd values" would generate its own
    // counterexamples.
    const NOT_A_STRING = [null, 5, true, ['a'], {}];
    const NOT_A_NUMBER = [null, '60', true, [60], {}];
    const NOT_A_BOOLEAN = [null, 1, 'true', [true], {}];
    const wrongFor: Record<string, unknown[]> = {
      name: NOT_A_STRING,
      slug: NOT_A_STRING,
      desc: NOT_A_STRING,
      status: NOT_A_STRING,
      schedule: NOT_A_STRING,
      tz: NOT_A_STRING,
      // Both are stored as delimited strings upstream; a list arrives split.
      tags: NOT_A_STRING,
      channels: NOT_A_STRING,
      timeout: NOT_A_NUMBER,
      grace: NOT_A_NUMBER,
      n_pings: NOT_A_NUMBER,
      started: NOT_A_BOOLEAN,
    };
    const cases = Object.entries(wrongFor).flatMap(([field, values]) =>
      values.map((value) => [field, value] as const)
    );
    fc.assert(
      fc.property(fc.constantFrom(...cases), ([field, value]) => {
        const normalized = normalizeCheck({
          uuid: '403c0ad2-72ac-4f0a-8802-69ee5c9e29fd',
          [field]: value,
        } as unknown as Check);
        // The identifier is untouched, so the check is still addressable.
        expect(normalized.id).toBe('403c0ad2-72ac-4f0a-8802-69ee5c9e29fd');
        expect(normalized.id_kind).toBe('uuid');
        // `tags` is always built rather than passed through, so its answer to
        // a non-string is the empty list the schema promises.
        if (field === 'tags') {
          expect(normalized.tags).toEqual([]);
          return;
        }
        expect(normalized[field]).toBeUndefined();
      }),
      RUNS
    );
  });

  /**
   * `Infinity` deserves its own line. It arrives as `1e999` in perfectly legal
   * JSON, `JSON.parse` turns it into a number, `typeof` says "number" — and zod
   * refuses it, so the count that was meant to be informative takes the answer
   * down with it.
   */
  it('a count the instance wrote as 1e999 is absent, not Infinity', () => {
    const normalized = normalizeCheck(
      JSON.parse(
        '{"uuid":"403c0ad2-72ac-4f0a-8802-69ee5c9e29fd","n_pings":1e999,"grace":1e999}'
      )
    );
    expect(normalized.n_pings).toBeUndefined();
    expect(normalized.grace).toBeUndefined();
  });

  /**
   * A key of `__proto__` is an own property after `JSON.parse` and legal JSON
   * from any instance. Written back with a plain assignment it sets the copy's
   * prototype and disappears, which is a field lost with no error anywhere.
   */
  it('keeps a __proto__ field as an own property', () => {
    const normalized = normalizeCheck(
      JSON.parse(
        '{"uuid":"403c0ad2-72ac-4f0a-8802-69ee5c9e29fd","__proto__":{"polluted":true}}'
      )
    );
    expect(Object.hasOwn(normalized, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('both envelope shapes are read', () => {
  it('finds the list in either shape and never invents entries', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 8 }),
        fc.constantFrom('checks', 'channels', 'badges'),
        (items, key) => {
          expect(listOf(items, key)).toEqual(items);
          expect(listOf({ [key]: items }, key)).toEqual(items);
          expect(listOf({ other: items }, key)).toEqual([]);
          expect(flipsOf(items)).toEqual(items);
          expect(flipsOf({ flips: items })).toEqual(items);
        }
      ),
      RUNS
    );
  });

  it('never throws, whatever the instance answered', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        expect(Array.isArray(listOf(body, 'checks'))).toBe(true);
        expect(Array.isArray(flipsOf(body))).toBe(true);
      }),
      RUNS
    );
  });
});
