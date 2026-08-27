import { describe, expect, it } from 'vitest';

import {
  ConfirmationStore,
  confirmationPrompt,
  setResourceKey,
} from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('rejects a call without a token and accepts the issued one once', () => {
    const store = new ConfirmationStore();
    const resource = setResourceKey('delete_check', ['a']);

    expect(store.consume(resource, undefined)).toBe(false);
    const token = store.issue(resource);
    expect(store.consume(resource, token)).toBe(true);
    // Single use: a replay must not work.
    expect(store.consume(resource, token)).toBe(false);
  });

  it('issues tokens that cannot be guessed or confused with each other', () => {
    const store = new ConfirmationStore();
    const tokens = new Set(
      Array.from({ length: 50 }, (_unused, i) =>
        store.issue(setResourceKey('delete_check', [String(i)]))
      )
    );
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not accept a token issued for a different target', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_check', ['a']));
    expect(store.consume(setResourceKey('delete_check', ['b']), token)).toBe(
      false
    );
  });

  it('does not accept a token issued for a different operation', () => {
    // Confirming a pause must not authorise a delete of the same check.
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('pause_check', ['a']));
    expect(store.consume(setResourceKey('delete_check', ['a']), token)).toBe(
      false
    );
  });

  it('does not accept a token issued for a smaller set of targets', () => {
    // The regression this guards: confirming ["a"] must not execute
    // ["a", "b"] — the model picks the second list.
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_checks', ['a']));
    expect(
      store.consume(setResourceKey('delete_checks', ['a', 'b']), token)
    ).toBe(false);
  });

  it('treats the target set as unordered', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_checks', ['a', 'b']));
    expect(
      store.consume(setResourceKey('delete_checks', ['b', 'a']), token)
    ).toBe(true);
  });

  it('rejects a token of a different length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the comparison hashes first
    // so that a short guess is answered like any other wrong one.
    const store = new ConfirmationStore();
    const resource = setResourceKey('delete_check', ['a']);
    store.issue(resource);
    expect(store.consume(resource, 'x')).toBe(false);
    expect(store.consume(resource, '')).toBe(false);
  });

  it('expires tokens', async () => {
    const store = new ConfirmationStore(1);
    const resource = setResourceKey('delete_check', ['a']);
    const token = store.issue(resource);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.consume(resource, token)).toBe(false);
  });

  it('bounds the number of pending tokens', () => {
    const store = new ConfirmationStore();
    for (let i = 0; i < 150; i += 1) {
      store.issue(setResourceKey('delete_check', [String(i)]));
    }
    // The oldest entries are evicted, so the newest still works.
    expect(
      store.consume(
        setResourceKey('delete_check', ['149']),
        store.issue(setResourceKey('delete_check', ['149']))
      )
    ).toBe(true);
  });

  it('reports its lifetime in whole minutes', () => {
    expect(new ConfirmationStore().ttlMinutes).toBe(5);
  });
});

describe('confirmationPrompt', () => {
  it('names the tool, the token and the lifetime', () => {
    const text = confirmationPrompt(
      'permanently delete check abc',
      'The UUID cannot be recovered.',
      'delete_check',
      'a'.repeat(32),
      5
    );
    expect(text).toContain('delete_check');
    expect(text).toContain(`confirm_token="${'a'.repeat(32)}"`);
    expect(text).toContain('5 minutes');
  });
});
