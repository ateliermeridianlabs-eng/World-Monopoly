// Message transport: Trystero (WebRTC, serverless signalling) in the browser, an in-memory hub in tests.
// Change SIGNALLING below to switch Trystero strategy (e.g. '@trystero-p2p/torrent'), after installing it.
import { joinRoom } from '@trystero-p2p/nostr';
import type { JsonValue, TurnServerConfig } from '@trystero-p2p/nostr';

/** A room of peers that exchange JSON messages. Peer ids are per connection (a reload gets a new id). */
export interface Transport {
  /** This connection's peer id. */
  readonly selfId: Promise<string>;
  /** Sends a JSON-serializable message to one peer, or to everyone else when `to` is omitted. Never throws. */
  send(data: unknown, to?: string): void;
  onMessage(handler: (data: unknown, from: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  onPeerLeave(handler: (peerId: string) => void): void;
  /** Network-level problems worth showing (e.g. no relay reachable, a peer that could not connect). */
  onError(handler: (message: string) => void): void;
  leave(): void;
}

/** Namespaces our rooms on the shared public relays. Changing it splits old and new clients. */
export const APP_ID = 'ateliermeridianlabs-eng.github.io/world-monopoly/v1';
/** Public Nostr relays used in parallel; any one of them working is enough to find peers. Library default is 5. */
export const RELAY_REDUNDANCY = 6;
/** Largest message accepted from a peer. A full snapshot is about 30 KB. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

export interface TrysteroOptions {
  /** TURN servers for strict networks. Defaults to the VITE_TURN_* build-time env vars (none if unset). */
  turn?: TurnServerConfig[];
}

/**
 * TURN config from `VITE_TURN_URLS` (comma-separated), `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`.
 * Returns [] when no URL is set. Anything baked into a static build is public.
 */
export function turnFromEnv(env: Partial<Record<string, string | undefined>>): TurnServerConfig[] {
  const urls = (env.VITE_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (!urls.length) return [];
  const server: TurnServerConfig = { urls };
  if (env.VITE_TURN_USERNAME) server.username = env.VITE_TURN_USERNAME;
  if (env.VITE_TURN_CREDENTIAL) server.credential = env.VITE_TURN_CREDENTIAL;
  return [server];
}

/**
 * Joins the Trystero room for `roomCode`. The code is also the room password, so relays only see
 * a hashed topic and encrypted handshakes, and peers without the code cannot connect.
 * Not exercised by the test suite (no relay access there).
 */
export function createTrysteroTransport(roomCode: string, opts: TrysteroOptions = {}): Transport {
  const turn = opts.turn ?? turnFromEnv(import.meta.env);
  const room = joinRoom(
    {
      appId: APP_ID,
      password: roomCode,
      // Our own clientId handles reconnection, so skip Trystero's persisted identity (IndexedDB).
      identity: 'none',
      maxReceiveBytes: 4 * MAX_MESSAGE_BYTES,
      relayConfig: { redundancy: RELAY_REDUNDANCY },
      ...(turn.length ? { turnConfig: turn } : {}),
    },
    roomCode,
  );
  const channel = room.makeAction<JsonValue>('wm');
  channel.onReceive(({ byteLength }) => byteLength <= MAX_MESSAGE_BYTES);
  const swallow = () => {
    /* peer left mid-send; the session handles presence */
  };
  return {
    selfId: room.getSelf().then((s) => s.peerId),
    send(data, to) {
      try {
        channel.send(data as JsonValue, to ? { target: to } : undefined).catch(swallow);
      } catch {
        swallow();
      }
    },
    onMessage: (handler) => void channel.onMessage((data, ctx) => handler(data, ctx.peerId)),
    onPeerJoin: (handler) => void room.onPeerJoin((ctx) => handler(ctx.peerId)),
    onPeerLeave: (handler) => void room.onPeerLeave((ctx) => handler(ctx.peerId)),
    onError: (handler) => void room.onError((e) => handler(e.code === 'peer-connect-failed' && !e.turnConfigured
      ? 'Could not connect to a player. A strict network may need a TURN server.'
      : e.message)),
    leave: () => void room.leave().catch(swallow),
  };
}

/**
 * In-memory peers for tests. `connect()` joins a new peer; delivery is async (microtasks), in order,
 * and every message is JSON round-tripped so nothing non-serializable slips through.
 */
export function createMemoryTransportHub() {
  type Node = { message: ((d: unknown, from: string) => void)[]; join: ((id: string) => void)[]; leave: ((id: string) => void)[] };
  const nodes = new Map<string, Node>();
  let count = 0;
  const later = (fn: () => void) => void Promise.resolve().then(fn);

  function connect(id = `peer-${++count}`): Transport {
    if (nodes.has(id)) throw new Error(`peer ${id} already connected`);
    const me: Node = { message: [], join: [], leave: [] };
    for (const [otherId, other] of nodes) {
      later(() => nodes.get(otherId) === other && nodes.get(id) === me && other.join.forEach((h) => h(id)));
      later(() => nodes.get(otherId) === other && nodes.get(id) === me && me.join.forEach((h) => h(otherId)));
    }
    nodes.set(id, me);
    const deliver = (to: string, json: string) =>
      later(() => {
        const target = nodes.get(to);
        if (target && nodes.get(id) === me) target.message.forEach((h) => h(JSON.parse(json), id));
      });
    return {
      selfId: Promise.resolve(id),
      send(data, to) {
        if (nodes.get(id) !== me) return;
        const json = JSON.stringify(data);
        if (json === undefined) return;
        if (to) deliver(to, json);
        else for (const other of nodes.keys()) if (other !== id) deliver(other, json);
      },
      onMessage: (h) => void me.message.push(h),
      onPeerJoin: (h) => void me.join.push(h),
      onPeerLeave: (h) => void me.leave.push(h),
      onError: () => {},
      leave() {
        if (nodes.get(id) !== me) return;
        nodes.delete(id);
        for (const other of nodes.values()) later(() => other.leave.forEach((h) => h(id)));
      },
    };
  }

  return { connect, peerIds: () => [...nodes.keys()] };
}
