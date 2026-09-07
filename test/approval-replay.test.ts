import {
  ConfirmationStore,
  createApproval,
  setResourceKey,
} from 'mcp-approval';
import { describe, expect, it } from 'vitest';

import { CHECK_UUID, OTHER_UUID } from './harness.js';

/**
 * What SECURITY.md claims about freshness, held against the approver this
 * server actually builds.
 *
 * SECURITY.md used to argue from `SUPPORTED_PROTOCOL_VERSIONS`: a sealed dialog
 * answer only crosses the wire on protocol revision `2026-07-28`, that constant
 * does not list it, so there was nothing to replay and no countermeasure was
 * needed. The constant is the list of *legacy* revisions and never carries the
 * modern one — `serveStdio`, which `src/index.ts` has used since 0.3.0,
 * negotiates it separately through `server/discover`. So the era the argument
 * ruled out is the era this server serves.
 *
 * The countermeasure exists (mcp-approval 0.8.2 puts a nonce in the sealed
 * state and spends it on the first answer). What was missing is a test that asks
 * the question rather than one that reads a constant next to it.
 *
 * The context here is the shape of a modern-era call, driven directly, because
 * the in-memory client of the harness speaks the legacy era — where the SDK
 * answers the dialog inside the same call and no state ever leaves the process.
 */
describe('a sealed dialog answer is single-use', () => {
  const approver = createApproval({
    server: 'healthchecks-mcp',
    elicitation: true,
  });
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  } as unknown as Parameters<typeof approver.requestApproval>[0];
  const store = new ConfirmationStore();
  const request = {
    what: `permanently delete check ${CHECK_UUID}`,
    consequence:
      'The UUID cannot be recovered, and anything still pinging that URL will fail.',
    resourceKey: setResourceKey('delete_check', [CHECK_UUID]),
    toolName: 'delete_check',
    token: undefined,
  };
  type Ctx = Parameters<typeof approver.requestApproval>[1];
  const asking = (): Ctx =>
    ({
      mcpReq: { method: 'tools/call', requestState: () => undefined },
    }) as unknown as Ctx;
  const answering = (state: string): Ctx =>
    ({
      mcpReq: {
        method: 'tools/call',
        requestState: () => state,
        inputResponses: {
          confirm: { action: 'accept', content: { confirm: true } },
        },
      },
    }) as unknown as Ctx;

  it('honours the first presentation and asks again on the second', async () => {
    const first = await approver.requestApproval(
      server,
      asking(),
      store,
      request
    );
    expect(first.decision).toBe('pending');
    const state = (first as { result: { requestState?: unknown } }).result
      .requestState;
    expect(typeof state).toBe('string');

    const second = await approver.requestApproval(
      server,
      answering(state as string),
      store,
      request
    );
    expect(second.decision).toBe('approved');

    // The same sealed state and the same ticked box, presented again inside its
    // lifetime: not an approval. Not an error either — the likeliest cause is a
    // gateway replaying a request — so the person is asked again.
    const third = await approver.requestApproval(
      server,
      answering(state as string),
      store,
      request
    );
    expect(third.decision).toBe('pending');
  });

  it('does not let a state minted for one check delete another', async () => {
    // The seal binds the answer to the question. Deleting a check destroys its
    // UUID irrecoverably, so "which check" is the whole of what was approved.
    const first = await approver.requestApproval(
      server,
      asking(),
      store,
      request
    );
    const state = (first as { result: { requestState: string } }).result
      .requestState;
    const other = await approver.requestApproval(
      server,
      answering(state),
      store,
      {
        ...request,
        what: `permanently delete check ${OTHER_UUID}`,
        resourceKey: setResourceKey('delete_check', [OTHER_UUID]),
      }
    );
    expect(other.decision).toBe('pending');
  });
});
