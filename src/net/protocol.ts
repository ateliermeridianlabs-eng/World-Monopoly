// Wire protocol for online play: message types, the host's snapshot, and runtime validators.
// Every inbound message is untrusted (anyone with the room code can send anything), so each
// parser returns a fresh, cleaned object or null. Parsers never throw.

import { BOARD, CARDS, RULES, roleById } from '../engine/data';
import { HOTEL } from '../engine/game';
import type { GameState, TradeOffer } from '../engine/types';

/** Bumped when the wire format changes; a host rejects guests with another version. */
/** 2: `Snapshot.pendingTrade` became the list `pendingTrades`; trades are allowed at any time. */
export const PROTOCOL_VERSION = 2;
/** Same cap as the name inputs in the hot-seat UI. */
export const NAME_MAX = 16;

// ---------- intents (guest or host-local player -> host authority) ----------

/** Something a seated player wants to do. Only the host applies intents to the game. */
export type Intent =
  | { type: 'roll' }
  | { type: 'buy' }
  /** Build one level on a city square (board index). */
  | { type: 'build'; index: number }
  /** Sell one building level on a city square (board index). */
  | { type: 'sell'; index: number }
  /** Fly to another airport square (board index). */
  | { type: 'fly'; dest: number }
  | { type: 'endTurn' }
  /** Any seated player offers a trade at any time (one outstanding offer each). `offer.from` must be the sender's seat. */
  | { type: 'proposeTrade'; offer: TradeOffer }
  /** Target of an offer answers it. `tradeId` must match that offer's `Snapshot.pendingTrades[].id`. */
  | { type: 'respondTrade'; tradeId: number; accept: boolean }
  /** Proposer withdraws their outstanding offer. */
  | { type: 'cancelTrade' }
  /** End the game now by net worth. Only the host's own seat may send this. */
  | { type: 'finish' };

// ---------- lobby ----------

/** Lobby changes a guest (or the host, for its own seat) may make to its own seat. */
export type LobbyOp =
  | { op: 'claim'; seat: number }
  | { op: 'release' }
  | { op: 'name'; name: string }
  | { op: 'role'; roleId: string };

export type SeatKind = 'open' | 'human' | 'bot';

export interface Seat {
  kind: SeatKind;
  /** '' for open seats. */
  name: string;
  /** Always set, unique across seats, so the role picker can grey out taken roles. */
  roleId: string;
  /**
   * Public id of the human who owns the seat (see `clientIdFromKey`), else null. A bot seat that
   * replaced a disconnected human keeps that human's id so they get the seat back on return.
   */
  clientId: string | null;
  /** Human: a live connection to the host (the host's own seat is always true). Bot: true. Open: false. */
  connected: boolean;
}

export interface PendingTrade {
  /** Unique across offers (the host's rev at proposal time + 1); `respondTrade` must quote it so a stale answer cannot accept a newer offer. */
  id: number;
  offer: TradeOffer;
}

/** Full room state. The host broadcasts it after every change; guests only render it. */
export interface Snapshot {
  /** Increases with every change made by the same host. */
  rev: number;
  /** Increases when a host resumes (+1) or a guest takes over (+2). The highest epoch is the real host. */
  hostEpoch: number;
  /** clientId of the host that produced this snapshot; breaks ties between hosts with equal epochs (lowest wins). */
  hostId: string;
  phase: 'lobby' | 'playing';
  /** Seat index equals engine player id once the game starts. */
  seats: Seat[];
  /** null in the lobby. Stays set after game over (`game.phase === 'gameOver'`). */
  game: GameState | null;
  /** Human-to-human offers waiting for their targets' answers: at most one per proposer, so at most `seats.length`. Not part of GameState. */
  pendingTrades: PendingTrade[];
  /** Rounds before the game ends by net worth; 0 = no limit. */
  roundLimit: number;
}

// ---------- messages ----------

export type GuestMessage =
  /** First message to a host. `key` is the guest's private key; the host derives the public clientId from it. */
  | { t: 'hello'; v: number; key: string; name: string }
  | { t: 'intent'; intent: Intent }
  | { t: 'lobby'; op: LobbyOp };

export type HostMessage =
  | { t: 'snapshot'; snapshot: Snapshot }
  /** The host refused the sender's last intent or lobby op; `reason` is the engine's error text or a lobby rule. */
  | { t: 'reject'; reason: string };

export type Message = GuestMessage | HostMessage;

// ---------- validation helpers ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIntArray = (v: unknown, min: number, max: number, maxLen: number): v is number[] =>
  Array.isArray(v) && v.length <= maxLen && v.every((x) => isInt(x, min, max));
const LAST_SQUARE = BOARD.length - 1;
const MAX_SEATS = RULES.players.max;
const CONTROL = /[\u0000-\u001f\u007f]/;
const KEY_RE = /^[A-Za-z0-9]{16,64}$/;
const ID_RE = /^[0-9a-f]{16}$/;
/** Player colours end up in inline styles, so only plain hex colours are accepted. */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_TEXT = 4000;

/** Trims a display name; returns null when empty, longer than NAME_MAX, or containing control characters. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return name.length > 0 && name.length <= NAME_MAX && !CONTROL.test(name) ? name : null;
}

function parseOffer(v: unknown): TradeOffer | null {
  if (!isObj(v)) return null;
  const { from, to, give, get, cash } = v;
  if (!isInt(from, 0, MAX_SEATS - 1) || !isInt(to, 0, MAX_SEATS - 1)) return null;
  if (!isIntArray(give, 0, LAST_SQUARE, BOARD.length) || !isIntArray(get, 0, LAST_SQUARE, BOARD.length)) return null;
  if (new Set(give).size !== give.length || new Set(get).size !== get.length) return null;
  // The engine's validateTrade lets NaN and fractions through, so the wire format must not.
  if (!isInt(cash, -1e9, 1e9)) return null;
  return { from, to, give: [...give], get: [...get], cash };
}

/** Validates an intent. Returns a clean copy or null. */
export function parseIntent(v: unknown): Intent | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'roll':
    case 'buy':
    case 'endTurn':
    case 'cancelTrade':
    case 'finish':
      return { type: v.type };
    case 'build':
    case 'sell':
      return isInt(v.index, 0, LAST_SQUARE) ? { type: v.type, index: v.index } : null;
    case 'fly':
      return isInt(v.dest, 0, LAST_SQUARE) ? { type: 'fly', dest: v.dest } : null;
    case 'proposeTrade': {
      const offer = parseOffer(v.offer);
      return offer ? { type: 'proposeTrade', offer } : null;
    }
    case 'respondTrade':
      return isInt(v.tradeId, 0, Number.MAX_SAFE_INTEGER) && isBool(v.accept) ? { type: 'respondTrade', tradeId: v.tradeId, accept: v.accept } : null;
    default:
      return null;
  }
}

/** Validates a lobby op. Returns a clean copy or null. */
export function parseLobbyOp(v: unknown): LobbyOp | null {
  if (!isObj(v)) return null;
  switch (v.op) {
    case 'claim':
      return isInt(v.seat, 0, MAX_SEATS - 1) ? { op: 'claim', seat: v.seat } : null;
    case 'release':
      return { op: 'release' };
    case 'name': {
      const name = cleanName(v.name);
      return name ? { op: 'name', name } : null;
    }
    case 'role':
      return typeof v.roleId === 'string' && roleById.has(v.roleId) ? { op: 'role', roleId: v.roleId } : null;
    default:
      return null;
  }
}

function validSeat(v: unknown): v is Seat {
  if (!isObj(v)) return false;
  if (v.kind !== 'open' && v.kind !== 'human' && v.kind !== 'bot') return false;
  const nameOk = v.kind === 'open' ? v.name === '' : cleanName(v.name) === v.name;
  return nameOk && typeof v.roleId === 'string' && roleById.has(v.roleId) &&
    (v.clientId === null || (typeof v.clientId === 'string' && ID_RE.test(v.clientId))) && isBool(v.connected);
}

const isRecordOf = (v: unknown, valueOk: (x: unknown) => boolean) =>
  isObj(v) && Object.keys(v).every((k) => /^\d{1,3}$/.test(k) && Number(k) <= LAST_SQUARE && valueOk(v[k]));

/** Structural check of a GameState, so a hostile "host" cannot crash a guest's renderer. */
export function validGameState(v: unknown, playerCount: number): v is GameState {
  if (!isObj(v) || v.version !== 2) return false;
  const players = v.players;
  if (!Array.isArray(players) || players.length !== playerCount) return false;
  const playersOk = players.every((p, i) =>
    isObj(p) && p.id === i && cleanName(p.name) === p.name && typeof p.color === 'string' && COLOR_RE.test(p.color) && isBool(p.isBot) &&
    typeof p.roleId === 'string' && roleById.has(p.roleId) && Number.isFinite(p.cash) && isInt(p.position, 0, LAST_SQUARE) &&
    isInt(p.laps, 0, 1e6) && isBool(p.bankrupt) && isBool(p.skipNextTurn) && isBool(p.skipAirportIncome));
  if (!playersOk) return false;
  const ev = v.lastEvent;
  return isRecordOf(v.owners, (x) => isInt(x, 0, playerCount - 1)) &&
    isRecordOf(v.levels, (x) => isInt(x, 0, HOTEL)) &&
    isInt(v.current, 0, playerCount - 1) &&
    (v.phase === 'roll' || v.phase === 'action' || v.phase === 'gameOver') &&
    isInt(v.turn, 1, 1e6) && isInt(v.roundLimit, 0, 1e6) &&
    (v.dice === null || isIntArray(v.dice, 1, RULES.dice.sides, RULES.dice.count)) &&
    (v.pendingBuy === null || isInt(v.pendingBuy, 0, LAST_SQUARE)) &&
    isBool(v.canFly) &&
    (ev === null || (isObj(ev) && isStr(ev.title, MAX_TEXT) && isStr(ev.text, MAX_TEXT) && ['good', 'bad', 'neutral', 'disaster'].includes(ev.kind as string))) &&
    isIntArray(v.deck, 0, CARDS.length - 1, CARDS.length) &&
    isInt(v.rng, -(2 ** 31), 2 ** 31 - 1) &&
    (v.winner === null || isInt(v.winner, 0, playerCount - 1)) &&
    Array.isArray(v.log) && v.log.length <= 1000 && v.log.every((l) => isStr(l, MAX_TEXT));
}

/** Validates a snapshot (from the wire or from storage). Returns it or null. */
export function parseSnapshot(v: unknown): Snapshot | null {
  if (!isObj(v)) return null;
  const { rev, hostEpoch, hostId, phase, seats, game, pendingTrades, roundLimit } = v;
  if (!isInt(rev, 0, Number.MAX_SAFE_INTEGER) || !isInt(hostEpoch, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof hostId !== 'string' || !ID_RE.test(hostId) || !isInt(roundLimit, 0, 999)) return null;
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS || !seats.every(validSeat)) return null;
  if (!Array.isArray(pendingTrades) || pendingTrades.length > seats.length) return null;
  if (phase === 'lobby') {
    if (game !== null || pendingTrades.length) return null;
  } else if (phase === 'playing') {
    if (!validGameState(game, seats.length)) return null;
    const ids = new Set<number>();
    const proposers = new Set<number>();
    for (const pt of pendingTrades) {
      if (!isObj(pt) || !isInt(pt.id, 0, Number.MAX_SAFE_INTEGER) || ids.has(pt.id)) return null;
      const offer = parseOffer(pt.offer);
      if (!offer || offer.from >= seats.length || offer.to >= seats.length || offer.from === offer.to || proposers.has(offer.from)) return null;
      ids.add(pt.id);
      proposers.add(offer.from);
    }
  } else {
    return null;
  }
  return v as unknown as Snapshot;
}

/** Validates any inbound message. Returns a clean message or null (ignore it). */
export function parseMessage(raw: unknown): Message | null {
  try {
    if (!isObj(raw)) return null;
    switch (raw.t) {
      case 'hello': {
        const name = cleanName(raw.name);
        if (!isInt(raw.v, 0, 1e6) || typeof raw.key !== 'string' || !KEY_RE.test(raw.key) || !name) return null;
        return { t: 'hello', v: raw.v, key: raw.key, name };
      }
      case 'intent': {
        const intent = parseIntent(raw.intent);
        return intent ? { t: 'intent', intent } : null;
      }
      case 'lobby': {
        const op = parseLobbyOp(raw.op);
        return op ? { t: 'lobby', op } : null;
      }
      case 'snapshot': {
        const snapshot = parseSnapshot(raw.snapshot);
        return snapshot ? { t: 'snapshot', snapshot } : null;
      }
      case 'reject':
        return isStr(raw.reason, 500) ? { t: 'reject', reason: raw.reason } : null;
      default:
        return null;
    }
  } catch {
    // e.g. a getter or proxy that throws; JSON from a real transport cannot do this, but stay safe.
    return null;
  }
}

// ---------- identity ----------

/**
 * Public id for a private client key: the first 16 hex chars of SHA-256(key). Snapshots show only
 * the public id, so seeing a snapshot does not let anyone claim someone else's seat, and a guest
 * that takes over as host can still verify returning players without knowing their keys.
 */
export function clientIdFromKey(key: string): string {
  return sha256Hex(key).slice(0, 16);
}

// Small synchronous SHA-256 (crypto.subtle is async only). Checked against node:crypto in tests.
const frac = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const K = PRIMES.map((p) => frac(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => frac(Math.sqrt(p)));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(size);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(size - 4, bytes.length * 8);
  const h = H0.slice();
  const w = new Array<number>(64);
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 64; i++) {
      if (i < 16) w[i] = view.getUint32(off + i * 4);
      else {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => (h[i] = (h[i] + x) | 0));
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
