import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_UUID,
  OTHER_UUID,
  call,
  checkFixture,
  connect,
  jsonOf,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('create_check', () => {
  it('sends tags space-delimited and keywords comma-delimited', async () => {
    // The two separators are opposite and both silent when got wrong.
    const stub = stubFetch({
      'POST /checks/': { status: 201, json: checkFixture() },
    });
    await call(await connect(), 'create_check', {
      name: 'Nightly Backup',
      tags: ['prod', 'backup'],
      success_kw: ['done', 'finished ok'],
      timeout: 86_400,
    });
    expect(stub.calls[0]?.body).toMatchObject({
      tags: 'prod backup',
      success_kw: 'done,finished ok',
    });
  });

  it('notifies every integration unless told otherwise, and says that it did', async () => {
    // The API's own default is no integrations at all — a check that looks
    // healthy and never tells anyone when it stops.
    const stub = stubFetch({
      'POST /checks/': { status: 201, json: checkFixture() },
    });
    const result = jsonOf(
      await call(await connect(), 'create_check', { name: 'x', timeout: 3600 })
    );
    expect(stub.calls[0]?.body).toMatchObject({ channels: '*' });
    expect(String(result.channels_applied)).toMatch(/all integrations/);
  });

  it('joins an explicit channel list with commas', async () => {
    const stub = stubFetch({
      'POST /checks/': { status: 201, json: checkFixture() },
    });
    await call(await connect(), 'create_check', {
      name: 'x',
      timeout: 3600,
      channels: ['a-uuid', 'b-uuid'],
    });
    expect(stub.calls[0]?.body).toMatchObject({ channels: 'a-uuid,b-uuid' });
  });

  it('refuses timeout and schedule together instead of letting one vanish', async () => {
    // Healthchecks lets schedule win and discards timeout without a word.
    const stub = stubFetch();
    const result = await call(await connect(), 'create_check', {
      name: 'x',
      timeout: 3600,
      schedule: '0 4 * * *',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cannot be combined/);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a tz with no schedule, which would be silently pointless', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'create_check', {
      name: 'x',
      timeout: 3600,
      tz: 'Europe/Berlin',
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('warns in the result when unique turned the create into an upsert', async () => {
    stubFetch({ 'POST /checks/': { status: 200, json: checkFixture() } });
    const result = jsonOf(
      await call(await connect(), 'create_check', {
        name: 'Nightly Backup',
        timeout: 3600,
        unique: ['name'],
      })
    );
    expect(String(result.note)).toMatch(/may have updated an existing check/);
  });

  it('reports the account check limit as what it is', async () => {
    stubFetch({
      'POST /checks/': { status: 403, json: { error: 'limit reached' } },
    });
    const result = await call(await connect(), 'create_check', {
      name: 'x',
      timeout: 3600,
    });
    expect(textOf(result)).toMatch(/check limit/);
  });

  it('is not registered at all in read-only mode', async () => {
    stubFetch();
    const names = (
      await (await connect({ readOnly: true })).listTools()
    ).tools.map((t) => t.name);
    expect(names).not.toContain('create_check');
  });
});

describe('update_check', () => {
  it('sends only the fields that were given', async () => {
    const stub = stubFetch({
      [`POST /checks/${CHECK_UUID}`]: { json: checkFixture({ grace: 7200 }) },
    });
    await call(await connect(), 'update_check', {
      check: CHECK_UUID,
      grace: 7200,
    });
    expect(stub.calls[0]?.body).toEqual({ grace: 7200 });
  });

  it('says that channels replaced the list rather than adding to it', async () => {
    const stub = stubFetch({
      [`POST /checks/${CHECK_UUID}`]: { json: checkFixture() },
    });
    const result = jsonOf(
      await call(await connect(), 'update_check', {
        check: CHECK_UUID,
        channels: ['only-this-one'],
      })
    );
    expect(stub.calls[0]?.body).toEqual({ channels: 'only-this-one' });
    expect(String(result.note)).toMatch(/replaced/);
  });

  it('refuses an update with nothing in it', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'update_check', {
      check: CHECK_UUID,
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('accepts a tz alone, because the check may already have a schedule', async () => {
    const stub = stubFetch({
      [`POST /checks/${CHECK_UUID}`]: { json: checkFixture() },
    });
    const result = await call(await connect(), 'update_check', {
      check: CHECK_UUID,
      tz: 'Europe/Berlin',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls[0]?.body).toEqual({ tz: 'Europe/Berlin' });
  });

  it('refuses a unique_key, which this endpoint cannot address', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'update_check', {
      check: 'a'.repeat(40),
      grace: 3600,
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('pause_check', () => {
  it('pauses straight away, without asking', async () => {
    // Deliberately no guard. resume_check puts it back and nothing is lost in
    // between, and a dialog in front of a reversible state change is how people
    // learn to tick without reading — which spends the attention delete_check
    // needs. What pausing does cost is stated in the description instead: a job
    // that stops running goes unnoticed while the check is paused.
    const stub = stubFetch({
      [`POST /checks/${CHECK_UUID}/pause`]: {
        json: checkFixture({ status: 'paused' }),
      },
    });
    const client = await connect(undefined, 'accept');
    const result = jsonOf(
      await call(client, 'pause_check', { check: CHECK_UUID })
    );
    expect(client.prompts).toHaveLength(0);
    expect(stub.calls[0]?.method).toBe('POST');
    expect(String(result.note)).toMatch(/Alerting is off/);
  });

  it('takes no confirm_token at all', async () => {
    // Not merely unguarded: the parameter is gone from the schema, so a caller
    // that still sends one is told rather than quietly ignored.
    const client = await connect();
    const { tools } = await client.listTools();
    const pause = tools.find((tool) => tool.name === 'pause_check');
    expect(pause).toBeDefined();
    const properties = (
      pause!.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    expect(properties && 'confirm_token' in properties).toBe(false);
  });
});

describe('resume_check', () => {
  it('resumes without a confirmation, because it restores alerting', async () => {
    const stub = stubFetch({
      [`POST /checks/${CHECK_UUID}/resume`]: {
        json: checkFixture({ status: 'new' }),
      },
    });
    const result = jsonOf(
      await call(await connect(), 'resume_check', { check: CHECK_UUID })
    );
    expect(stub.calls).toHaveLength(1);
    expect((result.check as Record<string, unknown>).status).toBe('new');
  });

  it('explains the 409 that a non-paused check produces', async () => {
    stubFetch({
      [`POST /checks/${CHECK_UUID}/resume`]: {
        status: 409,
        json: { error: 'not paused' },
      },
    });
    const result = await call(await connect(), 'resume_check', {
      check: CHECK_UUID,
    });
    expect(textOf(result)).toMatch(/not paused/);
  });
});

describe('delete_check', () => {
  it('asks the user, and deletes once they accept', async () => {
    // The point of the approval path: a client that can put a question in front
    // of a person gets asked, instead of a token that only proves the same call
    // was made twice.
    const stub = stubFetch({
      [`DELETE /checks/${CHECK_UUID}`]: { json: checkFixture() },
    });
    const client = await connect({}, 'accept');
    const result = await call(client, 'delete_check', { check: CHECK_UUID });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toMatch(/UUID cannot be recovered/);
    expect(stub.calls).toHaveLength(1);
    expect(textOf(result)).toContain('is gone');
  });

  it('deletes nothing when the user declines', async () => {
    const stub = stubFetch();
    const client = await connect({}, 'decline');
    const result = await call(client, 'delete_check', { check: CHECK_UUID });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('declined');
    expect(stub.calls).toHaveLength(0);
  });

  it('deletes nothing when the user closes the dialog', async () => {
    // Cancel is not a yes. For an irreversible delete the only safe reading of
    // "no answer" is no.
    const stub = stubFetch();
    const client = await connect({}, 'cancel');
    const result = await call(client, 'delete_check', { check: CHECK_UUID });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('offers no token to a client it can ask properly', async () => {
    // The control that makes the three above mean something: the token path is
    // unchanged, so a server that silently never asked would still pass every
    // other test in this file.
    stubFetch();
    const client = await connect({}, 'decline');
    const result = await call(client, 'delete_check', { check: CHECK_UUID });
    expect(textOf(result)).not.toContain('confirm_token=');
  });

  it('hands back a token first, names the consequence and points at pause', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'delete_check', {
      check: CHECK_UUID,
    });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(result)).toMatch(/UUID cannot be recovered/);
    expect(textOf(result)).toMatch(/pause_check instead/);
  });

  it('quotes no name or description from the check in the prompt', async () => {
    // The confirmation text is read by a model, and a check's name is free text
    // this server does not control.
    stubFetch();
    const result = await call(await connect(), 'delete_check', {
      check: CHECK_UUID,
    });
    expect(textOf(result)).not.toContain('Nightly Backup');
    expect(textOf(result)).not.toContain('Runs pg_dump and uploads it.');
  });

  it('deletes on the second call and keeps a record of what it was', async () => {
    stubFetch();
    const client = await connect();
    const token = tokenOf(
      await call(client, 'delete_check', { check: CHECK_UUID })
    );

    const stub = stubFetch({
      [`DELETE /checks/${CHECK_UUID}`]: { json: checkFixture() },
    });
    const result = jsonOf(
      await call(client, 'delete_check', {
        check: CHECK_UUID,
        confirm_token: token,
      })
    );
    expect(stub.calls[0]?.method).toBe('DELETE');
    expect((result.deleted as Record<string, unknown>).name).toBe(
      'Nightly Backup'
    );
    expect(String(result.note)).toMatch(/cannot be undone/);
  });

  it('does not accept a token issued for a different check', async () => {
    // The approval names the operation *and* the target. Only delete_check is
    // guarded now, so a token from one check is the case left to prove.
    const stub = stubFetch();
    const client = await connect();
    const token = tokenOf(
      await call(client, 'delete_check', { check: OTHER_UUID })
    );
    const result = await call(client, 'delete_check', {
      check: CHECK_UUID,
      confirm_token: token,
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects a made-up token without calling the API', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'delete_check', {
      check: CHECK_UUID,
      confirm_token: 'f'.repeat(32),
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('is marked destructive to the client', async () => {
    stubFetch();
    const { tools } = await (await connect()).listTools();
    expect(
      tools.find((t) => t.name === 'delete_check')?.annotations?.destructiveHint
    ).toBe(true);
  });
});

describe('clearing every integration', () => {
  it('is refused, because it silently stops all alerting', async () => {
    // The same outcome as pause_check, which is gated behind a confirmation
    // token — and create_check defaults channels to "*" for this exact reason.
    // A model that reads channels as additive and passes [] to "clear and
    // re-add" would leave a monitored job permanently silent.
    const stub = stubFetch();
    for (const tool of ['create_check', 'update_check']) {
      const args =
        tool === 'create_check'
          ? { name: 'x', timeout: 3600, channels: [] }
          : { check: CHECK_UUID, channels: [] };
      const result = await call(await connect(), tool, args);
      expect(result.isError, tool).toBe(true);
    }
    expect(stub.calls).toHaveLength(0);
  });
});
