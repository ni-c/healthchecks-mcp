/**
 * Shaping of the API's check objects.
 *
 * Three things need doing before a check is worth handing to a model, and all
 * three are properties of the API rather than preferences:
 *
 * 1. There is no `kind` field. Whether a check is a simple timeout or a
 *    scheduled one has to be inferred from which of `timeout` / `schedule` is
 *    present, and a reader who does not know that reads a missing `timeout` as
 *    a missing value.
 * 2. The identifier is `uuid` for a read-write key and `unique_key` for a
 *    read-only one — never both, and the difference is invisible in the object.
 * 3. `subject` and `subject_fail` are legacy derived duplicates of
 *    `success_kw` / `failure_kw`; they are not writable and having them in the
 *    output invites an update that silently does nothing.
 *
 * And a fourth that is not about Healthchecks at all: none of these fields is
 * *promised* by anything. What arrives is JSON from an instance, from a proxy in
 * front of it, or from whatever a mistyped URL reached, and the output schema
 * this server declares is enforced by the SDK on every success path. So every
 * field the schema names is read through `boundary.ts` — a value of the wrong
 * type is absent, never fatal — instead of being cast and hoped for.
 */

import {
  booleanOf,
  checkIdShapeOf,
  nullableStringOf,
  objectOf,
  safeIntegerOf,
  stringOf,
} from './boundary.js';

export interface Check {
  [key: string]: unknown;
  uuid?: unknown;
  unique_key?: unknown;
  name?: unknown;
  slug?: unknown;
  tags?: unknown;
  status?: unknown;
  timeout?: unknown;
  schedule?: unknown;
  tz?: unknown;
}

/** Fields dropped from every response: legacy, derived and not writable. */
const LEGACY_FIELDS = ['subject', 'subject_fail'];

/**
 * Fields of a check that the output schemas name, and that therefore have to
 * hold their declared type or be absent. Everything else a release chose to add
 * passes through untouched — the schemas are loose for exactly that reason.
 */
const SHAPED_FIELDS = [
  // The two identifiers included: a `uuid` of `5`, or of `../../etc/passwd`,
  // used to travel on in the passed-through record beside an `id_kind` of
  // "none", which reads as an identifier to anything that does not know the
  // difference. What the instance sent is not addressable, so it is absent.
  'uuid',
  'unique_key',
  'name',
  'slug',
  'desc',
  'status',
  'tags',
  'channels',
  'timeout',
  'grace',
  'schedule',
  'tz',
  'n_pings',
  'started',
  'last_ping',
  'next_ping',
];

/**
 * The identifier this object can actually be addressed by, whichever it carries.
 *
 * Shape-checked, because the answer is spliced into a request path and quoted
 * into sentences: `uuid` is a UUID and `unique_key` is 40 hexadecimal
 * characters, and anything else is not an identifier this server can use.
 */
export function checkIdOf(check: Check): string | undefined {
  return checkIdShapeOf(check.uuid) ?? checkIdShapeOf(check.unique_key);
}

/** Which of the two identifier kinds the object carries, if either. */
export function idKindOf(check: Check): 'uuid' | 'unique_key' | 'none' {
  if (checkIdShapeOf(check.uuid) !== undefined) return 'uuid';
  if (checkIdShapeOf(check.unique_key) !== undefined) return 'unique_key';
  return 'none';
}

/**
 * Splits the space-delimited `tags` string into a list.
 *
 * Space-delimited is why `tagParam` refuses a tag containing a space: the round
 * trip through this function would turn one tag into two.
 */
export function tagsOf(check: Check): string[] {
  const raw = typeof check.tags === 'string' ? check.tags : '';
  return raw.split(/\s+/).filter((tag) => tag.length > 0);
}

/** `simple` when the check is driven by `timeout`, `scheduled` when by `schedule`. */
export function scheduleKindOf(check: Check): 'simple' | 'scheduled' {
  return typeof check.schedule === 'string' && check.schedule.length > 0
    ? 'scheduled'
    : 'simple';
}

/** The integration list, which the API stores comma-delimited. */
export function channelsOf(check: Check): string[] | undefined {
  if (typeof check.channels !== 'string') return undefined;
  return check.channels
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Assigns when the value is there, removes the field when it is not. */
function put(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (value === undefined) {
    delete target[key];
    return;
  }
  // `defineProperty` rather than assignment: `__proto__` is an own property
  // after `JSON.parse` and a plain assignment would write the prototype instead.
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Normalizes one check without dropping anything a caller might need. */
export function normalizeCheck(body: unknown): Record<string, unknown> {
  const check = (objectOf(body) ?? {}) as Check;
  const normalized: Record<string, unknown> = { ...check };
  for (const field of LEGACY_FIELDS) delete normalized[field];
  // Every field the output schema names is re-read from the instance's record
  // through the boundary, so the spread above cannot leave a `name: 5` behind.
  for (const field of SHAPED_FIELDS) delete normalized[field];

  put(normalized, 'uuid', checkIdShapeOf(check.uuid));
  put(normalized, 'unique_key', checkIdShapeOf(check.unique_key));
  put(normalized, 'id', checkIdOf(check));
  normalized.id_kind = idKindOf(check);
  normalized.tags = tagsOf(check);
  normalized.schedule_kind = scheduleKindOf(check);
  put(normalized, 'name', stringOf(check.name));
  put(normalized, 'slug', stringOf(check.slug));
  put(normalized, 'desc', stringOf(check.desc));
  put(normalized, 'status', stringOf(check.status));
  put(normalized, 'channels', channelsOf(check));
  put(normalized, 'timeout', safeIntegerOf(check.timeout));
  put(normalized, 'grace', safeIntegerOf(check.grace));
  put(normalized, 'schedule', stringOf(check.schedule));
  put(normalized, 'tz', stringOf(check.tz));
  put(normalized, 'n_pings', safeIntegerOf(check.n_pings));
  put(normalized, 'started', booleanOf(check.started));
  put(normalized, 'last_ping', nullableStringOf(check.last_ping));
  put(normalized, 'next_ping', nullableStringOf(check.next_ping));
  return normalized;
}

/**
 * The compact projection used in list results.
 *
 * `desc` is deliberately absent: it is free text of up to ten thousand
 * characters and a list of two hundred checks would be mostly descriptions.
 * `get_check` returns it.
 *
 * The defaults are not cosmetic. A listing is read as a table, so a check whose
 * `name` the instance sent as a number still occupies a row, with an empty name
 * and its identifier intact — rather than taking the whole listing down.
 */
export function summarizeCheck(body: unknown): Record<string, unknown> {
  const check = (objectOf(body) ?? {}) as Check;
  const kind = scheduleKindOf(check);
  const summary: Record<string, unknown> = {
    name: stringOf(check.name) ?? '',
    slug: stringOf(check.slug) ?? '',
    tags: tagsOf(check),
    status: stringOf(check.status) ?? 'unknown',
    started: booleanOf(check.started) ?? false,
    last_ping: nullableStringOf(check.last_ping) ?? null,
    next_ping: nullableStringOf(check.next_ping) ?? null,
    n_pings: safeIntegerOf(check.n_pings) ?? 0,
  };
  put(summary, 'id', checkIdOf(check));
  put(summary, 'grace', safeIntegerOf(check.grace));
  if (kind === 'scheduled') {
    put(summary, 'schedule', stringOf(check.schedule));
    put(summary, 'tz', stringOf(check.tz));
  } else {
    put(summary, 'timeout', safeIntegerOf(check.timeout));
  }
  return summary;
}

/**
 * Reads the flips out of a response.
 *
 * The published documentation shows a bare array while the implementation
 * returns `{"flips": [...]}`; both spellings are in the wild, since a
 * self-hosted instance can be any release. Accepting both is one line and
 * removes a whole class of "it works against my instance" bug report.
 */
export function flipsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const record = objectOf(body);
  if (record && Array.isArray(record.flips)) return record.flips;
  return [];
}

/** Reads a `{"<key>": [...]}` envelope, tolerating a bare array. */
export function listOf(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  const record = objectOf(body);
  if (record && Array.isArray(record[key])) return record[key];
  return [];
}
