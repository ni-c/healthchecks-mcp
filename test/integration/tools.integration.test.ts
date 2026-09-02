import {
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, ping, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real Healthchecks in Docker.
 *
 * Two things here can only be established against the real API, and both are
 * claims this server makes in its own README:
 *
 *  - **A read-only key is refused by three tools that only read.** Healthchecks
 *    gates `list_pings`, `get_ping_body` and `list_integrations` behind a
 *    read-write key anyway, and answers `401 {"error": "wrong api key"}` —
 *    which reads as if the key were wrong rather than insufficient. The suite
 *    drives a second server holding a read-only key to prove both the refusal
 *    and the translation.
 *  - **This server deliberately cannot ping.** A monitoring client that can
 *    report success is a monitoring client that can lie, so the suite pings
 *    over plain HTTP itself to give the ping tools something to read.
 */

let sandbox: Sandbox;
/** Read-write key, declares elicitation. */
let asking: LiveHarness;
/** Read-write key, no dialog — takes the two-call token. */
let plain: LiveHarness;
/** Read-only key. Three read tools must fail on it. */
let readOnly: LiveHarness;

let uuid: string;

function parse<T>(text: string): T {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
  readOnly = await startServer({ env: sandbox.readOnlyEnv });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
  await readOnly?.close();
});

describe('the instance and the key', () => {
  it('reports the public status without any key at all', async () => {
    // Prose, not JSON: this is the tool a model calls when nothing else
    // works, so the answer is a sentence rather than something to parse.
    expect(await asking.call('get_status')).toContain('is reachable');
  });

  it('says which kind of key is configured, before anything fails', async () => {
    const rw = parse<{ kind: string }>(await asking.call('get_api_key_info'));
    expect(rw.kind).toBe('read-write');

    const ro = parse<{ kind: string }>(await readOnly.call('get_api_key_info'));
    expect(ro.kind).toBe('read-only');
  });
});

describe('a check through its whole life', () => {
  it('creates one', async () => {
    // Wrapped in `{ check: … }` rather than returned bare, like every other
    // single-object result from this server.
    const created = parse<{ check: { uuid: string; name: string } }>(
      await asking.call('create_check', {
        name: 'Integration check',
        desc: 'Created by the integration suite.',
        timeout: 3600,
        grace: 600,
        tags: ['integration'],
      })
    );
    uuid = created.check.uuid;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    expect(await asking.call('list_checks')).toContain('Integration check');
    expect(await asking.call('get_check', { check: uuid })).toContain(
      'Integration check'
    );
  });

  it('sees a ping this server did not send', async () => {
    // The server has no ping tool by design. The suite pings over plain HTTP,
    // which is what a monitored job does, and the read tools then have real
    // events to report rather than fixtures.
    await ping(sandbox.url, uuid, { body: 'first run, all good\n' });
    await ping(sandbox.url, uuid, {
      suffix: 'fail',
      body: 'pg_dump: connection refused\nexit 1',
    });

    const pings = parse<{ pings: { type?: string; n: number }[] }>(
      await asking.call('list_pings', { check: uuid })
    );
    expect(pings.pings.length).toBeGreaterThanOrEqual(2);

    const failure = pings.pings.find((p) => p.type === 'fail');
    expect(failure).toBeDefined();
    const body = await asking.call('get_ping_body', {
      check: uuid,
      n: failure!.n,
    });
    expect(body).toContain('connection refused');
  });

  it('records the flip from up to down', async () => {
    // A flip only exists because a real ping changed the state. Nothing about
    // this is reachable from a stub.
    const flips = parse<{ flips: { up: number }[] }>(
      await asking.call('list_flips', { check: uuid })
    );
    expect(flips.flips.length).toBeGreaterThan(0);
  });

  it('updates, pauses and resumes it', async () => {
    await asking.call('update_check', {
      check: uuid,
      desc: 'Edited by the integration suite.',
    });
    expect(await asking.call('get_check', { check: uuid })).toContain(
      'Edited by the integration suite'
    );

    const paused = await asking.call('pause_check', { check: uuid });
    expect(paused).toContain('paused');
    // Resume puts it back to "new" rather than to its previous state, because
    // there has been no ping since the pause.
    const resumed = await asking.call('resume_check', { check: uuid });
    expect(resumed).toContain('"status"');
  });

  it('lists its badges and the project’s integrations', async () => {
    expect(await asking.call('list_badges')).toContain('integration');
    // No channels are configured, so this is the empty case — which is the
    // one a stub with a fixture never tests.
    const integrations = parse<{ integrations: unknown[] }>(
      await asking.call('list_integrations')
    );
    expect(integrations.integrations).toHaveLength(0);
  });
});

describe('what a read-only key cannot do', () => {
  it('reads the checks perfectly well, addressed differently', async () => {
    // Healthchecks hands a read-only key a different object: no `uuid`, no
    // `ping_url`, a 40-character `unique_key` instead. This server normalises
    // both to a single `id`, so a caller does not have to know which kind of
    // key it was given — which is the whole point, and is only checkable
    // against an instance that really issues both.
    const listed = parse<{ checks: { id: string; ping_url?: string }[] }>(
      await readOnly.call('list_checks')
    );
    expect(listed.checks.length).toBeGreaterThan(0);
    expect(listed.checks[0]!.id).toMatch(/^[0-9a-f]{40}$/);
    expect(listed.checks[0]!.ping_url).toBeUndefined();

    // The same check, through the read-write key, is addressed by uuid.
    const full = parse<{ checks: { id: string }[] }>(
      await asking.call('list_checks')
    );
    expect(full.checks[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cannot even name a check the way the ping tools want', async () => {
    // Worth stating plainly: a read-only key never sees a uuid, and
    // `list_pings` addresses checks by uuid. So the tool is unreachable with
    // such a key for a reason that has nothing to do with the 401 below — the
    // argument cannot be produced. The refusal is a schema one, and it says
    // what shape it wanted rather than pretending the key was wrong.
    const listed = parse<{ checks: { id: string }[] }>(
      await readOnly.call('list_checks')
    );
    const refused = await readOnly.call(
      'list_pings',
      { check: listed.checks[0]!.id },
      { expectError: true }
    );
    expect(refused).toContain('must be a check UUID');
  });

  it.each(['list_pings', 'get_ping_body', 'list_integrations'])(
    'is refused by %s, which only reads',
    async (tool) => {
      // Healthchecks answers 401 {"error": "wrong api key"} — which reads as
      // if the key were wrong or missing. It is neither, and these three tools
      // say so instead of passing the confusion on.
      //
      // The uuid comes from the read-write harness on purpose: a read-only key
      // cannot produce one, so this is the only way to get past the schema and
      // reach the 401 the message is about.
      //
      // The expectation names the sentence, not the word "read-only". That
      // word also appears in `statusHint(401)` — "Most often this key is
      // read-only and the endpoint needs a read-write one" — which `run()`
      // appends to *any* 401. So `expectError: true` plus a `read-only`
      // substring was satisfiable with the translation deleted outright: the
      // raw error would have carried the phrase anyway, and this test would
      // have stayed green while the assurance in the comment above it was gone.
      // This sentence exists only in `ReadWriteKeyRequiredError`.
      const refused = await readOnly.call(
        tool,
        tool === 'list_integrations' ? {} : { check: uuid, n: 1 },
        { expectError: `${tool} needs a read-write Healthchecks API key` }
      );
      expect(refused).toContain('Nothing is wrong with the key itself');
    }
  );
});

describe('the confirmation, both ways round', () => {
  it('asks a person when the client can show a dialog', async () => {
    // `delete_check` is the only guarded tool here, so this is the only place
    // the dialog is crossed at all — and it is crossed over a real process
    // boundary, which no unit test in this repository does.
    const throwaway = parse<{ check: { uuid: string } }>(
      await asking.call('create_check', {
        name: 'Integration throwaway',
        timeout: 3600,
        grace: 600,
      })
    );
    await asking.call('delete_check', { check: throwaway.check.uuid });
    expect(asking.prompts.length).toBeGreaterThan(0);
    // The prompt names the **uuid**, not the check's name — unambiguous, and
    // unreadable to the person being asked, who has no way to tell which
    // check `eeae2039-…` is without going and looking. Pinned as it is; if it
    // ever names the check as well, this assertion should be the thing that
    // notices.
    expect(asking.prompts.join('\n')).toContain(throwaway.check.uuid);
    // `expectError: true` alone would be met by a timeout, a 429 or a renamed
    // parameter just as well as by the 404 that means the check is really gone,
    // which is the only thing this line is here to establish.
    await asking.call(
      'get_check',
      { check: throwaway.check.uuid },
      { expectError: 'HTTP 404' }
    );
  });

  it('deletes only after the token comes back, with no dialog', async () => {
    const refusal = await plain.call('delete_check', { check: uuid });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);
    await plain.call('get_check', { check: uuid });

    await plain.call('delete_check', {
      check: uuid,
      confirm_token: tokenOf(refusal),
    });
    await plain.call('get_check', { check: uuid }, { expectError: 'HTTP 404' });
  });

  it('asked nobody on the harness without one', () => {
    expect(plain.prompts).toHaveLength(0);
    expect(readOnly.prompts).toHaveLength(0);
  });
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([
    ...asking.called,
    ...plain.called,
    ...readOnly.called,
  ]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `healthchecks-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real Healthchecks`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
