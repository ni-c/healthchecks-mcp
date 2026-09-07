/**
 * The boundary between what the instance sent and what this server reasons
 * about.
 *
 * Every response used to be a TypeScript cast — `as Check` — which is not a
 * check at all. The output schemas each tool declares *are* checked, by the SDK,
 * on every success path: a `name` that is a number, a `grace` that is `null`, an
 * `n_pings` of `1e999` (`Infinity` after `JSON.parse`), a `null` where a check
 * belongs — each of these took a whole listing down with `Output validation
 * error` or a `TypeError` out of the projection, and each is one line in the
 * JSON of an instance, of a proxy in front of it, or of whatever a mistyped
 * `HEALTHCHECKS_URL` lands on.
 *
 * The policy, decided deliberately: a field of the wrong type is **absent**, and
 * the check stays in the listing. A monitoring server that hides checks because
 * one field is odd is worse than one that shows the check without the field —
 * the whole point of a listing here is that nothing is silently missing. Only a
 * value that is not an object at all cannot be shown, and those are counted and
 * reported rather than dropped in silence.
 */

/** Longest display string carried on: `desc` is 10 000 characters upstream. */
export const MAX_DISPLAY_CHARS = 20_000;

/** The identifiers Healthchecks addresses a check by. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_KEY = /^[0-9a-f]{40}$/i;

/** A record, or `undefined` for anything else — including an array and `null`. */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A record, or an empty one.
 *
 * For the places where an empty answer is a legitimate answer: `request()` maps
 * a 204 or an empty body to `undefined`, and `Buffer.byteLength(undefined)` is
 * Node's `ERR_INVALID_ARG_TYPE` rather than anything a reader can act on.
 */
export function recordOr(value: unknown): Record<string, unknown> {
  return objectOf(value) ?? {};
}

/**
 * A string, cut at `max` characters with a note saying so.
 *
 * The cut is on the way *in*, before the result budget ever sees the value: a
 * `desc` that a proxy padded to a megabyte would otherwise make every listing
 * carrying it unanswerable, and the budget's shortening is a last resort rather
 * than the ceiling.
 */
export function stringOf(
  value: unknown,
  max = MAX_DISPLAY_CHARS
): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max).toWellFormed()}… (${value.length - max} more characters omitted)`;
}

/**
 * A safe integer.
 *
 * Zod 4 refuses `2 ** 53` and `1e20` for `.int()` and `Infinity` for
 * `z.number()`, so a count the instance wrote as `1e999` is not a large number
 * here — it is a result the SDK will not let out.
 */
export function safeIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value + 0
    : undefined;
}

export function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A string that is `null` upstream when it has no value, and absent otherwise. */
export function nullableStringOf(
  value: unknown,
  max = MAX_DISPLAY_CHARS
): string | null | undefined {
  if (value === null) return null;
  return stringOf(value, max);
}

/**
 * A check identifier with the shape Healthchecks promises for one.
 *
 * It is spliced into a request path and quoted into sentences — `delete_check`
 * says "check <id> is gone" — so anything else is treated as absent. A read-write
 * key sees `uuid`, a read-only key sees a 40-character `unique_key`, and the
 * difference between them is the whole of how a check is addressed.
 */
export function checkIdShapeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return UUID.test(value) || UNIQUE_KEY.test(value) ? value : undefined;
}

/**
 * The records of a listing, with the entries that are not records counted.
 *
 * Counted rather than dropped in silence: a `null` in a list of checks means
 * something is wrong with the instance or with what is answering for it, and a
 * listing that is quietly one entry short is the least useful way to say so.
 */
export function recordsOf(items: unknown[]): {
  records: Record<string, unknown>[];
  skipped: number;
} {
  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const item of items) {
    const record = objectOf(item);
    if (record === undefined) {
      skipped++;
      continue;
    }
    records.push(record);
  }
  return { records, skipped };
}

/** The sentence a listing carries when {@link recordsOf} skipped something. */
export function skippedNote(skipped: number, what: string): string {
  return (
    `${skipped} ${skipped === 1 ? 'entry' : 'entries'} in the instance's ` +
    `${what} response ${skipped === 1 ? 'was' : 'were'} not an object and ` +
    'could not be shown. Something other than Healthchecks may be answering, ' +
    'or the instance is on a release this server does not know.'
  );
}
