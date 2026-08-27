/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `HEALTHCHECKS_ALLOW_TOOLS=delete_check` report
 * "unknown tool" under `HEALTHCHECKS_READ_ONLY=true`, which is the one answer
 * that is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set, so the duplication
 * cannot drift — and the test file keeps no second copy of the names.
 */

/**
 * Registered always. Every one carries `readOnlyHint: true`.
 *
 * "Read" here means "does not change anything", not "works with a read-only API
 * key" — Healthchecks requires a read-write key for `list_pings`,
 * `get_ping_body` and `list_integrations` even though all three are GETs.
 * `get_api_key_info` reports which of the two kinds is configured.
 */
export const READ_TOOLS = [
  'list_checks',
  'get_check',
  'list_pings',
  'get_ping_body',
  'list_flips',
  'list_integrations',
  'list_badges',
  'get_status',
  'get_api_key_info',
] as const;

/** Registered unless `HEALTHCHECKS_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'create_check',
  'update_check',
  'pause_check',
  'resume_check',
  'delete_check',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `HEALTHCHECKS_ALLOW_TOOLS=essential` selects.
 *
 * The set that covers what people come to a monitoring API for — see what is
 * running, see why something went down, add and adjust a check — and nothing
 * else. Left out on purpose: `delete_check`, because losing a UUID breaks every
 * deployed script that pings it; `pause_check`, because a paused check stops
 * alerting and a silently failing job then goes unnoticed; `get_ping_body`,
 * because it returns an arbitrarily large log; and the three
 * inspect-your-setup tools, which answer questions nobody asks twice.
 *
 * `test/tool-filter.test.ts` checks every name here exists and that the list is
 * within 5..8.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_checks',
  'get_check',
  'list_pings',
  'list_flips',
  'create_check',
  'update_check',
  'resume_check',
];
