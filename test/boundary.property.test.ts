import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CALLS } from './calls.js';
import { call, connect, stubFetch, textOf } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Every tool, against whatever the instance felt like sending.
 *
 * The example tests next door pin the cases this review found. This one looks
 * for the next one: it drives each tool through the real server with a body
 * generated rather than chosen, and asserts three sentences never appear.
 *
 * - `Output validation error` is the SDK refusing the tool's own answer against
 *   its declared output schema. On SDK 2.0 that is not a protocol error any
 *   more, it is an `isError` result with no cause in it — which is quieter and
 *   worse: the model sees a failure it cannot act on, and a listing loses every
 *   good entry because of one bad one.
 * - `Cannot read properties` is a projection reading a field of `null`.
 * - `is not a function` is a projection calling `.map` or `.replace` on
 *   something that is not an array or a string.
 *
 * The generator is deliberately two-part. `fc.jsonValue()` alone almost never
 * produces the *shape* a tool reads, so it exercises the envelope handling and
 * nothing below it; the shaped envelopes carry the right keys with random
 * leaves, which is where the interesting values live. The `1e999` is spliced
 * into the serialised text, because no JavaScript generator can produce a
 * number that only exists as JSON.
 *
 * `SHAPE_RUNS` raises the count for a deep local pass; CI keeps it small.
 */
const RUNS = { numRuns: Number(process.env.SHAPE_RUNS ?? 60) };

/** The leaves that have broken something in this family before. */
const leaf = fc.oneof(
  fc.constant(null),
  fc.constant(true),
  fc.integer(),
  fc.double(),
  fc.constant(Number.MIN_SAFE_INTEGER - 1),
  fc.constant(-0),
  fc.string({ maxLength: 40 }),
  fc.constant('x'.repeat(30_000)),
  fc.constant({}),
  fc.constant([]),
  fc.constant({ toString: 'constructor' })
);

/** A check-shaped record whose every value is a random leaf. */
const shapedCheck = fc.dictionary(
  fc.constantFrom(
    'uuid',
    'unique_key',
    'name',
    'slug',
    'tags',
    'desc',
    'status',
    'started',
    'last_ping',
    'next_ping',
    'n_pings',
    'grace',
    'timeout',
    'schedule',
    'tz',
    'channels'
  ),
  leaf,
  { maxKeys: 8 }
);

const shapedPing = fc.dictionary(
  fc.constantFrom('type', 'date', 'n', 'scheme', 'remote_addr', 'method', 'ua'),
  leaf,
  { maxKeys: 5 }
);

/** The envelope each tool reads, with random contents inside it. */
const bodies: Record<string, fc.Arbitrary<unknown>> = {
  list_checks: fc.oneof(
    fc.record({
      checks: fc.array(fc.oneof(shapedCheck, leaf), { maxLength: 3 }),
    }),
    fc.jsonValue()
  ),
  get_check: fc.oneof(shapedCheck, fc.jsonValue()),
  list_pings: fc.oneof(
    fc.record({
      pings: fc.array(fc.oneof(shapedPing, leaf), { maxLength: 3 }),
    }),
    fc.jsonValue()
  ),
  get_ping_body: fc.oneof(fc.string({ maxLength: 200 }), fc.constant('')),
  list_flips: fc.oneof(
    fc.record({
      flips: fc.array(
        fc.oneof(fc.record({ timestamp: leaf, up: leaf }), leaf),
        { maxLength: 3 }
      ),
    }),
    fc.jsonValue()
  ),
  list_integrations: fc.oneof(
    fc.record({
      channels: fc.array(
        fc.oneof(fc.record({ id: leaf, name: leaf, kind: leaf }), leaf),
        { maxLength: 3 }
      ),
    }),
    fc.jsonValue()
  ),
  list_badges: fc.oneof(
    fc.record({
      badges: fc.dictionary(
        fc.string({ maxLength: 8 }),
        fc.oneof(fc.record({ svg: leaf, json: leaf }), leaf),
        { maxKeys: 3 }
      ),
    }),
    fc.jsonValue()
  ),
  get_status: fc.oneof(fc.string({ maxLength: 200 }), fc.constant('OK')),
  get_api_key_info: fc.oneof(
    fc.record({ checks: fc.jsonValue() }),
    fc.jsonValue()
  ),
  create_check: fc.oneof(shapedCheck, fc.jsonValue()),
  update_check: fc.oneof(shapedCheck, fc.jsonValue()),
  pause_check: fc.oneof(shapedCheck, fc.jsonValue()),
  resume_check: fc.oneof(shapedCheck, fc.jsonValue()),
  delete_check: fc.oneof(shapedCheck, fc.jsonValue()),
};

/** Tools whose fixture is text rather than JSON. */
const TEXT_TOOLS = new Set(['get_ping_body', 'get_status']);

const FORBIDDEN = [
  'Output validation error',
  'Cannot read properties',
  'is not a function',
  'ERR_INVALID_ARG_TYPE',
];

describe('no instance response makes a tool answer with a crash', () => {
  for (const [name, spec] of Object.entries(CALLS)) {
    it(`${name} survives whatever the instance sends`, async () => {
      await fc.assert(
        fc.asyncProperty(
          bodies[name] ?? fc.jsonValue(),
          fc.boolean(),
          async (body, spliceInfinity) => {
            const text = TEXT_TOOLS.has(name)
              ? String(body)
              : spliceInfinity
                ? JSON.stringify(body).replace(/:0(?=[,}])/g, ':1e999')
                : JSON.stringify(body);
            const routes: Record<string, unknown> = {};
            for (const route of Object.keys(spec.routes)) {
              routes[route] = {
                text,
                contentType: TEXT_TOOLS.has(name)
                  ? 'text/plain'
                  : 'application/json',
              };
            }
            stubFetch(routes as never);
            const result = await call(await connect(), name, spec.args ?? {});
            const answered = textOf(result);
            for (const sentence of FORBIDDEN) {
              expect(answered).not.toContain(sentence);
            }
          }
        ),
        RUNS
      );
    });
  }
});
