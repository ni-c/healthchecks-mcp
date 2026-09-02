import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import type { Check } from '../src/check.js';

export const SITE = 'https://hc.example.net';
export const API = `${SITE}/api/v3`;

/** A read-write key of the length the upstream insists on. */
export const RW_KEY = 'k'.repeat(32);
/** A read-only key: the `hcr_` prefix counts towards the 32 characters. */
export const RO_KEY = `hcr_${'r'.repeat(28)}`;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: SITE,
    usingDefaultUrl: false,
    apiKey: RW_KEY,
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = Reply | ((request: Recorded) => Reply);
/** Routes are keyed `"<METHOD> <path>"`, where the path excludes `/api/v3`. */
export type Routes = Record<string, Handler>;

export interface FetchStub {
  calls: Recorded[];
}

/**
 * Replaces global fetch with a router over canned replies.
 *
 * A request with no matching route fails the test loudly rather than returning
 * an empty object: a tool that silently queries the wrong path would otherwise
 * pass every assertion about its output.
 */
export function stubFetch(routes: Routes = {}): FetchStub {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.startsWith(API) ? url.slice(API.length) : url;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }
      const recorded: Recorded = {
        method,
        url,
        path,
        headers,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(recorded);

      const key = `${method} ${path.split('?')[0]}`;
      const exact = routes[`${method} ${path}`] ?? routes[key];
      if (exact === undefined) {
        throw new Error(`no stubbed route for ${method} ${path}`);
      }
      const reply = typeof exact === 'function' ? exact(recorded) : exact;
      const body =
        reply.text !== undefined
          ? reply.text
          : JSON.stringify(reply.json ?? {});
      return new Response(reply.status === 204 ? null : body, {
        status: reply.status ?? 200,
        headers: {
          'content-type':
            reply.contentType ??
            (reply.text !== undefined ? 'text/plain' : 'application/json'),
          ...reply.headers,
        },
      });
    })
  );
  return { calls };
}

/** How a client that can show a dialog answers it. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * Connects a client to the real server.
 *
 * Without `elicit` the client declares no elicitation capability, which is
 * the case the two-call token exists for and what every other test drives.
 * With it, the client answers the dialog and `prompts` records what the
 * server put in front of the user.
 */
export async function connect(
  overrides: Partial<Config> = {},
  elicit?: ElicitBehaviour
): Promise<Client & { prompts: string[] }> {
  const server = createServer(testConfig(overrides));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return Object.assign(client, { prompts });
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The text of a tool result, joined across content blocks. */
export function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

/** The first JSON object embedded in a tool result. */
export function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]{32})"/.exec(textOf(result));
  if (!match?.[1])
    throw new Error(`no confirmation token in: ${textOf(result)}`);
  return match[1];
}

export const CHECK_UUID = '403c0ad2-72ac-4f0a-8802-69ee5c9e29fd';
export const OTHER_UUID = '5cd1712e-33b2-48dc-a36e-f2ebf2d3b5dc';
export const UNIQUE_KEY = '4616b2faa4483b13263e4adda4133688010b2794';
const BADGE_KEY = '404d9fc2-287f-4136-b4c1-152e8d98a815';

/*
 * The fixtures below were captured from a real Healthchecks v4.3 instance on
 * 2026-08-27 and then only reduced, never rewritten. That matters: the previous
 * versions were written from my reading of the upstream source, so the tests
 * could only prove the server was consistent with my understanding — not that
 * the understanding was right. Two things these captures pinned down that a
 * hand-written fixture had wrong or vague:
 *
 *   - a simple check carries `timeout` and no `schedule`; a cron check carries
 *     `schedule` + `tz` and no `timeout`. There is no `kind` field either way.
 *   - a read-only key gets a different object: no `uuid`, `ping_url`,
 *     `update_url`, `pause_url`, `resume_url` or `channels`, and a 40-character
 *     `unique_key` instead. `readOnlyCheckFixture` is that exact set.
 *
 * Only the host was rewritten to `hc.example.net` and the pings' `remote_addr`
 * to the documentation range — the capture ran against a container whose
 * bridge address is a private IP, which has no business in a public repository.
 */

/** A check as a read-write key sees it — a simple, timeout-driven one. */
export function checkFixture(overrides: Partial<Check> = {}): Check {
  return {
    name: 'Nightly Backup',
    slug: 'nightly-backup',
    tags: 'prod backup db',
    desc: 'Runs pg_dump and uploads it.',
    grace: 3600,
    n_pings: 7,
    status: 'up',
    started: false,
    last_ping: '2026-08-27T09:39:21+00:00',
    next_ping: '2026-08-28T09:39:21+00:00',
    manual_resume: false,
    methods: '',
    subject: '',
    subject_fail: '',
    start_kw: '',
    success_kw: '',
    failure_kw: '',
    filter_subject: false,
    filter_body: false,
    filter_http_body: false,
    filter_default_fail: false,
    badge_url: `${SITE}/b/2/${BADGE_KEY}.svg`,
    uuid: CHECK_UUID,
    ping_url: `${SITE}/ping/${CHECK_UUID}`,
    update_url: `${API}/checks/${CHECK_UUID}`,
    pause_url: `${API}/checks/${CHECK_UUID}/pause`,
    resume_url: `${API}/checks/${CHECK_UUID}/resume`,
    channels:
      '1d5c30df-8e07-479c-9c9c-649b5b319893,79c2cff2-349c-44fa-9077-0353ab9aa692',
    timeout: 86400,
    ...overrides,
  };
}

/**
 * A cron check. Note what is *absent*: `timeout`. The upstream emits one or the
 * other, never both, which is the only way to tell the two kinds apart.
 */
export function cronCheckFixture(overrides: Partial<Check> = {}): Check {
  const check = checkFixture({
    name: 'Hourly Report',
    slug: 'hourly-report',
    tags: 'prod reports',
    desc: 'Hourly aggregation.',
    grace: 900,
    n_pings: 1,
    status: 'new',
    last_ping: null,
    next_ping: null,
    uuid: OTHER_UUID,
    schedule: '0 * * * *',
    tz: 'Europe/Luxembourg',
    ...overrides,
  });
  delete check.timeout;
  return check;
}

/**
 * The same check as a read-only key sees it.
 *
 * The six fields the upstream withholds are deleted rather than set to
 * undefined, because `unique_key`-vs-`uuid` is decided by presence.
 */
export function readOnlyCheckFixture(overrides: Partial<Check> = {}): Check {
  const check = checkFixture(overrides);
  for (const field of [
    'uuid',
    'ping_url',
    'update_url',
    'pause_url',
    'resume_url',
    'channels',
  ]) {
    delete check[field];
  }
  check.unique_key = UNIQUE_KEY;
  return check;
}

/**
 * Real pings, newest first, as `GET /checks/<uuid>/pings/` returns them.
 *
 * `n: 6` is the one that carried no body — the upstream answers its `body`
 * endpoint with 404 rather than an empty 200, and it has no `body_url` here.
 * `last_duration` only appears on a check whose latest success followed a
 * `/start`, which is why `checkFixture` does not carry it.
 */
export function pingsFixture(): Record<string, unknown>[] {
  const bodyUrl = (n: number) => `${API}/checks/${CHECK_UUID}/pings/${n}/body`;
  const base = {
    scheme: 'http',
    remote_addr: '203.0.113.10',
    method: 'POST',
    ua: 'curl/8.21.0',
    rid: null,
  };
  return [
    {
      type: 'success',
      date: '2026-08-27T09:39:21.987390+00:00',
      n: 7,
      ...base,
      body_url: bodyUrl(7),
    },
    {
      type: 'success',
      date: '2026-08-27T09:39:21.966405+00:00',
      n: 6,
      ...base,
      body_url: null,
    },
    {
      type: 'success',
      date: '2026-08-27T09:39:21.955001+00:00',
      n: 5,
      ...base,
      body_url: bodyUrl(5),
    },
    {
      type: 'fail',
      date: '2026-08-27T09:39:21.944072+00:00',
      n: 4,
      ...base,
      body_url: bodyUrl(4),
    },
    {
      type: 'log',
      date: '2026-08-27T09:39:21.933145+00:00',
      n: 3,
      ...base,
      body_url: bodyUrl(3),
    },
    {
      type: 'success',
      date: '2026-08-27T09:39:21.921730+00:00',
      n: 2,
      ...base,
      body_url: bodyUrl(2),
    },
    {
      type: 'start',
      date: '2026-08-27T09:39:20.901544+00:00',
      n: 1,
      ...base,
      body_url: bodyUrl(1),
    },
  ];
}

/** What one `/fail` ping actually printed — the payload `get_ping_body` returns. */
export const PING_BODY = 'pg_dump: connection refused\nexit 1';

/**
 * Flips, as v4.3 returns them: wrapped in an envelope, and carrying only a
 * timestamp and an up flag. The published documentation shows a bare array —
 * `flipsOf` accepts both, and this is the shape that is actually served.
 */
export function flipsFixture(): Record<string, unknown>[] {
  return [
    { timestamp: '2026-08-27T09:39:21+00:00', up: 1 },
    { timestamp: '2026-08-27T09:39:21+00:00', up: 0 },
    { timestamp: '2026-08-27T09:39:21+00:00', up: 1 },
  ];
}

/** Integrations. `value` never leaves the server, so `to_dict` is these three keys. */
export function channelsFixture(): Record<string, unknown>[] {
  return [
    {
      id: '79c2cff2-349c-44fa-9077-0353ab9aa692',
      name: 'Ops Email',
      kind: 'email',
    },
    {
      id: '1d5c30df-8e07-479c-9c9c-649b5b319893',
      name: 'Ops Webhook',
      kind: 'webhook',
    },
  ];
}

/** Badges: one entry per tag plus `*`, six URL variants each. */
export function badgesFixture(): Record<string, unknown> {
  const key = 'c8d74d53-a3e4-4e57-a7bc-0528dd5c7f52';
  const set = (sig: string, tag: string) => ({
    svg: `${SITE}/badge/${key}/${sig}-2/${tag}.svg`,
    svg3: `${SITE}/badge/${key}/${sig}/${tag}.svg`,
    json: `${SITE}/badge/${key}/${sig}-2/${tag}.json`,
    json3: `${SITE}/badge/${key}/${sig}/${tag}.json`,
    shields: `${SITE}/badge/${key}/${sig}-2/${tag}.shields`,
    shields3: `${SITE}/badge/${key}/${sig}/${tag}.shields`,
  });
  return { prod: set('TsOsNDAQ', 'prod'), '*': set('LJqm-Wio', '%2A') };
}
