import {
  CHECK_UUID,
  badgesFixture,
  channelsFixture,
  checkFixture,
  flipsFixture,
  pingsFixture,
} from './harness.js';

/**
 * One stubbed call for every tool in the catalogue.
 *
 * Shared by the suites that want to drive the *whole* surface and assert one
 * property across it — who wrote the text that comes back, and where the
 * requests go. Both of those are claims about the catalogue rather than about
 * any one tool, and neither is checkable from a per-tool test.
 */
export interface ToolCall {
  routes: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** Why this one is the server's own voice rather than somebody else's. */
  ownWords?: string;
}

export const CALLS: Record<string, ToolCall> = {
  list_checks: {
    routes: { 'GET /checks/': { json: { checks: [checkFixture()] } } },
  },
  get_check: {
    routes: { [`GET /checks/${CHECK_UUID}`]: { json: checkFixture() } },
    args: { check: CHECK_UUID },
  },
  list_pings: {
    routes: {
      [`GET /checks/${CHECK_UUID}/pings/`]: { json: { pings: pingsFixture() } },
    },
    args: { check: CHECK_UUID },
  },
  get_ping_body: {
    routes: {
      [`GET /checks/${CHECK_UUID}/pings/4/body`]: {
        text: 'pg_dump: connection refused',
        contentType: 'text/plain',
      },
    },
    args: { check: CHECK_UUID, n: 4 },
  },
  list_flips: {
    routes: {
      [`GET /checks/${CHECK_UUID}/flips/`]: { json: { flips: flipsFixture() } },
    },
    args: { check: CHECK_UUID },
  },
  list_integrations: {
    routes: { 'GET /channels/': { json: { channels: channelsFixture() } } },
  },
  list_badges: {
    routes: { 'GET /badges/': { json: { badges: badgesFixture() } } },
  },
  get_status: {
    routes: { 'GET /status/': { text: 'OK', contentType: 'text/plain' } },
    ownWords:
      "it reports on the configured instance, in the server's own words. The " +
      'branch that echoes an unexpected answer is covered separately below.',
  },
  get_api_key_info: {
    routes: {
      'GET /checks/': { json: { checks: [] } },
      'GET /channels/': { json: { channels: [] } },
    },
    ownWords:
      'nothing in it comes from the instance except HTTP status codes — it is ' +
      'the server describing its own configuration.',
  },
  create_check: {
    routes: { 'POST /checks/': { json: checkFixture() } },
    args: { name: 'Nightly Backup', timeout: 86_400 },
  },
  update_check: {
    routes: { [`POST /checks/${CHECK_UUID}`]: { json: checkFixture() } },
    args: { check: CHECK_UUID, name: 'Renamed' },
  },
  pause_check: {
    routes: { [`POST /checks/${CHECK_UUID}/pause`]: { json: checkFixture() } },
    args: { check: CHECK_UUID },
  },
  resume_check: {
    routes: { [`POST /checks/${CHECK_UUID}/resume`]: { json: checkFixture() } },
    args: { check: CHECK_UUID },
  },
  delete_check: {
    routes: { [`DELETE /checks/${CHECK_UUID}`]: { json: checkFixture() } },
    args: { check: CHECK_UUID },
  },
};
