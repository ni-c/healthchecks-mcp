import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkIdOf,
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
        fc.option(fc.stringMatching(/^[a-f0-9]{20,40}$/), { nil: undefined }),
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
   */
  it('keeps every field but the two legacy ones', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('name', 'slug', 'status', 'tz', 'timeout', 'desc'),
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
