import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_URL,
  loadConfig,
  looksReadOnlyKey,
  malformedApiKeyMessage,
  missingConfigKeys,
  normalizeSiteRoot,
} from '../src/config.js';
import { RO_KEY, RW_KEY, testConfig } from './harness.js';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

function quiet(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('loadConfig', () => {
  it('starts without an API key so tools stay listable', () => {
    const spy = quiet();
    const config = loadConfig(env({}));
    expect(config.apiKey).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual(['HEALTHCHECKS_API_KEY']);
    spy.mockRestore();
  });

  it('defaults to the hosted instance and says so', () => {
    const config = loadConfig(env({ HEALTHCHECKS_API_KEY: RW_KEY }));
    expect(config.url).toBe(DEFAULT_URL);
    expect(config.usingDefaultUrl).toBe(true);
  });

  it('deletes the API key from the environment after reading it', () => {
    const e = env({ HEALTHCHECKS_API_KEY: RW_KEY });
    const config = loadConfig(e);
    expect(config.apiKey).toBe(RW_KEY);
    expect(e.HEALTHCHECKS_API_KEY).toBeUndefined();
  });

  it('deletes the key even when the URL is rejected afterwards', () => {
    // The delete has to happen before any branch that can exit, or a
    // misconfigured URL leaves the key in the environment of every child.
    const spy = quiet();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({
      HEALTHCHECKS_API_KEY: RW_KEY,
      HEALTHCHECKS_URL: 'not a url',
    });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.HEALTHCHECKS_API_KEY).toBeUndefined();
    exit.mockRestore();
    spy.mockRestore();
  });

  it('never echoes the rejected URL back', () => {
    // The value could contain a token someone pasted into the wrong variable.
    const spy = quiet();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig(env({ HEALTHCHECKS_URL: 'ht!tp://secret-in-here' }))
    ).toThrow('exit');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret-in-here');
    exit.mockRestore();
    spy.mockRestore();
  });

  it('rejects a URL containing credentials', () => {
    const spy = quiet();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig(
        env({
          HEALTHCHECKS_URL: 'https://user:pw@hc.example.net',
          HEALTHCHECKS_API_KEY: RW_KEY,
        })
      )
    ).toThrow('exit');
    exit.mockRestore();
    spy.mockRestore();
  });

  it('rejects a non-http scheme', () => {
    const spy = quiet();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig(env({ HEALTHCHECKS_URL: 'file:///etc/passwd' }))
    ).toThrow('exit');
    exit.mockRestore();
    spy.mockRestore();
  });

  it('warns about plain http to a remote host but keeps going', () => {
    const spy = quiet();
    const config = loadConfig(
      env({
        HEALTHCHECKS_URL: 'http://hc.example.net',
        HEALTHCHECKS_API_KEY: RW_KEY,
      })
    );
    expect(config.url).toBe('http://hc.example.net');
    expect(spy.mock.calls.flat().join(' ')).toMatch(/unencrypted/);
    spy.mockRestore();
  });

  it('does not warn about plain http to loopback', () => {
    const spy = quiet();
    loadConfig(
      env({
        HEALTHCHECKS_URL: 'http://localhost:8000',
        HEALTHCHECKS_API_KEY: RW_KEY,
      })
    );
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/unencrypted/);
    spy.mockRestore();
  });

  it.each([
    ['bracketed IPv6', 'http://[::1]:8000'],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]:8000'],
    ['a fully qualified localhost', 'http://localhost.:8000'],
  ])('does not warn about plain http to loopback spelled as %s', (_, url) => {
    // URL.hostname hands back '[::1]' with its brackets and normalises
    // ::ffff:127.0.0.1 to '[::ffff:7f00:1]'. The comparison this replaced
    // checked for a bare '::1' and so warned about every one of these.
    const spy = quiet();
    loadConfig(env({ HEALTHCHECKS_URL: url, HEALTHCHECKS_API_KEY: RW_KEY }));
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/unencrypted/);
    spy.mockRestore();
  });

  it('warns about a key of the wrong length instead of leaving it to a 401', () => {
    const spy = quiet();
    loadConfig(env({ HEALTHCHECKS_API_KEY: 'too-short' }));
    expect(spy.mock.calls.flat().join(' ')).toMatch(/exactly 32 characters/);
    spy.mockRestore();
  });
});

describe('normalizeSiteRoot', () => {
  // People copy the value out of the API docs, where every example is a full
  // /api/v3/... URL, and the neighbouring MCP servers ask for the suffix.
  it.each([
    ['https://hc.example.net', 'https://hc.example.net'],
    ['https://hc.example.net/', 'https://hc.example.net'],
    ['https://hc.example.net///', 'https://hc.example.net'],
    ['https://hc.example.net/api/v3', 'https://hc.example.net'],
    ['https://hc.example.net/api/v3/', 'https://hc.example.net'],
    ['https://hc.example.net/api/v1', 'https://hc.example.net'],
    ['https://hc.example.net/hc/api/v3', 'https://hc.example.net/hc'],
  ])('trims %s to %s', (input, expected) => {
    expect(normalizeSiteRoot(input)).toBe(expected);
  });

  it('leaves a path that only looks like the API prefix alone', () => {
    expect(normalizeSiteRoot('https://hc.example.net/api/v3/checks')).toBe(
      'https://hc.example.net/api/v3/checks'
    );
  });
});

describe('key inspection', () => {
  it('accepts a key of exactly 32 characters', () => {
    expect(malformedApiKeyMessage(testConfig())).toBeUndefined();
  });

  it('complains about any other length, naming the number', () => {
    const message = malformedApiKeyMessage(testConfig({ apiKey: 'abc' }));
    expect(message).toMatch(/3 characters/);
    expect(message).toMatch(/ping key is not an API key/);
  });

  it('says nothing when there is no key at all', () => {
    expect(
      malformedApiKeyMessage(testConfig({ apiKey: undefined }))
    ).toBeUndefined();
  });

  it('recognises the hcr_ prefix of a hosted read-only key', () => {
    expect(looksReadOnlyKey(RO_KEY)).toBe(true);
    expect(looksReadOnlyKey(RW_KEY)).toBe(false);
    expect(looksReadOnlyKey(undefined)).toBe(false);
  });
});

describe('a URL carrying more than a site root', () => {
  it('drops a query and a fragment rather than gluing them in front of /api/v3', () => {
    // normalizeSiteRoot only trims slashes and an API suffix, so validating the
    // parsed URL and then storing the raw string let a fragment survive —
    // producing https://host#/api/v3/checks/ on every request.
    for (const [input, expected] of [
      ['https://hc.example.net#', 'https://hc.example.net'],
      ['https://hc.example.net?next=/', 'https://hc.example.net'],
      ['https://hc.example.net/api/v3#frag', 'https://hc.example.net'],
    ] as const) {
      const config = loadConfig(
        env({ HEALTHCHECKS_URL: input, HEALTHCHECKS_API_KEY: RW_KEY })
      );
      expect(config.url, input).toBe(expected);
    }
  });
});
