import { describe, expect, it } from 'vitest';
import { createMemoryTransportHub, hostSession } from '../src/net';
import type { StorageLike } from '../src/net';
import { HOST_SAVE_KEY } from '../src/ui/store';

describe('ui storage keys', () => {
  // main.ts decides whether to load the net chunk by peeking at this key, without importing the net code.
  it('HOST_SAVE_KEY is the key the net layer saves a hosted game under', () => {
    const data = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    const session = hostSession({ transport: createMemoryTransportHub().connect('h'), roomCode: 'ABCDEFGHJKMN', name: 'Hana', storage });
    expect(data.has(HOST_SAVE_KEY)).toBe(true);
    session.leave();
    expect(data.has(HOST_SAVE_KEY)).toBe(false);
  });
});
