import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ToolFilterError } from '../src/tool-filter.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { CHECK_UUID, stubFetch, testConfig } from './harness.js';

/** The tools a server built with this configuration actually offers. */
async function toolNames(overrides: Partial<Config> = {}): Promise<string[]> {
  stubFetch();
  const server = createServer(testConfig(overrides));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue', () => {
  // These are what let the filter validate a name before anything is
  // registered. If they drift from the code, every error message drifts too.
  it('is exactly the set of tools the server registers', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('splits into read and write with nothing left over', async () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    expect(
      READ_TOOLS.filter((t) => (WRITE_TOOLS as readonly string[]).includes(t))
    ).toEqual([]);
    expect(await toolNames({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('holds names the env-var syntax cannot misread', () => {
    // A comma or an asterisk in a name would break the separator or the
    // pattern; a tool called "essential" would be unreachable behind the preset.
    for (const tool of ALL_TOOLS) {
      expect(tool).toMatch(/^[a-z0-9_]+$/);
    }
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that is a real, sensibly sized subset', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
  });

  it('leaves the irreversible and the alerting-off tools out of the preset', () => {
    // The editorial half of the preset, asserted so a later addition has to
    // argue with a failing test rather than slip in.
    expect(ESSENTIAL_TOOLS).not.toContain('delete_check');
    expect(ESSENTIAL_TOOLS).not.toContain('pause_check');
    expect(ESSENTIAL_TOOLS).not.toContain('get_ping_body');
  });

  it('marks every read tool as read-only to the client', async () => {
    stubFetch();
    const server = createServer(testConfig());
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const isRead = (READ_TOOLS as readonly string[]).includes(tool.name);
      expect(tool.annotations?.readOnlyHint ?? false).toBe(isRead);
    }
  });
});

describe('selecting tools', () => {
  it('narrows tools/list to an allow list', async () => {
    expect(await toolNames({ allowTools: 'list_checks,get_check' })).toEqual([
      'get_check',
      'list_checks',
    ]);
  });

  it('removes a whole family with a prefix pattern', async () => {
    const names = await toolNames({ denyTools: 'delete_*' });
    expect(names.some((n) => n.startsWith('delete_'))).toBe(false);
    expect(names).toHaveLength(
      ALL_TOOLS.length - ALL_TOOLS.filter((t) => t.startsWith('delete_')).length
    );
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await toolNames({
        allowTools: 'get_check,list_checks',
        denyTools: 'list_checks',
      })
    ).toEqual(['get_check']);
  });

  it('selects the curated set for "essential"', async () => {
    expect(await toolNames({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('lets the preset compose with extra names', async () => {
    expect(await toolNames({ allowTools: 'essential,delete_check' })).toEqual(
      [...ESSENTIAL_TOOLS, 'delete_check'].sort()
    );
  });

  it('trims entries, ignores case and skips empty ones', async () => {
    expect(
      await toolNames({ allowTools: ' LIST_CHECKS ,, get_check, ' })
    ).toEqual(['get_check', 'list_checks']);
  });

  it('treats an empty value as no filter at all', async () => {
    // `HEALTHCHECKS_ALLOW_TOOLS=` in a compose file must not mean "allow nothing".
    expect(await toolNames({ allowTools: '   ' })).toEqual(
      [...ALL_TOOLS].sort()
    );
  });

  it('leaves an unconfigured server untouched', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });
});

describe('a filtered-out tool', () => {
  it('cannot be called either, not merely hidden', async () => {
    // This is the difference between removing the tool and disabling it: a
    // disabled tool still answers a call, which advertises a refusal. It is
    // also what proves the filter is a real cut rather than decoration.
    const stub = stubFetch();
    const server = createServer(testConfig({ allowTools: 'list_checks' }));
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = (await client.callTool({
      name: 'delete_check',
      arguments: { check: CHECK_UUID },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Tool delete_check not found'
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no tool has, and says which names exist', () => {
    // A typo that was merely ignored would leave a tool missing with no trace
    // of why — nobody looks for the cause of an absence in an env var.
    expect(() =>
      createServer(testConfig({ allowTools: 'list_checkz' }))
    ).toThrow(ToolFilterError);
    expect(() =>
      createServer(testConfig({ allowTools: 'list_checkz' }))
    ).toThrow(/no tool matches "list_checkz".*list_checks/s);
  });

  it('rejects a pattern that matches nothing', () => {
    expect(() => createServer(testConfig({ allowTools: 'lst_*' }))).toThrow(
      /no tool matches "lst_\*"/
    );
  });

  it('rejects a pattern with the star anywhere but last', () => {
    expect(() => createServer(testConfig({ allowTools: '*_check' }))).toThrow(
      /single trailing "\*"/
    );
    expect(() => createServer(testConfig({ allowTools: 'list_*_x' }))).toThrow(
      /single trailing "\*"/
    );
  });

  it('applies the same rule to the deny list', () => {
    expect(() =>
      createServer(testConfig({ denyTools: 'delet_check' }))
    ).toThrow(/_DENY_TOOLS: no tool matches "delet_check"/);
  });

  it('rejects a list that would leave no tools at all', () => {
    expect(() => createServer(testConfig({ denyTools: '*' }))).toThrow(
      /empty tool list/
    );
  });
});

describe('together with read-only mode', () => {
  const readOnly = { readOnly: true } as const;

  it('names read-only as the reason, rather than calling the tool unknown', () => {
    // The tool exists; it is suppressed. Reporting "unknown tool" would send
    // the reader looking for a typo that is not there. This is the whole reason
    // the catalogue is declared rather than discovered.
    let thrown: unknown;
    try {
      createServer(testConfig({ ...readOnly, allowTools: 'delete_check' }));
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('_READ_ONLY');
    expect(message).not.toContain('no tool matches');
  });

  it('lets a pattern cover write tools without failing', async () => {
    // `get_*,create_*` is a legitimate template to hand to both kinds of
    // deployment; under read-only the write half simply contributes nothing.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await toolNames({ ...readOnly, allowTools: 'get_*,create_*' })
    ).toEqual(READ_TOOLS.filter((t) => t.startsWith('get_')).sort());
    expect(warn.mock.calls.flat().join(' ')).toContain('contributes nothing');
  });

  it('keeps the essential preset usable, narrowed to its read half', async () => {
    expect(await toolNames({ ...readOnly, allowTools: 'essential' })).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).sort()
    );
  });

  it('says read-only is the reason when a pattern leaves nothing at all', () => {
    // `create_*` is legal and merely contributes nothing — but if it was the
    // whole allow list, the resulting empty server needs the real explanation,
    // not "your lists leave no tools".
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      createServer(testConfig({ ...readOnly, allowTools: 'create_*' }))
    ).toThrow(/only write tools, but .*_READ_ONLY is set/);
  });

  it('does not apply the write-tool rule to the deny list', async () => {
    // Denying something already suppressed is how a defensive list is written.
    expect(await toolNames({ ...readOnly, denyTools: 'delete_check' })).toEqual(
      [...READ_TOOLS].sort()
    );
  });
});
