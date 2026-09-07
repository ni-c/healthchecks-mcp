import { describe, expect, it } from 'vitest';

import { normalizeSiteRoot } from '../src/config.js';
import {
  budget,
  MAX_RESULT_BYTES,
  ResultTooLargeError,
} from '../src/result.js';
import { cleanText, upstreamText } from '../src/clean.js';
import { summarizeCheck, tagsOf } from '../src/check.js';

/**
 * What an input can buy, in seconds.
 *
 * Each of these was measured against the old code before it was rewritten, and
 * the number in the comment is what it cost then. The assertions are deliberately
 * loose — a shared runner is not a benchmark — but a regression here is two
 * orders of magnitude, not twenty per cent, so a loose bound still catches it.
 */
function millis(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

describe('the operator’s own configuration value', () => {
  it('trims trailing slashes in linear time', () => {
    // `/\/+$/` is tried from every position of the run and consumes it each
    // time. The trigger needs a character *after* the run, or the pattern
    // matches at position 0 and the probe reads as "held": measured 138 ms at
    // 20 000, 483 at 40 000, 1832 at 80 000 — the curve is the finding.
    const elapsed = millis(() => {
      normalizeSiteRoot(`${'/'.repeat(80_000)}api`);
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('still trims what it is supposed to trim', () => {
    expect(normalizeSiteRoot('https://hc.example.net///')).toBe(
      'https://hc.example.net'
    );
    expect(normalizeSiteRoot('https://hc.example.net/api/v3')).toBe(
      'https://hc.example.net'
    );
    expect(normalizeSiteRoot('https://hc.example.net/api/v3/')).toBe(
      'https://hc.example.net'
    );
    expect(normalizeSiteRoot('https://hc.example.net/hc')).toBe(
      'https://hc.example.net/hc'
    );
  });
});

describe('the result budget', () => {
  it('cuts many candidates per round rather than one', () => {
    // Each round ends in a full `JSON.stringify` to measure the result, so one
    // cut per round costs candidates × size. Measured on the old code: 2000
    // fields of 250 characters took 2.1 s, 5000 took 15 s and 10 000 took 63 s
    // — on the thread that serves every request — and every one of those runs
    // then gave up anyway, because 20 000 fields cannot be shortened under a
    // 100 kB ceiling however hard you cut them. Giving up is the right answer
    // here; taking a minute to reach it is not.
    const data: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) data[`field_${i}`] = 'x'.repeat(250);
    const elapsed = millis(() => {
      expect(() => budget(data)).toThrow(ResultTooLargeError);
    });
    expect(elapsed).toBeLessThan(3000);
  });

  it('shortens a structure that can fit, and fits it', () => {
    // Few enough fields that shortening each to its floor leaves room: this is
    // the shape a real oversized answer has — a handful of long descriptions,
    // not twenty thousand short ones.
    const data: Record<string, string> = {};
    for (let i = 0; i < 300; i++) data[`field_${i}`] = 'x'.repeat(5000);
    let result: Record<string, unknown> = {};
    const elapsed = millis(() => {
      result = budget(data);
    });
    expect(elapsed).toBeLessThan(1000);
    expect(
      Buffer.byteLength(JSON.stringify(result, null, 2))
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(String(result.field_0)).toContain('more characters omitted');
  });

  it('reaches a long string nested under an object', () => {
    // Every write tool answers `{ check: { desc: … } }`, and a pass over the top
    // level only finds nothing there: the tool threw instead of shortening.
    const result = budget({
      check: { id: 'x', desc: 'd'.repeat(MAX_RESULT_BYTES + 1000) },
    });
    const check = result.check as Record<string, string>;
    expect(check.desc).toContain('more characters omitted');
    expect(
      Buffer.byteLength(JSON.stringify(result, null, 2))
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('reaches a long array nested under an object', () => {
    const result = budget({
      badges: {
        prod: { urls: Array.from({ length: 40_000 }, (_, i) => `u${i}`) },
      },
    });
    expect(
      Buffer.byteLength(JSON.stringify(result, null, 2))
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(JSON.stringify(result)).toContain('more entries omitted');
  });

  it('cannot be switched off by a value that ends in its own note', () => {
    // The shortener used to skip any string ending in the note it writes, which
    // is a switch anybody who can name a check could flip: the budget then
    // could not be met and the tool answered an error for that one object.
    const data = {
      desc: `${'z'.repeat(MAX_RESULT_BYTES)}… (5 more characters omitted)`,
    };
    const result = budget(data);
    expect(
      Buffer.byteLength(JSON.stringify(result, null, 2))
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('gives up rather than looping when there is nothing left to cut', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 6000; i++) data[`field_${i}`] = 'x'.repeat(20);
    expect(() => budget(data)).toThrow(ResultTooLargeError);
  });

  it('does not split a surrogate pair when it cuts', () => {
    const result = budget({ desc: '😀'.repeat(MAX_RESULT_BYTES / 2) });
    expect(String(result.desc).isWellFormed()).toBe(true);
  });
});

describe('the cleaner and the projections', () => {
  it('cleans a megabyte of text in linear time', () => {
    const text = `${'a'.repeat(1_000_000)}${String.fromCharCode(27)}`;
    const elapsed = millis(() => {
      cleanText(text);
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('bounds an error body before matching anything against it', () => {
    const elapsed = millis(() => {
      upstreamText('a'.repeat(2_000_000));
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('splits a huge tag string in linear time', () => {
    const elapsed = millis(() => {
      tagsOf({ tags: 'tag '.repeat(200_000) });
    });
    expect(elapsed).toBeLessThan(500);
  });

  it('bounds a description on the way in, before the budget sees it', () => {
    // The cut is at the boundary rather than in the budget: a `desc` a proxy
    // padded to a megabyte would otherwise make every listing carrying it
    // unanswerable, and a listing is the tool people call first.
    const summary = summarizeCheck({
      uuid: '403c0ad2-72ac-4f0a-8802-69ee5c9e29fd',
      name: 'n'.repeat(1_000_000),
    });
    expect(String(summary.name)).toContain('more characters omitted');
    expect(String(summary.name).length).toBeLessThan(21_000);
  });
});
