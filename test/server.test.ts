import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_TOOLS, READ_TOOLS } from '../src/tools/catalogue.js';
import { CHECK_UUID, call, connect, stubFetch, textOf } from './harness.js';
import { expectPortableToolSchemas } from 'mcp-integration-harness';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server', () => {
  it('introduces itself in full, and the profile matches server.json', async () => {
    // What a client puts in front of a person comes from the handshake, not from
    // server.json — that file is not in the npm tarball. Both carry the same
    // profile, and this is what keeps the two from drifting apart.
    const registry = JSON.parse(
      readFileSync(new URL('../server.json', import.meta.url), 'utf8')
    ) as { title: string; description: string; websiteUrl: string };

    const info = (await connect()).getServerVersion();

    expect(info?.title).toBe(registry.title);
    expect(info?.description).toBe(registry.description);
    expect(info?.websiteUrl).toBe(registry.websiteUrl);
    // The registry enforces this limit; failing here beats failing on publish.
    expect(registry.description.length).toBeLessThanOrEqual(100);

    // Icons are URLs on the documentation site. A data: URI would be legal and
    // would ride along on every single handshake.
    expect(info?.icons?.length ?? 0).toBeGreaterThan(0);
    for (const icon of info?.icons ?? []) {
      expect(icon.src, 'icon src').toMatch(/^https:\/\//);
    }
  });

  it('warns about untrusted content where a model reads it first', async () => {
    // The untrusted marker on a result is read after the fact. This is the only
    // channel that arrives before the first tool call.
    const instructions = (await connect()).getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/never\s+(?:follow|as)\s+instructions/i);
  });

  it('lists read and write tools', async () => {
    stubFetch();
    const names = (await (await connect()).listTools()).tools.map(
      (t) => t.name
    );
    expect(names.toSorted()).toEqual(ALL_TOOLS.toSorted());
  });

  it('does not register write tools in read-only mode', async () => {
    stubFetch();
    const names = (
      await (await connect({ readOnly: true })).listTools()
    ).tools.map((t) => t.name);
    expect(names.toSorted()).toEqual(READ_TOOLS.toSorted());
  });

  it('lists its tools without an API key, so a sandbox can introspect it', async () => {
    // Registries and sandbox inspectors complete the handshake with no
    // credentials at all; a server that refuses to start there stays listed as
    // "not tested" forever.
    stubFetch();
    const tools = (await (await connect({ apiKey: undefined })).listTools())
      .tools;
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it('fails an authenticated call without a key by naming what to set', async () => {
    const stub = stubFetch();
    const result = await call(
      await connect({ apiKey: undefined }),
      'list_checks'
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HEALTHCHECKS_API_KEY/);
    expect(stub.calls).toHaveLength(0);
  });

  it('reports its own name and version to the client', async () => {
    stubFetch();
    const info = (await connect()).getServerVersion();
    expect(info?.name).toBe('healthchecks-mcp');
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('gives every tool a title and a description', async () => {
    stubFetch();
    const { tools } = await (await connect()).listTools();
    for (const tool of tools) {
      expect(tool.title ?? tool.annotations?.title, tool.name).toBeTruthy();
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(40);
    }
  });

  it('declares an output schema on every tool', async () => {
    // The same argument as the annotations below, one field along. A tool that
    // says nothing about its result forces a client to parse prose to find out
    // what it got, and the SDK sends no `structuredContent` at all for a tool
    // that declared no schema.
    const { tools } = await (await connect()).listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // An object root, not merely a schema. SEP-2106 allows an array or a
      // scalar, but a 2025-era client is served that same tool with the schema
      // rewritten to `{result: …}` — so it would answer in two shapes
      // depending on who asked.
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('advertises schemas every client can read', async () => {
    // Legal JSON Schema is not enough. `{}` in a schema position — what zod
    // writes for `looseObject`, `catchall` and `z.unknown()` — and `type` as an
    // array are both refused, or silently dropped, by some clients. Neither is
    // a contract: each has an equivalent spelling that says the same thing, so
    // there is nothing here to excuse.
    const { tools } = await (await connect()).listTools();
    expectPortableToolSchemas(tools);
  });

  it('declares all four annotation hints on every tool', async () => {
    // Not a style rule. Two of the four default to a *stronger* claim than
    // silence suggests: the specification gives destructiveHint and
    // openWorldHint a default of true, so a tool that omits them announces
    // itself as destructive and open-world. Leaving them out is a statement,
    // not an abstention — so every tool states all four.
    stubFetch();
    const { tools } = await (await connect()).listTools();
    const hints = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const;
    for (const tool of tools) {
      for (const hint of hints) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          'boolean'
        );
      }
    }
  });

  it('calls only update_check and delete_check destructive', async () => {
    // create_check, pause_check and resume_check all used to inherit
    // destructiveHint: true from the default. Pausing is reversible by
    // resume_check and creating takes nothing away; warning about them spends
    // the warning that delete_check needs.
    stubFetch();
    const { tools } = await (await connect()).listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('create_check')?.destructiveHint).toBe(false);
    expect(byName.get('pause_check')?.destructiveHint).toBe(false);
    expect(byName.get('resume_check')?.destructiveHint).toBe(false);
    expect(byName.get('update_check')?.destructiveHint).toBe(true);
    expect(byName.get('delete_check')?.destructiveHint).toBe(true);
    // Pausing something already paused leaves it paused. wg-easy said true for
    // enable/disable while this said false; both now say true.
    expect(byName.get('pause_check')?.idempotentHint).toBe(true);
    expect(byName.get('resume_check')?.idempotentHint).toBe(true);
    // Creating twice gives two checks with two UUIDs.
    expect(byName.get('create_check')?.idempotentHint).toBe(false);
  });

  it('rejects a path-traversal identifier before any request goes out', async () => {
    const stub = stubFetch();
    const result = await call(await connect(), 'get_check', {
      check: '../../admin',
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('never puts the API key into a tool result', async () => {
    // Not even on the error paths, which is where credentials usually leak.
    stubFetch({
      'GET /checks/': { status: 401, json: { error: 'wrong api key' } },
    });
    const client = await connect();
    for (const name of ['list_checks', 'get_api_key_info']) {
      const result = await call(client, name, {});
      expect(textOf(result)).not.toContain('k'.repeat(32));
    }
  });

  it('does not reach the network for the first step of a guarded tool', async () => {
    const stub = stubFetch();
    await call(await connect(), 'delete_check', { check: CHECK_UUID });
    expect(stub.calls).toHaveLength(0);
  });
});
