import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_TOOLS, READ_TOOLS } from '../src/tools/catalogue.js';
import { CHECK_UUID, call, connect, stubFetch, textOf } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server', () => {
  it('lists read and write tools', async () => {
    stubFetch();
    const names = (await (await connect()).listTools()).tools.map(
      (t) => t.name
    );
    expect(names.sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('does not register write tools in read-only mode', async () => {
    stubFetch();
    const names = (
      await (await connect({ readOnly: true })).listTools()
    ).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_TOOLS].sort());
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
