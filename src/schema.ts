import { z } from 'zod';

/**
 * Shared parameter schemas.
 *
 * They live here rather than next to each tool so that the same rule is spelled
 * once — and so the regression tests have a single place to prove that the
 * awkward parts of this API (three different identifiers, two different list
 * separators) cannot be got wrong by a caller.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `unique_key` is a 40-character SHA1 — the only identifier a read-only key sees. */
const UNIQUE_KEY = /^[0-9a-f]{40}$/i;

export const uuidParam = z
  .string()
  .trim()
  .regex(
    UUID,
    'must be a check UUID, for example "f618072a-7bde-4eee-af63-71a77c5723bc"'
  )
  .describe(
    'The check UUID. Read-only API keys never see it — use list_checks with a ' +
      'read-write key to obtain one.'
  );

/**
 * A UUID or a `unique_key`.
 *
 * Only `get_check` and `list_flips` accept both; every other endpoint routes on
 * a UUID-shaped path segment and answers a `unique_key` with a bare 404 from the
 * URL resolver, which is why the distinction is a schema and not a comment.
 */
export const checkIdParam = z
  .string()
  .trim()
  .refine(
    (value) => UUID.test(value) || UNIQUE_KEY.test(value),
    'must be a check UUID or a 40-character unique_key (what a read-only API key returns instead of a UUID)'
  )
  .describe(
    'Check UUID, or the unique_key that a read-only API key returns instead.'
  );

/**
 * A check slug.
 *
 * Slugs are *not* unique within a project and are not addressable as a path
 * segment — the API only offers them as a filter on the list endpoint, so this
 * is only ever used as a query parameter.
 */
export const slugParam = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9_-]+$/,
    'a slug contains only lowercase letters, digits, hyphens and underscores'
  );

/**
 * One tag.
 *
 * The API stores tags as a single space-delimited string, so a tag containing a
 * space is not a tag — it is two, silently. Rejecting it here is the only place
 * that stays true after the value has been joined.
 */
export const tagParam = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^\S+$/,
    'tags are stored space-delimited, so a tag cannot contain spaces'
  );

export const tagsParam = z
  .array(tagParam)
  .max(50)
  .describe(
    'Tags. Stored space-delimited upstream, so no tag may contain a space.'
  );

export const nameParam = z
  .string()
  .trim()
  .max(100)
  .describe('Display name of the check.');

export const descParam = z
  .string()
  .max(10_000)
  .describe('Free-text description shown in the Healthchecks UI.');

/** Both `timeout` and `grace` are seconds and share the upstream 60 … 31536000 range. */
const seconds = z.number().int().min(60).max(31_536_000);

export const timeoutParam = seconds.describe(
  'Expected period between pings, in seconds (60 … 31536000). Mutually exclusive with schedule.'
);

export const graceParam = seconds.describe(
  'Grace period before a late check is reported down, in seconds (60 … 31536000).'
);

export const scheduleParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, 'a schedule is a single line')
  .describe(
    'A cron expression or a systemd OnCalendar expression; the instance detects ' +
      'which. Takes precedence over timeout, so the two cannot be combined.'
  );

export const tzParam = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_+\-/]+$/,
    'must be an IANA time zone name such as "Europe/Berlin"'
  )
  .describe(
    'Time zone for schedule, e.g. "Europe/Berlin". Only meaningful with schedule.'
  );

/**
 * Notification integrations for a check.
 *
 * Deliberately not optional-with-no-default at the tool level: a check created
 * without channels is a check that never notifies anyone, which is the most
 * dangerous default in this API and looks identical to a working one.
 */
export const channelsParam = z
  .union([
    z.literal('*').describe('every integration in the project'),
    // `.min(1)`, because an empty array serialises to the empty string, which
    // Healthchecks reads as "no integrations at all". That silently turns a
    // monitored check into one that never alerts anyone — the same outcome as
    // `pause_check`, which this server gates behind a confirmation token.
    // Clearing every integration is deliberately not offered here; the web UI
    // does it, in front of someone who can see what it means.
    z.array(z.string().trim().min(1).max(100)).min(1),
  ])
  .describe(
    'Integrations to notify: "*" for all of them, or a list of integration UUIDs ' +
      'or exact names (see list_integrations). Replaces the current set, it does ' +
      'not merge. An empty list is refused — it would leave the check alerting nobody.'
  );

/**
 * A keyword filter list.
 *
 * Stored comma-delimited upstream — the opposite separator from tags — so a
 * keyword containing a comma would silently become two.
 */
export const keywordsParam = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(
        /^[^,]+$/,
        'keywords are stored comma-delimited, so one cannot contain a comma'
      )
  )
  .max(50);

export const methodsParam = z
  .enum(['', 'POST'])
  .describe(
    'Allowed ping methods: "" accepts HEAD, GET and POST, "POST" accepts only POST.'
  );

export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(500)
  .describe('Maximum number of entries to return.');

export const pingNumberParam = z
  .number()
  .int()
  .min(1)
  .describe('Ping number `n`, as reported by list_pings.');

export const confirmTokenParam = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, 'a confirmation token is 32 hexadecimal characters')
  .describe('Token from a previous call of this tool.');

/** Unix timestamps for the flips window. Negative or absurd values are a 400 upstream. */
export const unixTimeParam = z
  .number()
  .int()
  .min(0)
  .max(4_102_444_800)
  .describe('Unix timestamp in seconds.');

export const secondsWindowParam = z
  .number()
  .int()
  .min(1)
  .max(31_536_000)
  .describe('Only flips from the last N seconds.');

/**
 * The upsert keys accepted by `POST /checks/`.
 *
 * Restricted to the five values the API allows, because an unknown key is a 400
 * and because the whole parameter turns a create into a silent update.
 */
export const uniqueParam = z
  .array(z.enum(['name', 'slug', 'tags', 'timeout', 'grace']))
  .min(1)
  .max(5)
  .describe(
    'Turns this call into an upsert: if an existing check matches on all of these ' +
      'fields, it is UPDATED instead of a new one being created.'
  );

export const pingTypeParam = z
  .enum(['success', 'start', 'fail', 'log', 'ign'])
  .describe('Only pings of this type.');
