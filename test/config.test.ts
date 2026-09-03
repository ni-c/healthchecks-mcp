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

const complete = { HEALTHCHECKS_API_KEY: RW_KEY };

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env({ ...complete })).elicitation).toBe(true);
    expect(loadConfig(env({ ...complete, ELICITATION: '' })).elicitation).toBe(
      true
    );
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(
        loadConfig(env({ ...complete, ELICITATION: raw })).elicitation,
        raw
      ).toBe(false);
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ...complete, ELICITATION: raw }))).toThrow(
        'exit'
      );
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ...complete, ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.HEALTHCHECKS_API_KEY).toBeUndefined();
    vi.restoreAllMocks();
  });
});

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

describe('the two booleans, read in opposite directions', () => {
  it('reads READ_ONLY generously, because it only takes capability away', () => {
    // Somebody who wrote "True", "1", "yes" or "true " meant the safe thing.
    // Requiring exactly "true" left every write tool registered on any of
    // those spellings, silently, in the direction that matters.
    for (const raw of ['true', 'True', 'TRUE', '1', 'yes', 'YES', ' true ']) {
      expect(
        loadConfig(env({ ...complete, HEALTHCHECKS_READ_ONLY: raw })).readOnly,
        JSON.stringify(raw)
      ).toBe(true);
    }
    for (const raw of ['', 'false', 'no', '0', 'ture', 'on']) {
      expect(
        loadConfig(env({ ...complete, HEALTHCHECKS_READ_ONLY: raw })).readOnly,
        JSON.stringify(raw)
      ).toBe(false);
    }
    expect(loadConfig(env({ ...complete })).readOnly).toBe(false);
  });

  it('reads INSECURE_TLS exactly, because it weakens the server', () => {
    for (const raw of ['1', 'yes', 'True', 'TRUE', ' true ']) {
      expect(
        loadConfig(env({ ...complete, HEALTHCHECKS_INSECURE_TLS: raw }))
          .insecureTls,
        JSON.stringify(raw)
      ).toBe(false);
    }
    expect(
      loadConfig(env({ ...complete, HEALTHCHECKS_INSECURE_TLS: 'true' }))
        .insecureTls
    ).toBe(true);
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
