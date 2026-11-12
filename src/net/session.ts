// The object the UI talks to. One class for both roles: the host runs the authority and broadcasts
// snapshots; a guest sends intents and renders what the host sends. Roles can switch at runtime
// (a guest takes over; a stale host demotes itself).

import {
  addSeat, applyIntent, applyLobbyOp, convertToBot, createTable, needsBotStep, removeSeat, resetPresence, seatOf,
  setConnected, setRoundLimit, setSeat, startGame, stepBot,
} from './authority';
import type { Result } from './authority';
import { PROTOCOL_VERSION, cleanName, clientIdFromKey, parseMessage, parseSnapshot } from './protocol';
import type { HostMessage, Intent, LobbyOp, Message, Snapshot } from './protocol';
import type { Transport } from './transport';

export type SessionRole = 'host' | 'guest';
/**
 * - `connecting`: guest waiting for the first snapshot from a host.
 * - `connected`: host, or guest following a live host.
 * - `host-lost`: the host's connection dropped. The last snapshot is kept; wait for the host to
 *   come back (a reload resumes it) or call `takeOverAsHost()`.
 * - `closed`: after `leave()`.
 */
export type SessionStatus = 'connecting' | 'connected' | 'host-lost' | 'closed';
/** Called on every change. `rejected` is set when this client's own action was refused (show it as a toast). */
export type SessionListener = (rejected?: string) => void;
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SessionOptions {
  transport: Transport;
  /** The room this transport joined; stored with the host save so a reload can rejoin it. */
  roomCode: string;
  /** Display name (trimmed, max 16 chars). Used when this client claims a seat. */
  name: string;
  /** Defaults to `localStorage`; pass null to keep nothing. Storage errors are ignored. */
  storage?: StorageLike | null;
  /** Delay between bot steps on the host, ms. Default 450 (same as hot-seat). */
  botDelayMs?: number;
  /** Game seed source on the host. Default `Date.now`. */
  seed?: () => number;
}

export interface HostSave {
  roomCode: string;
  snapshot: Snapshot;
}

const CLIENT_KEY = 'world-monopoly-net-client-v1';
const HOST_SAVE_KEY = 'world-monopoly-net-host-v1';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{6}$`);

// ---------- storage ----------

function store(storage: StorageLike | null | undefined) {
  const s = (): StorageLike | null => {
    if (storage !== undefined) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const attempt = <T>(fn: (st: StorageLike) => T): T | null => {
    try {
      const st = s();
      return st ? fn(st) : null;
    } catch {
      return null;
    }
  };
  return {
    get: (k: string) => attempt((st) => st.getItem(k)),
    set: (k: string, v: string) => void attempt((st) => st.setItem(k, v)),
    remove: (k: string) => void attempt((st) => st.removeItem(k)),
  };
}

function randomString(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ROOM_ALPHABET[b & 31]).join('');
}

/** This browser's private client key (created and stored on first use; in-memory if storage fails). */
function clientKey(st: ReturnType<typeof store>) {
  const saved = st.get(CLIENT_KEY);
  if (saved && /^[A-Za-z0-9]{16,64}$/.test(saved)) return saved;
  const key = randomString(26);
  st.set(CLIENT_KEY, key);
  return key;
}

/**
 * The unfinished game this browser was hosting, if any (validated; finished games are ignored like
 * the hot-seat autosave). Rejoin `roomCode` and pass `snapshot` to `hostSession({ resume })`.
 */
export function loadHostSave(storage?: StorageLike | null): HostSave | null {
  try {
    const raw = JSON.parse(store(storage).get(HOST_SAVE_KEY) ?? 'null');
    const roomCode = normalizeRoomCode(raw?.roomCode ?? '');
    const snapshot = parseSnapshot(raw?.snapshot);
    return roomCode && snapshot && snapshot.game?.phase !== 'gameOver' ? { roomCode, snapshot } : null;
  } catch {
    return null;
  }
}

export function clearHostSave(storage?: StorageLike | null) {
  store(storage).remove(HOST_SAVE_KEY);
}

// ---------- room codes ----------

/** Random 6-character room code without look-alike characters (no 0, O, 1, I). */
export function newRoomCode(): string {
  return randomString(6);
}

/** Uppercases and strips spaces/dashes; returns null unless it is a valid room code. */
export function normalizeRoomCode(input: string): string | null {
  const code = String(input).toUpperCase().replace(/[\s-]/g, '');
  return ROOM_RE.test(code) ? code : null;
}

/** Reads `#room=ABC123` from a hash string (e.g. `location.hash`). */
export function roomCodeFromHash(hash: string): string | null {
  return normalizeRoomCode(new URLSearchParams(hash.replace(/^#/, '')).get('room') ?? '');
}

/** Invite link: `href` with its hash replaced by `#room=CODE`. Keeps the path, so it works from a sub-path. */
export function roomLink(code: string, href: string): string {
  const url = new URL(href);
  url.hash = `room=${code}`;
  return url.toString();
}

/** Puts `#room=CODE` in the address bar (or removes it) without reloading or adding history. Browser only. */
export function setRoomInUrl(code: string | null) {
  history.replaceState(history.state, '', code ? `#room=${code}` : location.pathname + location.search);
}

// ---------- session ----------

/** a's host beats b's: higher epoch, then lower hostId. */
const outranks = (a: Snapshot, b: Snapshot) => a.hostEpoch > b.hostEpoch || (a.hostEpoch === b.hostEpoch && a.hostId < b.hostId);

export class Session {
  private _role: SessionRole;
  private _snapshot: Snapshot | null = null;
  private _status: SessionStatus;
  private _lastRejection: string | null = null;
  private _networkError: string | null = null;
  private name: string;
  private readonly key: string;
  private readonly transport: Transport;
  private readonly st: ReturnType<typeof store>;
  private readonly botDelayMs: number;
  private readonly seed: () => number;
  private hostPeer: string | null = null;
  private readonly peerSet = new Set<string>();
  /** Host: transport peer id -> clientId, learned from hello. */
  private readonly peerClients = new Map<string, string>();
  /** Host: clientId -> name from hello, used when that client claims a seat. */
  private readonly helloNames = new Map<string, string>();
  private readonly listeners = new Set<SessionListener>();
  private botTimer: ReturnType<typeof setTimeout> | undefined;

  /** Room code this session belongs to. */
  readonly roomCode: string;
  /** This browser's public id (what `Seat.clientId` holds for this player). */
  readonly clientId: string;

  /** @internal Use `hostSession` or `joinSession`. */
  constructor(opts: SessionOptions, role: SessionRole, resume?: Snapshot) {
    this.transport = opts.transport;
    this.roomCode = opts.roomCode;
    this.name = cleanName(opts.name) ?? 'Player';
    this.st = store(opts.storage);
    this.botDelayMs = opts.botDelayMs ?? 450;
    this.seed = opts.seed ?? Date.now;
    this.key = clientKey(this.st);
    this.clientId = clientIdFromKey(this.key);
    this._role = role;
    this._status = role === 'host' ? 'connected' : 'connecting';

    const t = this.transport;
    t.onPeerJoin((p) => this.live() && this.peerJoined(p));
    t.onPeerLeave((p) => this.live() && this.peerLeft(p));
    t.onMessage((raw, from) => {
      if (!this.live()) return;
      const msg = parseMessage(raw);
      if (msg) this.received(msg, from);
    });
    t.onError((message) => {
      this._networkError = message;
      this.emit();
    });

    if (role === 'host') {
      if (resume) {
        const s = structuredClone(resume);
        s.hostEpoch += 1;
        this.becomeHost(s);
      } else {
        this.becomeHost(createTable(this.clientId, this.name));
      }
    }
  }

  // ----- state (read-only; treat returned objects as immutable) -----

  /** 'host' runs the game; 'guest' follows. Can change via takeOverAsHost() or demotion. */
  get role(): SessionRole {
    return this._role;
  }
  get isHost(): boolean {
    return this._role === 'host';
  }
  /** Latest snapshot (null until a guest hears from a host). Replaced, not mutated, on guests. */
  get snapshot(): Snapshot | null {
    return this._snapshot;
  }
  get status(): SessionStatus {
    return this._status;
  }
  /** Seat this client plays (= engine player id), or null when watching. */
  get selfSeat(): number | null {
    return this._snapshot ? seatOf(this._snapshot, this.clientId) : null;
  }
  /** Other connections in the room (any role). */
  get peers(): number {
    return this.peerSet.size;
  }
  /** Reason the most recent own action was refused (also passed to listeners when it happens). */
  get lastRejection(): string | null {
    return this._lastRejection;
  }
  /** Latest network-level problem from the transport, e.g. no signalling relay reachable. */
  get networkError(): string | null {
    return this._networkError;
  }

  /** Listen for changes. Returns an unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // ----- playing -----

  /** Ask the host to do something for this client's seat. Refusals arrive via listeners / lastRejection. */
  send(intent: Intent) {
    if (this._role === 'host') this.local(applyIntent(this.snap, this.selfSeat, intent));
    else this.toHost({ t: 'intent', intent });
  }

  // ----- lobby (any client, for its own seat) -----

  /** Sit in an open seat (moves you if you already have one). Lobby only. */
  claimSeat(seat: number) {
    this.lobby({ op: 'claim', seat });
  }
  /** Leave your seat and watch instead. Lobby only. */
  releaseSeat() {
    this.lobby({ op: 'release' });
  }
  /** Change your display name; also renames your seat in the lobby. */
  setName(name: string) {
    const clean = cleanName(name);
    if (!clean) return this.reject('Names are 1-16 characters');
    this.name = clean;
    if (this.selfSeat !== null) this.lobby({ op: 'name', name: clean });
    else if (this._role === 'guest' && this.hostPeer) this.sendHello();
  }
  /** Pick a role for your seat; must not be taken by another seat. Lobby only. */
  setRole(roleId: string) {
    this.lobby({ op: 'role', roleId });
  }

  // ----- host only (guests get a rejection) -----

  /** Add an open seat (up to the max players). Lobby only. */
  addSeat() {
    this.hostOnly(addSeat);
  }
  /** Remove a seat; later seats move up. Lobby only. */
  removeSeat(seat: number) {
    this.hostOnly((t) => removeSeat(t, seat));
  }
  /** Make a seat open or a bot, rename it, or change its role. Lobby only. */
  setSeat(seat: number, patch: { kind?: 'open' | 'bot'; name?: string; roleId?: string }) {
    this.hostOnly((t) => setSeat(t, seat, patch));
  }
  /** Rounds before the game ends by net worth (0 = no limit). Lobby only. */
  setRoundLimit(rounds: number) {
    this.hostOnly((t) => setRoundLimit(t, rounds));
  }
  /** Start the game. Every seat must be a human or a bot. */
  start() {
    this.hostOnly((t) => startGame(t, this.seed()));
  }
  /** Mid-game: hand a remote player's seat to a bot. They get it back automatically when they reconnect. */
  convertToBot(seat: number) {
    this.hostOnly((t) => convertToBot(t, seat));
  }

  // ----- host changes -----

  /**
   * Become the host of this room from the last snapshot (hostEpoch + 2, so it also beats the old
   * host resuming from its save at + 1). Others follow the highest epoch; ties go to the lowest
   * clientId; a host that sees a higher one turns itself into a guest. Manual on purpose.
   */
  takeOverAsHost() {
    if (this._role === 'host') return this.reject('You are already the host');
    if (!this._snapshot) return this.reject('Nothing to take over yet');
    const s = structuredClone(this._snapshot);
    s.hostEpoch += 2;
    this.becomeHost(s);
  }

  /** Leave the room. A host also drops its save (a deliberate exit, unlike a reload). */
  leave() {
    if (this._status === 'closed') return;
    clearTimeout(this.botTimer);
    if (this._role === 'host') this.st.remove(HOST_SAVE_KEY);
    this._status = 'closed';
    this.transport.leave();
    this.emit();
  }

  // ----- internals -----

  private get snap(): Snapshot {
    return this._snapshot!;
  }

  private live() {
    return this._status !== 'closed';
  }

  private emit(rejected?: string) {
    for (const l of [...this.listeners]) l(rejected);
  }

  private reject(reason: string) {
    this._lastRejection = reason;
    this.emit(reason);
  }

  private local(r: Result) {
    if (r.ok) this.commit();
    else this.reject(r.reason);
  }

  private hostOnly(fn: (t: Snapshot) => Result) {
    if (this._role !== 'host') return this.reject('Only the host can do that');
    this.local(fn(this.snap));
  }

  private lobby(op: LobbyOp) {
    if (this._role === 'host') this.local(applyLobbyOp(this.snap, this.clientId, op, this.name));
    else this.toHost({ t: 'lobby', op });
  }

  private toHost(msg: Message) {
    if (!this.hostPeer || this._status !== 'connected') return this.reject('Not connected to the host');
    this.transport.send(msg, this.hostPeer);
  }

  private sendHello() {
    if (this.hostPeer) this.transport.send({ t: 'hello', v: PROTOCOL_VERSION, key: this.key, name: this.name }, this.hostPeer);
  }

  private snapshotMsg(): HostMessage {
    return { t: 'snapshot', snapshot: this.snap };
  }

  /** Host: persist, broadcast, keep bots moving, notify. */
  private commit() {
    this.st.set(HOST_SAVE_KEY, JSON.stringify({ roomCode: this.roomCode, snapshot: this.snap }));
    this.transport.send(this.snapshotMsg());
    this.scheduleBot();
    this.emit();
  }

  private scheduleBot() {
    clearTimeout(this.botTimer);
    if (this._role !== 'host' || !needsBotStep(this.snap)) return;
    this.botTimer = setTimeout(() => {
      if (this._role === 'host' && this.live() && stepBot(this.snap)) this.commit();
    }, this.botDelayMs);
  }

  private becomeHost(s: Snapshot) {
    s.hostId = this.clientId;
    s.rev += 1;
    resetPresence(s);
    setConnected(s, this.clientId, true);
    this._role = 'host';
    this._snapshot = s;
    this._status = 'connected';
    this.hostPeer = null;
    this.peerClients.clear();
    this.helloNames.clear();
    this.commit();
  }

  private demote(s: Snapshot, from: string) {
    clearTimeout(this.botTimer);
    this.st.remove(HOST_SAVE_KEY);
    this._role = 'guest';
    this.peerClients.clear();
    this.helloNames.clear();
    this.follow(s, from);
  }

  /** Guest: adopt a host's snapshot; say hello when the host changed or came back. */
  private follow(s: Snapshot, from: string) {
    const hello = from !== this.hostPeer || this._status !== 'connected';
    this._snapshot = s;
    this.hostPeer = from;
    this._status = 'connected';
    if (hello) this.sendHello();
    this.emit();
  }

  private peerJoined(p: string) {
    this.peerSet.add(p);
    if (this._role === 'host') this.transport.send(this.snapshotMsg(), p);
    this.emit();
  }

  private peerLeft(p: string) {
    this.peerSet.delete(p);
    if (this._role === 'host') {
      const id = this.peerClients.get(p);
      this.peerClients.delete(p);
      const stillHere = id !== undefined && [...this.peerClients.values()].includes(id);
      if (id !== undefined && !stillHere && setConnected(this.snap, id, false).ok) return this.commit();
    } else if (p === this.hostPeer) {
      this._status = 'host-lost';
    }
    this.emit();
  }

  private received(msg: Message, from: string) {
    if (msg.t === 'snapshot') return this.receivedSnapshot(msg.snapshot, from);
    if (this._role === 'guest') {
      if (msg.t === 'reject' && from === this.hostPeer) this.reject(msg.reason);
      return;
    }
    // Host from here on.
    const send = (m: HostMessage) => this.transport.send(m, from);
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) return send({ t: 'reject', reason: 'The host runs a different version of the game. Reload the page.' });
      const id = clientIdFromKey(msg.key);
      this.peerClients.set(from, id);
      this.helloNames.set(id, msg.name);
      if (setConnected(this.snap, id, true).ok) this.commit();
      else send(this.snapshotMsg());
      return;
    }
    const id = this.peerClients.get(from);
    if (id === undefined || msg.t === 'reject') return; // no hello yet, or not meant for a host
    const r = msg.t === 'intent'
      ? applyIntent(this.snap, seatOf(this.snap, id), msg.intent)
      : applyLobbyOp(this.snap, id, msg.op, this.helloNames.get(id) ?? 'Player');
    if (r.ok) this.commit();
    else send({ t: 'reject', reason: r.reason });
  }

  private receivedSnapshot(s: Snapshot, from: string) {
    const cur = this._snapshot;
    if (this._role === 'host') {
      if (outranks(s, this.snap)) this.demote(s, from);
      else if (outranks(this.snap, s)) this.transport.send(this.snapshotMsg(), from); // tell the rival to stand down
      return;
    }
    const sameHost = cur && s.hostEpoch === cur.hostEpoch && s.hostId === cur.hostId;
    if (!cur || outranks(s, cur) || (sameHost && from === this.hostPeer && s.rev >= cur.rev)) this.follow(s, from);
  }
}

/**
 * Host a room on `transport`. Starts a lobby with you in seat 0 and one open seat, or continues
 * `resume` (from `loadHostSave()`) with hostEpoch + 1 so guests switch to this new connection.
 */
export function hostSession(opts: SessionOptions & { resume?: Snapshot }): Session {
  return new Session(opts, 'host', opts.resume);
}

/** Join a room as a guest. You watch until you claim a seat; a returning player gets their seat back. */
export function joinSession(opts: SessionOptions): Session {
  return new Session(opts, 'guest');
}
