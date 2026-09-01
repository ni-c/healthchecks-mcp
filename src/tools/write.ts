import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { setResourceKey } from 'mcp-approval';
import {
  channelsParam,
  confirmTokenParam,
  descParam,
  graceParam,
  keywordsParam,
  methodsParam,
  nameParam,
  scheduleParam,
  slugParam,
  tagsParam,
  timeoutParam,
  tzParam,
  uniqueParam,
  uuidParam,
} from '../schema.js';

import { assertPathSegment, type HealthchecksApi } from '../api.js';
import { checkIdOf, normalizeCheck, type Check } from '../check.js';
import { budgetedJsonResult, errorResult, run } from '../result.js';

/**
 * Notification integrations a check gets when the caller names none.
 *
 * The API's own default is "none", which produces a check that looks healthy,
 * reports correctly, and never tells anyone when it stops — indistinguishable
 * from a working one until the day it matters. "*" is the safe direction to be
 * wrong in, and the result says which one was applied.
 */
const DEFAULT_CHANNELS = '*';

/** The fields create and update share, so the two schemas cannot drift apart. */
const commonFields = {
  name: nameParam.optional(),
  slug: slugParam
    .optional()
    .describe('Explicit slug. Requires an instance with API v3.'),
  tags: tagsParam.optional(),
  desc: descParam.optional(),
  timeout: timeoutParam.optional(),
  schedule: scheduleParam.optional(),
  tz: tzParam.optional(),
  grace: graceParam.optional(),
  manual_resume: z
    .boolean()
    .optional()
    .describe(
      'When true, a paused check ignores pings until resume_check is called.'
    ),
  methods: methodsParam.optional(),
  start_kw: keywordsParam
    .optional()
    .describe('Keywords that mark a ping as "start".'),
  success_kw: keywordsParam
    .optional()
    .describe('Keywords that mark a ping as success.'),
  failure_kw: keywordsParam
    .optional()
    .describe('Keywords that mark a ping as failure.'),
  filter_subject: z
    .boolean()
    .optional()
    .describe('Apply the keywords to email subjects.'),
  filter_body: z
    .boolean()
    .optional()
    .describe('Apply the keywords to email bodies.'),
  filter_http_body: z
    .boolean()
    .optional()
    .describe('Apply the keywords to HTTP ping bodies.'),
  filter_default_fail: z
    .boolean()
    .optional()
    .describe(
      'Treat a ping matching no keyword as a failure instead of a success.'
    ),
};

// Every property spells out `| undefined`: the SDK hands a handler an object
// with all optional keys present and set to undefined, which
// `exactOptionalPropertyTypes` treats as different from an absent key.
type CommonInput = {
  name?: string | undefined;
  slug?: string | undefined;
  tags?: string[] | undefined;
  desc?: string | undefined;
  timeout?: number | undefined;
  schedule?: string | undefined;
  tz?: string | undefined;
  grace?: number | undefined;
  manual_resume?: boolean | undefined;
  methods?: '' | 'POST' | undefined;
  start_kw?: string[] | undefined;
  success_kw?: string[] | undefined;
  failure_kw?: string[] | undefined;
  filter_subject?: boolean | undefined;
  filter_body?: boolean | undefined;
  filter_http_body?: boolean | undefined;
  filter_default_fail?: boolean | undefined;
};

/**
 * Turns the tool arguments into the request body.
 *
 * The two separators are the whole reason this is a function: `tags` is stored
 * space-delimited and `channels` and the keyword lists comma-delimited, and
 * getting them the wrong way round produces a check that is accepted, saved,
 * and wrong.
 */
function buildBody(
  input: CommonInput,
  channels?: string | string[]
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const copy = <K extends keyof CommonInput>(key: K): void => {
    if (input[key] !== undefined) body[key] = input[key];
  };
  for (const key of [
    'name',
    'slug',
    'desc',
    'timeout',
    'schedule',
    'tz',
    'grace',
    'manual_resume',
    'methods',
    'filter_subject',
    'filter_body',
    'filter_http_body',
    'filter_default_fail',
  ] as const) {
    copy(key);
  }
  if (input.tags !== undefined) body.tags = input.tags.join(' ');
  for (const key of ['start_kw', 'success_kw', 'failure_kw'] as const) {
    if (input[key] !== undefined) body[key] = input[key].join(',');
  }
  if (channels !== undefined) {
    body.channels = Array.isArray(channels) ? channels.join(',') : channels;
  }
  return body;
}

/** `schedule` silently discards `timeout`, so the pair is refused rather than resolved. */
function scheduleConflict(input: CommonInput): string | undefined {
  if (input.timeout !== undefined && input.schedule !== undefined) {
    return (
      'timeout and schedule cannot be combined: Healthchecks lets schedule win and ' +
      'discards timeout without saying so. Pass one of them.'
    );
  }
  return undefined;
}

export function registerWriteTools(
  server: McpServer,
  api: HealthchecksApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_check',
    {
      title: 'Create check',
      description:
        'Creates a check. Pass either timeout (a simple period) or schedule (a ' +
        'cron or systemd OnCalendar expression), never both. Unless channels ' +
        `says otherwise, the new check notifies every integration in the project ` +
        '("*"), because a check with no integrations never alerts anyone. ' +
        'Setting unique turns this into an upsert that may UPDATE an existing check.',
      inputSchema: z.object({
        ...commonFields,
        channels: channelsParam
          .optional()
          .describe(
            'Integrations to notify: "*" for all of them (the default here), or a ' +
              'list of UUIDs or exact names from list_integrations.'
          ),
        unique: uniqueParam.optional(),
      }),
      annotations: {
        // Additive: it brings a check into existence and takes nothing away.
        // Not idempotent — calling it twice gives you two checks with two UUIDs.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ channels, unique, ...input }) =>
      run(async () => {
        const conflict = scheduleConflict(input);
        if (conflict) return errorResult(conflict);
        if (input.tz !== undefined && input.schedule === undefined) {
          return errorResult(
            'tz only has an effect together with schedule. Pass a schedule, or drop tz.'
          );
        }

        const appliedChannels = channels ?? DEFAULT_CHANNELS;
        const body = buildBody(input, appliedChannels);
        if (unique !== undefined) body.unique = unique;

        const created = (await api.post('/checks/', body)) as Check;
        return budgetedJsonResult({
          check: normalizeCheck(created),
          channels_applied:
            channels === undefined
              ? 'all integrations in the project ("*"), the default of this tool'
              : 'as requested',
          ...(unique !== undefined
            ? {
                note:
                  'unique was set, so this call may have updated an existing check ' +
                  'rather than creating a new one. Compare n_pings and last_ping.',
              }
            : {}),
        });
      })
  );

  server.registerTool(
    'update_check',
    {
      title: 'Update check',
      description:
        'Updates a check. Fields that are not given stay unchanged. Two ' +
        'exceptions: channels REPLACES the integration list rather than adding ' +
        'to it, and setting schedule on a check that used timeout switches it ' +
        'over. Needs a UUID, which read-only API keys never see.',
      inputSchema: z.object({
        check: uuidParam,
        ...commonFields,
        channels: channelsParam.optional(),
      }),
      annotations: {
        // Destructive in the sense that matters: the fields it is given replace
        // what was there, and Healthchecks keeps no history of the old values.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ check, channels, ...input }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const conflict = scheduleConflict(input);
        if (conflict) return errorResult(conflict);

        const body = buildBody(input, channels);
        if (Object.keys(body).length === 0) {
          return errorResult(
            'Nothing to update: pass at least one field to change.'
          );
        }

        const updated = (await api.post(`/checks/${id}`, body)) as Check;
        return budgetedJsonResult({
          check: normalizeCheck(updated),
          ...(channels !== undefined
            ? {
                note: 'The integration list was replaced with exactly what was passed.',
              }
            : {}),
        });
      })
  );

  server.registerTool(
    'pause_check',
    {
      title: 'Pause check',
      description:
        'Pauses a check: it stops expecting pings and stops alerting. Two-step — ' +
        'the first call returns a confirmation token, the second call with that ' +
        'token performs the pause.',
      inputSchema: z.object({
        check: uuidParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      // Not idempotent, despite pausing an already-paused check being a no-op
      // upstream: the confirmation token is single-use, so repeating the exact
      // same call is an error rather than a repeat of the same effect.
      annotations: {
        // Not destructive — resume_check puts it back, and nothing is lost in
        // between. Idempotent: pausing an already paused check leaves it paused.
        // It said false before, while wg-easy said true for the same shape of
        // operation; this is the answer both now give.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ check, confirm_token }, mcp) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `pause check ${id}`,
            consequence:
              'While paused it raises no alerts, so a job that stops running goes ' +
              'unnoticed. resume_check reverses it.',
            resourceKey: setResourceKey('pause_check', [id]),
            token: confirm_token,
            toolName: 'pause_check',
            title: `Pause check ${id}?`,
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(`The user declined. pause_check did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;

        const paused = (await api.post(`/checks/${id}/pause`)) as Check;
        return budgetedJsonResult({
          check: normalizeCheck(paused),
          note: 'Alerting is off for this check until resume_check is called.',
        });
      })
  );

  server.registerTool(
    'resume_check',
    {
      title: 'Resume check',
      description:
        'Resumes a paused check and puts it back into the "new" state, waiting ' +
        'for its next ping. Fails with HTTP 409 if the check is not paused.',
      inputSchema: z.object({ check: uuidParam }),
      // The second call answers 409 rather than repeating the first, so this is
      // not a no-op to retry blindly.
      annotations: {
        // The reverse of pause_check, and it restores service rather than
        // removing it.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ check }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const resumed = (await api.post(`/checks/${id}/resume`)) as Check;
        return budgetedJsonResult({ check: normalizeCheck(resumed) });
      })
  );

  server.registerTool(
    'delete_check',
    {
      title: 'Delete check',
      description:
        'Deletes a check permanently. Its UUID is not recoverable, so every ' +
        'deployed script pinging that URL breaks. Two-step: the first call ' +
        'returns a confirmation token, the second call with that token deletes.',
      inputSchema: z.object({
        check: uuidParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Idempotent by the specification's wording — "no additional effect on
        // its environment". The second call answers 404, but the world is the
        // same either way, which is what lets a client retry after a timeout.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ check, confirm_token }, mcp) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `permanently delete check ${id}`,
            consequence:
              'The UUID cannot be recovered, and anything still pinging that URL ' +
              'will fail. Consider pause_check instead.',
            resourceKey: setResourceKey('delete_check', [id]),
            token: confirm_token,
            toolName: 'delete_check',
            title: `Permanently delete check ${id}?`,
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(`The user declined. delete_check did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;

        // The API returns the deleted object — the last chance to keep a record
        // of what it was.
        const deleted = (await api.delete(`/checks/${id}`)) as Check;
        return budgetedJsonResult({
          deleted: normalizeCheck(deleted),
          note: `Check ${checkIdOf(deleted) ?? id} is gone. This cannot be undone.`,
        });
      })
  );
}
