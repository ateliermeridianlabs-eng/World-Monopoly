// Dev only (`npm run dev`, URL `?memnet=1`): a Transport over BroadcastChannel so tabs on one machine form a
// room without relays or WebRTC. Add `&as=NAME` to give a tab its own client key and saves (see store.ts).
// Only reachable behind `import.meta.env.DEV`, so production builds do not contain it.
import type { Transport } from '../net';

export function createMemnetTransport(room: string): Transport {
  const id = Math.random().toString(36).slice(2, 10);
  const channel = new BroadcastChannel(`wm-memnet-${room}`);
  const peers = new Set<string>();
  const on = { message: [] as ((d: unknown, from: string) => void)[], join: [] as ((p: string) => void)[], leave: [] as ((p: string) => void)[] };
  const post = (m: Record<string, unknown>) => channel.postMessage({ from: id, ...m });
  const add = (p: string) => peers.has(p) || (peers.add(p), on.join.forEach((f) => f(p)));
  const drop = (p: string) => peers.delete(p) && on.leave.forEach((f) => f(p));
  channel.onmessage = ({ data: m }) => {
    if (!m || m.from === id || (m.to && m.to !== id)) return;
    if (m.k === 'hi') {
      post({ k: 'ack', to: m.from }); // before add(): the join handler sends a snapshot, which must arrive after the ack
      add(m.from);
    } else if (m.k === 'ack') add(m.from);
    else if (m.k === 'bye') drop(m.from);
    else if (m.k === 'msg' && peers.has(m.from)) on.message.forEach((f) => f(m.data, m.from));
  };
  const bye = () => post({ k: 'bye' });
  addEventListener('pagehide', bye); // closing or reloading the tab looks like a dropped connection
  setTimeout(() => post({ k: 'hi' }), 0); // after the session has registered its handlers
  return {
    selfId: Promise.resolve(id),
    send: (data, to) => post({ k: 'msg', to, data }),
    onMessage: (h) => void on.message.push(h),
    onPeerJoin: (h) => void on.join.push(h),
    onPeerLeave: (h) => void on.leave.push(h),
    onError: () => {},
    leave() {
      bye();
      removeEventListener('pagehide', bye);
      channel.close();
    },
  };
}
