import { describe, expect, it } from 'vitest';

import {
  channelsParam,
  checkIdParam,
  confirmTokenParam,
  graceParam,
  keywordsParam,
  methodsParam,
  limitParam,
  pingNumberParam,
  scheduleParam,
  slugParam,
  tagParam,
  timeoutParam,
  tzParam,
  uniqueParam,
  unixTimeParam,
  uuidParam,
} from '../src/schema.js';
import { CHECK_UUID, UNIQUE_KEY } from './harness.js';

describe('identifiers', () => {
  it('accepts a UUID where the API routes on one', () => {
    expect(uuidParam.parse(CHECK_UUID)).toBe(CHECK_UUID);
  });

  it('refuses a unique_key where only a UUID works', () => {
    // The URL resolver discriminates by regex, so a unique_key on an endpoint
    // that wants a UUID is answered with a bare 404 and no explanation.
    expect(() => uuidParam.parse(UNIQUE_KEY)).toThrow();
  });

  it('refuses a slug as an identifier', () => {
    // Slugs are not unique and are not a path segment in the Management API.
    expect(() => uuidParam.parse('nightly-backup')).toThrow();
    expect(() => checkIdParam.parse('nightly-backup')).toThrow();
  });

  it('accepts either form where the API accepts either', () => {
    expect(checkIdParam.parse(CHECK_UUID)).toBe(CHECK_UUID);
    expect(checkIdParam.parse(UNIQUE_KEY)).toBe(UNIQUE_KEY);
  });

  it('refuses anything that could escape the path', () => {
    for (const value of [
      '../admin',
      `${CHECK_UUID}/pause`,
      `${CHECK_UUID}?x=1`,
    ]) {
      expect(() => checkIdParam.parse(value)).toThrow();
    }
  });
});

describe('the two list separators', () => {
  it('refuses a tag containing a space, because tags are stored space-delimited', () => {
    expect(tagParam.parse('prod')).toBe('prod');
    expect(() => tagParam.parse('two words')).toThrow();
  });

  it('refuses a keyword containing a comma, because keywords are comma-delimited', () => {
    expect(keywordsParam.parse(['done', 'finished ok'])).toEqual([
      'done',
      'finished ok',
    ]);
    expect(() => keywordsParam.parse(['a,b'])).toThrow();
  });
});

describe('slugs', () => {
  it('accepts the character set the API accepts', () => {
    expect(slugParam.parse('nightly-backup_2')).toBe('nightly-backup_2');
  });

  it.each(['Nightly', 'has space', 'ümlaut', ''])('refuses %j', (value) => {
    expect(() => slugParam.parse(value)).toThrow();
  });
});

describe('durations', () => {
  it('holds the 60 … 31536000 second range the API enforces', () => {
    expect(timeoutParam.parse(60)).toBe(60);
    expect(graceParam.parse(31_536_000)).toBe(31_536_000);
    expect(() => timeoutParam.parse(59)).toThrow();
    expect(() => graceParam.parse(31_536_001)).toThrow();
    expect(() => timeoutParam.parse(60.5)).toThrow();
  });
});

describe('schedules', () => {
  it('accepts a cron and an OnCalendar expression alike', () => {
    expect(scheduleParam.parse('0 4 * * 1-5')).toBe('0 4 * * 1-5');
    expect(scheduleParam.parse('Mon *-*-* 04:00:00')).toBe(
      'Mon *-*-* 04:00:00'
    );
  });

  it('refuses a multi-line value', () => {
    expect(() => scheduleParam.parse('0 4 * * *\n0 5 * * *')).toThrow();
  });

  it('accepts an IANA zone and refuses a sentence', () => {
    expect(tzParam.parse('Europe/Berlin')).toBe('Europe/Berlin');
    expect(tzParam.parse('UTC')).toBe('UTC');
    expect(() => tzParam.parse('central european time')).toThrow();
  });
});

describe('channels', () => {
  it('accepts the wildcard and a list alike', () => {
    expect(channelsParam.parse('*')).toBe('*');
    expect(channelsParam.parse(['email', 'ntfy'])).toEqual(['email', 'ntfy']);
  });

  it('refuses another bare string, which would silently be one channel name', () => {
    expect(() => channelsParam.parse('email')).toThrow();
  });
});

describe('the remaining parameters', () => {
  it('restricts methods to the two values the API knows', () => {
    expect(methodsParam.parse('')).toBe('');
    expect(methodsParam.parse('POST')).toBe('POST');
    expect(() => methodsParam.parse('GET')).toThrow();
  });

  it('restricts unique to the five upsert keys', () => {
    expect(uniqueParam.parse(['name', 'tags'])).toEqual(['name', 'tags']);
    expect(() => uniqueParam.parse(['desc'])).toThrow();
    expect(() => uniqueParam.parse([])).toThrow();
  });

  it('bounds limits, ping numbers and timestamps', () => {
    expect(limitParam.parse(500)).toBe(500);
    expect(() => limitParam.parse(501)).toThrow();
    expect(() => pingNumberParam.parse(0)).toThrow();
    expect(() => unixTimeParam.parse(-1)).toThrow();
  });

  it('expects a confirmation token of exactly the shape the store issues', () => {
    expect(confirmTokenParam.parse('a'.repeat(32))).toBe('a'.repeat(32));
    expect(() => confirmTokenParam.parse('yes')).toThrow();
    expect(() => confirmTokenParam.parse('A'.repeat(32))).toThrow();
  });
});
