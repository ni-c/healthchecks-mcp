import { describe, expect, it } from 'vitest';

import {
  checkIdOf,
  flipsOf,
  listOf,
  normalizeCheck,
  scheduleKindOf,
  summarizeCheck,
  tagsOf,
} from '../src/check.js';
import { CHECK_UUID, UNIQUE_KEY, checkFixture } from './harness.js';

describe('identifying a check', () => {
  it('uses the uuid a read-write key returns', () => {
    const check = checkFixture();
    expect(checkIdOf(check)).toBe(CHECK_UUID);
    expect(normalizeCheck(check).id_kind).toBe('uuid');
  });

  it('falls back to the unique_key a read-only key returns instead', () => {
    // A read-only key never sees a uuid, ping_url, update_url or channels — the
    // object simply lacks them, which is invisible without this.
    const readOnlyView = checkFixture();
    delete readOnlyView.uuid;
    delete readOnlyView.ping_url;
    delete readOnlyView.channels;
    readOnlyView.unique_key = UNIQUE_KEY;

    expect(checkIdOf(readOnlyView)).toBe(UNIQUE_KEY);
    expect(normalizeCheck(readOnlyView).id_kind).toBe('unique_key');
  });

  it('says so when a check carries neither', () => {
    expect(normalizeCheck({}).id_kind).toBe('none');
    expect(checkIdOf({})).toBeUndefined();
  });
});

describe('tags', () => {
  it('splits the space-delimited string the API stores', () => {
    expect(tagsOf({ tags: 'prod backup' })).toEqual(['prod', 'backup']);
  });

  it('survives the empty and the padded case', () => {
    expect(tagsOf({ tags: '' })).toEqual([]);
    expect(tagsOf({})).toEqual([]);
    expect(tagsOf({ tags: '  a   b  ' })).toEqual(['a', 'b']);
  });
});

describe('the missing kind field', () => {
  // There is no `kind` in a check object: a simple check carries `timeout`, a
  // scheduled one carries `schedule` and `tz`, never both.
  it('reads a timeout check as simple', () => {
    expect(scheduleKindOf(checkFixture())).toBe('simple');
  });

  it('reads a cron check as scheduled', () => {
    const cron = checkFixture({ schedule: '0 4 * * *', tz: 'Europe/Berlin' });
    delete cron.timeout;
    expect(scheduleKindOf(cron)).toBe('scheduled');
    expect(summarizeCheck(cron)).toMatchObject({
      schedule: '0 4 * * *',
      tz: 'Europe/Berlin',
    });
    expect(summarizeCheck(cron).timeout).toBeUndefined();
  });
});

describe('normalizeCheck', () => {
  it('drops the legacy derived fields', () => {
    // subject/subject_fail mirror success_kw/failure_kw and are not writable;
    // leaving them in invites an update that silently does nothing.
    const normalized = normalizeCheck(checkFixture());
    expect(normalized.subject).toBeUndefined();
    expect(normalized.subject_fail).toBeUndefined();
  });

  it('splits channels into a list', () => {
    const normalized = normalizeCheck(
      checkFixture({ channels: 'a-uuid,b-uuid' })
    );
    expect(normalized.channels).toEqual(['a-uuid', 'b-uuid']);
  });

  it('reports no channels as an empty list, not as an empty string', () => {
    expect(normalizeCheck(checkFixture({ channels: '' })).channels).toEqual([]);
  });

  it('keeps every other field the API returned', () => {
    const normalized = normalizeCheck(checkFixture());
    expect(normalized.desc).toBe('Runs pg_dump and uploads it.');
    expect(normalized.badge_url).toBeDefined();
    expect(normalized.n_pings).toBe(7);
  });
});

describe('summarizeCheck', () => {
  it('leaves out the description, which a list would be mostly made of', () => {
    expect(summarizeCheck(checkFixture()).desc).toBeUndefined();
  });

  it('keeps what a list is read for', () => {
    expect(summarizeCheck(checkFixture())).toMatchObject({
      id: CHECK_UUID,
      name: 'Nightly Backup',
      slug: 'nightly-backup',
      tags: ['prod', 'backup', 'db'],
      status: 'up',
      n_pings: 7,
      timeout: 86400,
    });
  });

  it('fills in defaults rather than emitting undefined for a sparse check', () => {
    expect(summarizeCheck({})).toMatchObject({
      name: '',
      status: 'unknown',
      n_pings: 0,
    });
  });
});

describe('reading list envelopes', () => {
  it('accepts both flip shapes, because the docs and the code disagree', () => {
    // The published example is a bare array; the implementation returns
    // {"flips": [...]}. A self-hosted instance can be either release.
    const flips = [{ timestamp: '2026-08-27T00:00:00+00:00', up: 1 }];
    expect(flipsOf({ flips })).toEqual(flips);
    expect(flipsOf(flips)).toEqual(flips);
  });

  it('answers an unexpected shape with an empty list rather than throwing', () => {
    expect(flipsOf(null)).toEqual([]);
    expect(flipsOf({ unexpected: true })).toEqual([]);
    expect(listOf(undefined, 'checks')).toEqual([]);
  });

  it('reads a named envelope and a bare array alike', () => {
    expect(listOf({ checks: [1, 2] }, 'checks')).toEqual([1, 2]);
    expect(listOf([1, 2], 'checks')).toEqual([1, 2]);
  });
});
