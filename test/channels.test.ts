import { afterEach, describe, expect, it, vi } from 'vitest';

import { CALLS } from './calls.js';
import { call, connect, stubFetch, textOf, tokenOf } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The two halves of a result have to say the same thing.
 *
 * Every tool here declares an `outputSchema` and answers with
 * `structuredContent` beside a text block. A client that reads the structured
 * half and a person reading the text are then looking at the same document —
 * unless nobody checks, in which case the two drift apart one tool at a time
 * and neither reader can tell.
 *
 * Nothing asserted this before. It is one loop over the catalogue, and it is
 * what makes the two deliberate exceptions below *exceptions* rather than
 * simply the way those tools happen to behave.
 */

/**
 * The tools whose text block is deliberately not the JSON.
 *
 * Both answer with a piece of text as their subject: a ping body is the output
 * of a job, and a status endpoint's answer is a line somebody's proxy wrote.
 * Rendering those as a JSON string would put a job's stack trace behind escaped
 * newlines, which is unreadable for the one reader who needs it. So the text
 * block carries the text and `structuredContent` carries it as a field beside
 * the check and ping it belongs to.
 *
 * Named here, with the reason, because an undocumented exception is the same
 * shape as a bug.
 */
const TEXT_TOOLS: Record<string, string> = {
  get_ping_body:
    'the text block is the ping body itself, so a job’s output is readable',
  get_status:
    'the text block is a sentence about the instance, with the answer inside it',
};

/**
 * Tools that ask before they act, driven through their two-call token so the
 * result being compared is the one the tool answers *after* the confirmation.
 */
const GUARDED = new Set(['delete_check']);

/** The JSON a result carries, past the untrusted-content preamble if any. */
function structuredHalf(text: string): unknown {
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as unknown;
}

describe('both result channels carry the same document', () => {
  for (const [name, spec] of Object.entries(CALLS)) {
    if (name in TEXT_TOOLS) continue;
    it(`${name} says the same thing twice`, async () => {
      stubFetch(spec.routes as never);
      const client = await connect();
      const args = spec.args ?? {};
      const first = await call(client, name, args);
      const result = GUARDED.has(name)
        ? await call(client, name, { ...args, confirm_token: tokenOf(first) })
        : first;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(structuredHalf(textOf(result))).toEqual(result.structuredContent);
    });
  }

  it('get_ping_body is an exception on purpose: the body is the text block', async () => {
    const spec = CALLS.get_ping_body;
    if (!spec) throw new Error('get_ping_body is not in the catalogue');
    stubFetch(spec.routes as never);
    const result = await call(
      await connect(),
      'get_ping_body',
      spec.args ?? {}
    );
    expect(result.isError).not.toBe(true);
    // Still both channels, still both marked — only the text block is the
    // subject itself rather than a serialisation of the record.
    expect(result.structuredContent).toMatchObject({
      untrusted: true,
      source: 'healthchecks',
    });
    expect(textOf(result)).toContain('untrusted content from Healthchecks');
  });

  it('get_status is an exception twice over, and the second one is conditional', async () => {
    // On the happy path the answer is this server's own sentence about its own
    // configuration, and it carries no marker at all — a marker on everything
    // is a marker that means nothing. Anything other than "OK" is up to 4 kB
    // written by whatever answered, on the one endpoint that takes no key, and
    // that *is* marked.
    stubFetch({ 'GET /status/': { text: 'OK', contentType: 'text/plain' } });
    const healthy = await call(await connect(), 'get_status');
    expect(healthy.structuredContent).toMatchObject({ ok: true });
    expect(healthy.structuredContent).not.toHaveProperty('untrusted');
    expect(textOf(healthy)).not.toContain('untrusted content');

    stubFetch({
      'GET /status/': { text: 'Login required', contentType: 'text/html' },
    });
    const foreign = await call(await connect(), 'get_status');
    expect(foreign.structuredContent).toMatchObject({
      untrusted: true,
      source: 'healthchecks',
      ok: false,
    });
    expect(textOf(foreign)).toContain('untrusted content from Healthchecks');
  });

  it('covers every tool in the catalogue', () => {
    // So a tool added later cannot quietly skip the rule by not being here.
    const covered = new Set(Object.keys(CALLS));
    for (const name of Object.keys(TEXT_TOOLS)) {
      expect(covered.has(name)).toBe(true);
    }
    expect(covered.size).toBe(Object.keys(CALLS).length);
  });
});
