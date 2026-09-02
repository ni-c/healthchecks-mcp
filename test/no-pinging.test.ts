import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_TOOLS } from '../src/tools/catalogue.js';
import { CALLS } from './calls.js';
import {
  API,
  CHECK_UUID,
  call,
  connect,
  stubFetch,
  tokenOf,
} from './harness.js';

/**
 * The promise this server makes that would be worst to break: it cannot ping.
 *
 * A Healthchecks ping URL is a dead man's switch. Anything that pings one on a
 * model's behalf can tell a monitoring system that a backup succeeded when it
 * did not — and the failure is silent by construction, because the whole point
 * of the system is that silence means trouble. There is no undo and no alert;
 * the alert is what was suppressed.
 *
 * Five things hold that promise up, and all five are the kind of thing a
 * refactor can undo without anybody noticing:
 *
 *  1. there is exactly one `fetch` in this server, in `api.ts`;
 *  2. every request it builds is `${siteRoot}/api/v3${path}`;
 *  3. ping URLs live at `${siteRoot}/<ping-key>` — outside that prefix;
 *  4. `ping_url` is returned to the caller but never read by this server;
 *  5. pinging needs a separate key the server is never given.
 *
 * Nothing tested any of them. This is the cheap version: drive every tool in
 * the catalogue, watch every outgoing request, and require that all of them
 * start with the API prefix. It cannot prove the negative, but it turns "no
 * tool pings" from a property of the current code into a property the suite
 * defends.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nothing here can ping a check', () => {
  it('covers every tool in the catalogue', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('sends every request under /api/v3 and nowhere else', async () => {
    for (const [tool, spec] of Object.entries(CALLS)) {
      const stub = stubFetch(spec.routes as never);
      const client = await connect();
      if (tool === 'delete_check') {
        const first = await call(client, tool, spec.args ?? {});
        await call(client, tool, {
          ...spec.args,
          confirm_token: tokenOf(first),
        });
      } else {
        await call(client, tool, spec.args ?? {});
      }
      expect(stub.calls.length, `${tool} made no request`).toBeGreaterThan(0);
      for (const request of stub.calls) {
        // startsWith rather than a built regex: the prefix contains `.` and `/`
        // and an escaping mistake here would silently weaken the one assertion
        // this file exists to make.
        expect(
          request.url.startsWith(`${API}/`),
          `${tool} left the API prefix: ${request.url}`
        ).toBe(true);
      }
      vi.unstubAllGlobals();
    }
  });

  it('never requests a ping_url it was handed', async () => {
    // The upstream hands `ping_url` back on every check object, so the address
    // is in this process on nearly every call. It is passed through to the
    // caller and never dereferenced — a distinction only a spy can see.
    const pingUrl = `https://hc.example.net/${'p'.repeat(22)}`;
    const stub = stubFetch({
      [`GET /checks/${CHECK_UUID}`]: {
        json: {
          name: 'Nightly Backup',
          ping_url: pingUrl,
          status: 'up',
          slug: 'nightly-backup',
        },
      },
    });
    const client = await connect();
    await call(client, 'get_check', { check: CHECK_UUID });
    expect(stub.calls.map((request) => request.url)).not.toContain(pingUrl);
    expect(stub.calls).toHaveLength(1);
  });
});
