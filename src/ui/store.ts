// localStorage that never throws, with a dev-only key prefix so two tabs can act as two players.
// In a production build `DEV` is false, so the prefix is '' and the keys are exactly the stored ones.
import type { StorageLike } from '../net';

/** Key the net layer stores the hosted game under (src/net/session.ts). tests/ui.test.ts checks they match. */
export const HOST_SAVE_KEY = 'world-monopoly-net-host-v1';
export const NAME_KEY = 'world-monopoly-name';

const search = typeof location === 'undefined' ? '' : location.search;
/** Dev only: `?memnet=1&as=ann` gives this tab its own client key, name and saves. */
export const devParams = import.meta.env.DEV ? new URLSearchParams(search) : null;
const prefix = devParams?.get('as') ? `${devParams.get('as')!.replace(/[^\w-]/g, '').slice(0, 20)}:` : '';

function attempt<T>(fn: (s: Storage) => T): T | null {
  try {
    return fn(localStorage);
  } catch {
    return null; // storage unavailable (private mode, blocked cookies)
  }
}

export const uiStorage: StorageLike = {
  getItem: (k) => attempt((s) => s.getItem(prefix + k)),
  setItem: (k, v) => void attempt((s) => s.setItem(prefix + k, v)),
  removeItem: (k) => void attempt((s) => s.removeItem(prefix + k)),
};

export const store = {
  get: (k: string) => uiStorage.getItem(k),
  set: (k: string, v: string) => uiStorage.setItem(k, v),
  remove: (k: string) => uiStorage.removeItem(k),
};
