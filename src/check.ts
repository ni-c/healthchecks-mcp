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
 */

export interface Check {
  [key: string]: unknown;
  uuid?: string;
  unique_key?: string;
  name?: string;
  slug?: string;
  tags?: string;
  status?: string;
  timeout?: number;
  schedule?: string;
  tz?: string;
}

/** Fields dropped from every response: legacy, derived and not writable. */
const LEGACY_FIELDS = ['subject', 'subject_fail'];

/** The identifier this object can actually be addressed by, whichever it carries. */
export function checkIdOf(check: Check): string | undefined {
  return check.uuid ?? check.unique_key;
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

/** Normalizes one check without dropping anything a caller might need. */
export function normalizeCheck(check: Check): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...check };
  for (const field of LEGACY_FIELDS) delete normalized[field];

  normalized.id = checkIdOf(check);
  normalized.id_kind = check.uuid
    ? 'uuid'
    : check.unique_key
      ? 'unique_key'
      : 'none';
  normalized.tags = tagsOf(check);
  normalized.schedule_kind = scheduleKindOf(check);
  if (typeof check.channels === 'string') {
    normalized.channels = check.channels
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return normalized;
}

/**
 * The compact projection used in list results.
 *
 * `desc` is deliberately absent: it is free text of up to ten thousand
 * characters and a list of two hundred checks would be mostly descriptions.
 * `get_check` returns it.
 */
export function summarizeCheck(check: Check): Record<string, unknown> {
  const kind = scheduleKindOf(check);
  return {
    id: checkIdOf(check),
    name: check.name ?? '',
    slug: check.slug ?? '',
    tags: tagsOf(check),
    status: check.status ?? 'unknown',
    started: check.started ?? false,
    last_ping: check.last_ping ?? null,
    next_ping: check.next_ping ?? null,
    n_pings: check.n_pings ?? 0,
    grace: check.grace,
    ...(kind === 'scheduled'
      ? { schedule: check.schedule, tz: check.tz }
      : { timeout: check.timeout }),
  };
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
  if (body && typeof body === 'object') {
    const flips = (body as { flips?: unknown }).flips;
    if (Array.isArray(flips)) return flips;
  }
  return [];
}

/** Reads a `{"<key>": [...]}` envelope, tolerating a bare array. */
export function listOf(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
