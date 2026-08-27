import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

export async function connect(
  overrides: Partial<Config> = {}
): Promise<Client> {
  const server = createServer(testConfig(overrides));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
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

export const CHECK_UUID = 'f618072a-7bde-4eee-af63-71a77c5723bc';
export const OTHER_UUID = '0c6c9f5e-1e3a-4a5f-9a3f-8b1c2d3e4f50';
export const UNIQUE_KEY = 'a'.repeat(40);

/** A check as a read-write key sees it. */
export function checkFixture(overrides: Partial<Check> = {}): Check {
  return {
    name: 'Nightly backup',
    slug: 'nightly-backup',
    tags: 'prod backup',
    desc: 'Runs at 02:00 on the backup host',
    grace: 3600,
    n_pings: 42,
    status: 'up',
    started: false,
    last_ping: '2026-08-27T02:00:00+00:00',
    next_ping: '2026-08-28T02:00:00+00:00',
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
    badge_url: `${SITE}/b/2/abc.svg`,
    uuid: CHECK_UUID,
    ping_url: `${SITE}/ping/${CHECK_UUID}`,
    update_url: `${API}/checks/${CHECK_UUID}`,
    pause_url: `${API}/checks/${CHECK_UUID}/pause`,
    resume_url: `${API}/checks/${CHECK_UUID}/resume`,
    channels: '4ec5a071-2d08-4baa-898a-eb4eb3cd6941',
    timeout: 86400,
    ...overrides,
  };
}
