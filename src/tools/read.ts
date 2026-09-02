import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  assertPathSegment,
  HealthchecksApiError,
  query,
  ReadWriteKeyRequiredError,
  ResponseTooLargeError,
  type HealthchecksApi,
  type RawResponse,
} from '../api.js';
import {
  listOf,
  flipsOf,
  normalizeCheck,
  summarizeCheck,
  type Check,
} from '../check.js';
import {
  budgetedUntrustedList,
  budgetedUntrustedResult,
  errorResult,
  jsonResult,
  run,
  untrustedTextResult,
} from '../result.js';
import {
  checkRecord,
  checkSummary,
  truncationNote,
  untrustedFields,
} from '../output-schema.js';
import {
  checkIdParam,
  limitParam,
  pingNumberParam,
  pingTypeParam,
  secondsWindowParam,
  slugParam,
  tagParam,
  unixTimeParam,
  uuidParam,
} from '../schema.js';

import { API_KEY_LENGTH, looksReadOnlyKey } from '../config.js';
import { READ_ONLY } from './annotations.js';

/** Default page size. The API paginates nothing, so every ceiling here is ours. */
const DEFAULT_LIMIT = 50;

/**
 * Ceiling on one logged ping body.
 *
 * The upstream default is 10 000 bytes (`PING_BODY_LIMIT`), but a self-hosted
 * instance can raise it, and this is the one endpoint whose content is written
 * by whatever pings the check.
 */
const MAX_PING_BODY_BYTES = 64 * 1024;

/** Endpoints the API gates behind a read-write key even though they only read. */
const NEEDS_READ_WRITE_KEY =
  'Note: Healthchecks requires a read-write API key for this endpoint even ' +
  'though it only reads. A read-only key is refused with HTTP 401 "wrong api ' +
  'key", which is not what it sounds like. Call get_api_key_info to check which ' +
  'kind is configured.\n\n' +
  'With a read-only key this tool cannot even be *called* correctly: it ' +
  'addresses a check by uuid, and a read-only key never sees one — ' +
  'list_checks answers with a 40-character unique_key instead. So the refusal ' +
  'you get first is about the argument, not the key. Neither is a mistake to ' +
  'fix: with a read-only key this endpoint is out of reach, and there is ' +
  'nothing to pass that would change it.';

/**
 * Translates the 401 that a read-only key produces on a read-write endpoint.
 *
 * Confirmed against a real instance: `/channels/`, `/pings/` and
 * `/pings/<n>/body` answer a read-only key with `401 {"error": "wrong api
 * key"}`. Passing that on would send the reader to re-check a key that is
 * perfectly correct, which is the exact confusion this server exists to remove.
 *
 * The translation used to fire on *any* 401, and its message ends "Nothing is
 * wrong with the key itself." A 401 has at least four causes, and that sentence
 * is false for three of them: a mistyped or rotated key, a key belonging to a
 * deleted project, and a ping key pasted in place of an API key. It is also the
 * first sentence the operator reads, so after a key rotation it sends them to
 * enter a *second* wrong key and look for the fault where it is not — the exact
 * confusion this function exists to prevent, pointing the other way.
 *
 * So the claim is now checked before it is made. `/checks/` is readable with
 * either kind of key: if it answers, the key is genuinely accepted and only the
 * endpoint is out of reach. If it does not, the original 401 goes through with
 * `statusHint(401)`, which names both possibilities instead of picking one.
 */
async function needsReadWriteKey<T>(
  api: HealthchecksApi,
  tool: string,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HealthchecksApiError && error.status === 401) {
      const accepted = await probe(api, '/checks/');
      if (accepted.ok) throw new ReadWriteKeyRequiredError(tool);
    }
    throw error;
  }
}

export function registerReadTools(
  server: McpServer,
  api: HealthchecksApi
): void {
  server.registerTool(
    'list_checks',
    {
      title: 'List checks',
      description:
        'Lists the checks in the project the API key belongs to, newest state ' +
        'first. API keys are per project, so this never spans projects. ' +
        'Descriptions are omitted here — call get_check for one.',
      inputSchema: z.object({
        tag: z
          .array(tagParam)
          .max(10)
          .optional()
          .describe('Only checks carrying all of these tags.'),
        slug: slugParam
          .optional()
          .describe(
            'Only checks with this slug. Slugs are not unique, so this can match several.'
          ),
        status: z
          .enum(['new', 'up', 'grace', 'down', 'paused'])
          .optional()
          .describe('Filtered client-side; the API has no status filter.'),
        limit: limitParam.optional().describe(`Default ${DEFAULT_LIMIT}.`),
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        truncated: truncationNote,
        checks: z.array(checkSummary),
        total_in_project: z.number().int(),
        note: z.string().optional(),
      }),
    },
    async ({ tag, slug, status, limit }) =>
      run(async () => {
        const body = await api.get(`/checks/${query({ tag, slug })}`);
        const all = listOf(body, 'checks') as Check[];
        const matching = status
          ? all.filter((check) => check.status === status)
          : all;
        const shown = matching.slice(0, limit ?? DEFAULT_LIMIT);
        return budgetedUntrustedList('checks', shown.map(summarizeCheck), {
          extra: {
            total_in_project: all.length,
            ...(matching.length > shown.length
              ? {
                  note:
                    `${matching.length} checks match; showing ${shown.length}. ` +
                    'Raise limit, or narrow with tag, slug or status.',
                }
              : {}),
          },
          narrowWith: 'Narrow the request with tag, slug or status.',
        });
      })
  );

  server.registerTool(
    'get_check',
    {
      title: 'Get check',
      description:
        'Fetches one check with all its fields, including the description and ' +
        'the keyword filters. Accepts a UUID, or the unique_key that a ' +
        'read-only API key returns in place of one.',
      inputSchema: z.object({ check: checkIdParam }),
      annotations: READ_ONLY,
      outputSchema: checkRecord.extend(untrustedFields),
    },
    async ({ check }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const body = (await api.get(`/checks/${id}`)) as Check;
        // The description is free text that reaches this server from whoever
        // edits the project, so it is data rather than instructions.
        return budgetedUntrustedResult(normalizeCheck(body));
      })
  );

  server.registerTool(
    'list_pings',
    {
      title: 'List pings',
      description:
        'Lists recent pings of a check, newest first. The instance caps this at ' +
        '100 pings on a free plan and 1000 on a paid one, and there is no ' +
        'pagination, so older pings cannot be reached at all. ' +
        NEEDS_READ_WRITE_KEY,
      inputSchema: z.object({
        check: uuidParam,
        type: pingTypeParam.optional().describe('Filtered client-side.'),
        limit: limitParam.optional().describe(`Default ${DEFAULT_LIMIT}.`),
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        truncated: truncationNote,
        // Left open: a ping record carries `ua`, the raw User-Agent of whoever
        // pinged, plus whatever fields the instance's release adds.
        pings: z.array(z.looseObject({})).describe('Newest first.'),
        returned_by_instance: z.number().int(),
        note: z.string().optional(),
      }),
    },
    async ({ check, type, limit }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const body = await needsReadWriteKey(api, 'list_pings', () =>
          api.get(`/checks/${id}/pings/`)
        );
        const all = listOf(body, 'pings') as Record<string, unknown>[];
        const matching = type ? all.filter((ping) => ping.type === type) : all;
        const shown = matching.slice(0, limit ?? DEFAULT_LIMIT);
        return budgetedUntrustedList('pings', shown, {
          extra: {
            returned_by_instance: all.length,
            ...(matching.length > shown.length
              ? {
                  note: `${matching.length} pings match; showing ${shown.length}.`,
                }
              : {}),
          },
          narrowWith: 'Lower limit, or filter by type.',
        });
      })
  );

  server.registerTool(
    'get_ping_body',
    {
      title: 'Get ping body',
      description:
        'Returns the body that was POSTed with one ping — usually the output of ' +
        'the job that reported in, which is the fastest way to see why a check ' +
        'failed. Truncated at 64 KB. ' +
        NEEDS_READ_WRITE_KEY,
      inputSchema: z.object({ check: uuidParam, n: pingNumberParam }),
      annotations: READ_ONLY,
      // The least trusted content this server returns: whoever knows a ping URL
      // writes this, and a ping URL sits in a cron job on every monitored host.
      outputSchema: z.object({
        ...untrustedFields,
        check: z.string(),
        ping: z.number().int(),
        body: z.string(),
        empty: z.literal(true).optional(),
        truncated: z
          .string()
          .optional()
          .describe('Present when the body hit the byte cap. Not retrievable.'),
      }),
    },
    async ({ check, n }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        let raw: RawResponse;
        try {
          raw = (await needsReadWriteKey(api, 'get_ping_body', () =>
            api.get(`/checks/${id}/pings/${n}/body`, {
              raw: true,
              maxBytes: MAX_PING_BODY_BYTES,
            })
          )) as RawResponse;
        } catch (error) {
          // 404 here is overloaded four ways and the bare status sends people
          // looking for the wrong one of them.
          if (error instanceof HealthchecksApiError && error.status === 404) {
            return errorResult(
              `No body available for ping ${n} of check ${id}. Any of these fits: ` +
                'the check does not exist, the ping number does not exist, the ping ' +
                'carried no body, or the ping is older than the instance keeps ' +
                '(100 pings on a free plan, 1000 on a paid one). list_pings shows ' +
                'which numbers are still available and which of them have a body_url.'
            );
          }
          throw error;
        }
        if (raw.body.length === 0) {
          return untrustedTextResult(
            `Ping ${n} of check ${id} has an empty body.`,
            { check: id, ping: n, body: '', empty: true }
          );
        }
        // Whatever pings the check writes this. It is the least trusted content
        // this server returns.
        const note = raw.truncated
          ? `[truncated at ${MAX_PING_BODY_BYTES} bytes. The rest is not ` +
            'retrievable — the API serves a ping body whole or not at all, so ' +
            'there is no follow-up call for the remainder.]'
          : undefined;
        return untrustedTextResult(
          note === undefined ? raw.body : `${raw.body}\n\n${note}`,
          {
            check: id,
            ping: n,
            body: raw.body,
            ...(note === undefined ? {} : { truncated: note }),
          }
        );
      })
  );

  server.registerTool(
    'list_flips',
    {
      title: 'List status flips',
      description:
        'Lists the up/down transitions of a check — the history behind its ' +
        'current status. The instance keeps the current month and the two before ' +
        'it. Accepts a UUID or a unique_key.',
      inputSchema: z.object({
        check: checkIdParam,
        seconds: secondsWindowParam.optional(),
        start: unixTimeParam.optional().describe('Only flips newer than this.'),
        end: unixTimeParam.optional().describe('Only flips older than this.'),
        limit: limitParam.optional().describe(`Default ${DEFAULT_LIMIT}.`),
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        truncated: truncationNote,
        flips: z.array(z.looseObject({})),
        returned_by_instance: z.number().int(),
        note: z.string().optional(),
      }),
    },
    async ({ check, seconds, start, end, limit }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        if (start !== undefined && end !== undefined && start > end) {
          return errorResult('start must not be later than end.');
        }
        const body = await api.get(
          `/checks/${id}/flips/${query({ seconds, start, end })}`
        );
        const all = flipsOf(body);
        const shown = all.slice(0, limit ?? DEFAULT_LIMIT);
        return budgetedUntrustedList('flips', shown, {
          extra: {
            returned_by_instance: all.length,
            ...(all.length > shown.length
              ? {
                  note: `${all.length} flips returned; showing ${shown.length}.`,
                }
              : {}),
          },
          narrowWith: 'Narrow the window with seconds, start or end.',
        });
      })
  );

  server.registerTool(
    'list_integrations',
    {
      title: 'List integrations',
      description:
        'Lists the notification integrations of the project, with the UUIDs that ' +
        'create_check and update_check accept in their channels argument. ' +
        'Integrations themselves can only be created in the web UI. ' +
        NEEDS_READ_WRITE_KEY,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        truncated: truncationNote,
        integrations: z
          .array(z.looseObject({}))
          .describe('Each carries the uuid create_check accepts in channels.'),
      }),
    },
    async () =>
      run(async () => {
        const body = await needsReadWriteKey(api, 'list_integrations', () =>
          api.get('/channels/')
        );
        const channels = listOf(body, 'channels');
        return budgetedUntrustedList('integrations', channels, {
          narrowWith:
            'The API offers no filter here; the project has that many integrations.',
        });
      })
  );

  server.registerTool(
    'list_badges',
    {
      title: 'List badges',
      description:
        'Lists the status badge URLs of the project, one entry per tag plus "*" ' +
        'for the project as a whole. The plain variants treat a check in its ' +
        'grace period as up; the ones suffixed 3 report up, late and down separately.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // Left open: the badge document is keyed by tag, and a tag is whatever
      // somebody typed.
      outputSchema: z.object({ ...untrustedFields, badges: z.unknown() }),
    },
    async () =>
      run(async () => {
        const body = await api.get('/badges/');
        const badges =
          body && typeof body === 'object' && 'badges' in body
            ? (body as { badges: unknown }).badges
            : body;
        return budgetedUntrustedResult({ badges });
      })
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get instance status',
      description:
        'Checks that the configured Healthchecks instance is reachable and its ' +
        'database is answering. Needs no API key, so it is the tool to try first ' +
        'when something is not working.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // The marker is *conditional* here, and that is the point. A plain "OK"
      // is this server's own sentence about its own configuration. Anything
      // else is up to 4 kB written by whatever answered — which, on this
      // unauthenticated endpoint, is exactly the case where it may not be
      // Healthchecks at all: an SSO portal, a captive proxy, a WAF block page.
      outputSchema: z.object({
        untrusted: z
          .literal(true)
          .optional()
          .describe('Present only when the instance answered something else.'),
        source: z.literal('healthchecks').optional(),
        instance: z.string(),
        ok: z.boolean().describe('True only when the answer was exactly "OK".'),
        answer: z.string().describe('Up to 4 kB of whatever replied.'),
      }),
    },
    async () =>
      run(async () => {
        // Unauthenticated on purpose: this has to work before the key does.
        // `raw` because this endpoint answers with the literal string "OK" and
        // no JSON content type — the one place a non-JSON body is correct.
        const raw = (await api.get('/status/', {
          anonymous: true,
          raw: true,
          maxBytes: 4096,
        })) as RawResponse;
        const text = raw.body.trim();
        if (text === 'OK') {
          // The server's own sentence about its own configuration, and
          // deliberately *not* marked: the marker has to mean something, and
          // putting it on this would make it noise.
          return {
            content: [
              {
                type: 'text',
                text: `${api.siteRoot} is reachable and its database is answering.`,
              },
            ],
            structuredContent: {
              instance: api.siteRoot,
              ok: true,
              answer: 'OK',
            },
          };
        }
        // Anything else is up to 4 KB written by whatever answered — which, on
        // this unauthenticated endpoint, is exactly the case where it may not be
        // Healthchecks at all: an SSO portal, a captive proxy, a WAF block page.
        // Echoing that into a sentence of the server's own was the one place a
        // stranger's text arrived unlabelled.
        return untrustedTextResult(
          `${api.siteRoot} answered the status endpoint with something other ` +
            `than "OK":\n\n${text}`,
          { instance: api.siteRoot, ok: false, answer: text }
        );
      })
  );

  server.registerTool(
    'get_api_key_info',
    {
      title: 'Get API key info',
      description:
        'Reports which instance is configured, whether the API key works, and ' +
        'whether it is a read-only or a read-write key — which decides whether ' +
        'list_pings, get_ping_body and list_integrations can be used at all, and ' +
        'whether checks are identified by uuid or by unique_key.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // No untrusted marker: every field is this server's own configuration or
      // a verdict it reached by probing.
      outputSchema: z.object({
        instance: z.string(),
        api_key: z
          .string()
          .optional()
          .describe('Only when none is configured.'),
        note: z.string().optional(),
        key_length_ok: z.boolean().optional(),
        prefixed_hcr: z.boolean().optional(),
        reachable: z.boolean().optional(),
        accepted: z.boolean().optional(),
        kind: z.string().optional(),
        error: z.string().optional(),
        checks_identified_by: z.string().optional(),
        unavailable_tools: z.array(z.string()).optional(),
      }),
    },
    async () =>
      run(async () => {
        const key = api.apiKey;
        if (key === undefined) {
          return jsonResult({
            instance: api.siteRoot,
            api_key: 'not configured',
            note: 'Set HEALTHCHECKS_API_KEY. Only get_status works without it.',
          });
        }

        // Two probes, both harmless GETs: the first says whether the key is
        // accepted at all, the second whether it reaches the read-write half.
        const listChecks = await probe(api, '/checks/');
        // Only worth asking once the instance answered at all — otherwise this
        // is a second timeout that says nothing the first did not.
        const listChannels = listChecks.reachable
          ? await probe(api, '/channels/')
          : { ok: false, reachable: false };
        const readWrite = listChannels.ok;

        if (!listChecks.reachable) {
          return jsonResult({
            instance: api.siteRoot,
            key_length_ok: key.length === API_KEY_LENGTH,
            reachable: false,
            kind: 'unknown — the instance could not be reached',
            error: listChecks.detail,
            note:
              'Nothing about the key can be determined until the instance answers. ' +
              'Check HEALTHCHECKS_URL and network access; get_status needs no key.',
          });
        }

        return jsonResult({
          instance: api.siteRoot,
          key_length_ok: key.length === API_KEY_LENGTH,
          prefixed_hcr: looksReadOnlyKey(key),
          reachable: true,
          accepted: listChecks.ok,
          kind: !listChecks.ok
            ? 'not accepted by this instance'
            : readWrite
              ? 'read-write'
              : 'read-only',
          checks_identified_by: readWrite ? 'uuid' : 'unique_key',
          unavailable_tools: readWrite
            ? []
            : [
                'list_pings',
                'get_ping_body',
                'list_integrations',
                'create_check',
                'update_check',
                'pause_check',
                'resume_check',
                'delete_check',
              ],
          ...(listChecks.ok ? {} : { error: listChecks.detail }),
        });
      })
  );
}

/**
 * Runs a GET purely to see whether it is allowed, never for its content.
 *
 * The catch is deliberately narrow. A blanket `return { ok: true }` would turn
 * an unreachable instance, an expired certificate or a timeout into
 * "accepted: true, kind: read-write" — a confident wrong answer from the one
 * tool whose entire job is diagnosing why nothing works.
 */
async function probe(
  api: HealthchecksApi,
  path: string
): Promise<{ ok: boolean; reachable: boolean; detail?: string }> {
  try {
    await api.get(path, { maxBytes: 64 * 1024 });
    return { ok: true, reachable: true };
  } catch (error) {
    if (error instanceof HealthchecksApiError) {
      // A status code is an answer: the instance is up, this key is not allowed.
      return { ok: false, reachable: true, detail: `HTTP ${error.status}` };
    }
    if (error instanceof ResponseTooLargeError) {
      // Too big to read still proves the request was accepted.
      return { ok: true, reachable: true };
    }
    return {
      ok: false,
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
