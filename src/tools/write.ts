import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { assertPathSegment, type HealthchecksApi } from '../api.js';
import { checkIdOf, normalizeCheck, type Check } from '../check.js';
import {
  confirmationPrompt,
  setResourceKey,
  type ConfirmationStore,
} from '../confirm.js';
import { errorResult, jsonResult, run, textResult } from '../result.js';
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
  confirmations: ConfirmationStore
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
      inputSchema: {
        ...commonFields,
        channels: channelsParam
          .optional()
          .describe(
            'Integrations to notify: "*" for all of them (the default here), or a ' +
              'list of UUIDs or exact names from list_integrations.'
          ),
        unique: uniqueParam.optional(),
      },
      annotations: { idempotentHint: false },
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
        return jsonResult({
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
      inputSchema: {
        check: uuidParam,
        ...commonFields,
        channels: channelsParam.optional(),
      },
      annotations: { idempotentHint: true },
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
        return jsonResult({
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
      inputSchema: {
        check: uuidParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ check, confirm_token }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const resource = setResourceKey('pause_check', [id]);

        if (!confirmations.consume(resource, confirm_token)) {
          if (confirm_token !== undefined) {
            return errorResult(
              'The confirmation token is invalid, expired or was issued for a ' +
                'different check. Call pause_check without a token to get a new one.'
            );
          }
          const token = confirmations.issue(resource);
          // Only server-side metadata in this text — never the check's name or
          // description, which are free text this server does not control.
          return textResult(
            confirmationPrompt(
              `pause check ${id}`,
              'While paused it raises no alerts, so a job that stops running goes ' +
                'unnoticed. resume_check reverses it.',
              'pause_check',
              token,
              confirmations.ttlMinutes
            )
          );
        }

        const paused = (await api.post(`/checks/${id}/pause`)) as Check;
        return jsonResult({
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
      inputSchema: { check: uuidParam },
      annotations: { idempotentHint: true },
    },
    async ({ check }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const resumed = (await api.post(`/checks/${id}/resume`)) as Check;
        return jsonResult({ check: normalizeCheck(resumed) });
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
      inputSchema: {
        check: uuidParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ check, confirm_token }) =>
      run(async () => {
        const id = assertPathSegment(check, 'check id');
        const resource = setResourceKey('delete_check', [id]);

        if (!confirmations.consume(resource, confirm_token)) {
          if (confirm_token !== undefined) {
            return errorResult(
              'The confirmation token is invalid, expired or was issued for a ' +
                'different check. Call delete_check without a token to get a new one.'
            );
          }
          const token = confirmations.issue(resource);
          return textResult(
            confirmationPrompt(
              `permanently delete check ${id}`,
              'The UUID cannot be recovered, and anything still pinging that URL ' +
                'will fail. Consider pause_check instead.',
              'delete_check',
              token,
              confirmations.ttlMinutes
            )
          );
        }

        // The API returns the deleted object — the last chance to keep a record
        // of what it was.
        const deleted = (await api.delete(`/checks/${id}`)) as Check;
        return jsonResult({
          deleted: normalizeCheck(deleted),
          note: `Check ${checkIdOf(deleted) ?? id} is gone. This cannot be undone.`,
        });
      })
  );
}
