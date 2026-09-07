import { describe, expect, it } from 'vitest';

import {
  cleanText,
  cleanValue,
  countControl,
  describeValue,
  hasControl,
  redactUserinfo,
  upstreamText,
} from '../src/clean.js';

/**
 * The cleaner, which is the one place text from the instance is made safe.
 *
 * Every control character in this file is built at runtime from its code point.
 * Spelled as an escape it would survive exactly as long as it takes an editing
 * tool to rewrite the escape into the byte, at which point the file carries the
 * character it is supposed to be testing for and nothing says so.
 */
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9b);
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe('cleanText', () => {
  it('removes C0, C1 and DEL but keeps tab, line feed and carriage return', () => {
    const input = `a${ESC}[31mb${NUL}c${DEL}d${C1}e\tf\ng\rh`;
    expect(cleanText(input)).toBe('a[31mbcde\tf\ng\rh');
  });

  it('leaves an ordinary string exactly as it came', () => {
    const input = 'Nightly Backup — läuft täglich, 日次バックアップ';
    expect(cleanText(input)).toBe(input);
    expect(hasControl(input)).toBe(false);
  });

  it('keeps format characters, which are content in a name', () => {
    // A bidi mark in a check named in Arabic is part of the name.
    const mark = String.fromCharCode(0x200f);
    expect(cleanText(`x${mark}y`)).toBe(`x${mark}y`);
  });

  it('replaces a lone surrogate rather than passing half a character on', () => {
    // Legal JSON, and a Python client encoding the result to UTF-8 raises on it.
    expect(cleanText(`a${HIGH_SURROGATE}b`)).toBe(`a${REPLACEMENT}b`);
  });

  it('counts what it would remove', () => {
    expect(countControl(`${ESC}x${NUL}${DEL}`)).toBe(3);
    expect(countControl('nothing here')).toBe(0);
    expect(hasControl(`x${ESC}`)).toBe(true);
  });
});

describe('cleanValue', () => {
  it('cleans keys as well as values, at every depth', () => {
    const value = cleanValue({
      [`tag${ESC}`]: { name: `x${NUL}y`, list: [`a${DEL}b`] },
    }) as Record<string, { name: string; list: string[] }>;
    expect(Object.keys(value)).toEqual(['tag']);
    expect(value.tag?.name).toBe('xy');
    expect(value.tag?.list[0]).toBe('ab');
  });

  it('keeps a __proto__ key as an own property', () => {
    // An own property after JSON.parse, and legal JSON from any instance. Built
    // with `out[key] = …` it would set the prototype and vanish without error.
    const cleaned = cleanValue(
      JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}')
    ) as Record<string, unknown>;
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('passes numbers, booleans and null through untouched', () => {
    expect(cleanValue({ a: 1, b: true, c: null })).toEqual({
      a: 1,
      b: true,
      c: null,
    });
  });
});

describe('upstreamText', () => {
  it('drops a markup-shaped body whole', () => {
    expect(upstreamText('<!DOCTYPE html><html>...')).toBe(
      '(HTML error page omitted)'
    );
    expect(upstreamText('<?xml version="1.0"?><err/>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('cleans and cuts anything else', () => {
    const cut = upstreamText(`${ESC}[2J${'x'.repeat(3000)}`, 100);
    expect(cut).not.toContain(ESC);
    expect(cut).toContain('(truncated)');
    expect(cut.length).toBeLessThan(200);
  });

  it('says so rather than answering with nothing', () => {
    expect(upstreamText('   ')).toBe('(empty body)');
  });

  it('does not split a surrogate pair at the cut', () => {
    // Two code units per character, so a cut at an odd length lands inside one.
    const cleaned = upstreamText('😀'.repeat(50), 11);
    expect(cleaned.isWellFormed()).toBe(true);
  });
});

describe('describeValue', () => {
  it('quotes a short value and describes a long one by its length', () => {
    expect(describeValue('yes')).toBe('"yes"');
    expect(describeValue('k'.repeat(64))).toBe('a 64-character value');
    expect(describeValue('')).toBe('an empty value');
  });

  it('never carries a credential out of a URL', () => {
    expect(describeValue('https://user:hunter2@hc.example.net', 120)).toBe(
      '"https://<credentials redacted>@hc.example.net"'
    );
  });
});

describe('redactUserinfo', () => {
  it('stops at the last @ before the path, not the first', () => {
    // A password may contain an @, and cutting at the first one leaves the rest
    // of it in the message.
    expect(redactUserinfo('https://user:p@ss@host/path')).toBe(
      'https://<credentials redacted>@host/path'
    );
  });

  it('leaves a URL without credentials alone', () => {
    expect(redactUserinfo('https://hc.example.net/a@b')).toBe(
      'https://hc.example.net/a@b'
    );
  });
});
