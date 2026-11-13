import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRPORTS, SEAPORTS, createGame, endTurn as engineEndTurn, roll as engineRoll, buy as engineBuy, sectionCities, square } from '../src/engine/game';
import { botStep } from '../src/engine/bot';
import type { GameState } from '../src/engine/types';
import {
  applyIntent, applyLobbyOp, clientIdFromKey, convertToBot, createMemoryTransportHub, createTable, hostSession, joinSession,
  PROTOCOL_VERSION, formatRoomCode, loadHostSave, needsBotStep, newRoomCode, normalizeRoomCode, parseIntent, parseMessage, roomCodeFromHash, roomLink, setSeat,
  startGame, stepBot, turnFromEnv,
} from '../src/net';
import type { Intent, Session, Snapshot, StorageLike } from '../src/net';
import { sha256Hex } from '../src/net/protocol';

// ---------- helpers ----------

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

const ROOM = 'ABCDEFGHJKMN';
const BOT_MS = 100;

/** Host "Hana" plus guests, all on one in-memory hub. */
async function setup(guestNames: string[]) {
  const hub = createMemoryTransportHub();
  const hostStore = fakeStorage();
  const hostLink = hub.connect('host');
  const host = hostSession({ transport: hostLink, roomCode: ROOM, name: 'Hana', storage: hostStore, botDelayMs: BOT_MS, seed: () => 42 });
  const stores = guestNames.map(() => fakeStorage());
  const links = guestNames.map((name) => hub.connect(name));
  const guests = guestNames.map((name, i) =>
    joinSession({ transport: links[i], roomCode: ROOM, name, storage: stores[i], botDelayMs: BOT_MS, seed: () => 42 }));
  await flush();
  /** Drops a connection without session.leave(), like a crash or a reload. */
  const drop = async (i: number | 'host') => {
    (i === 'host' ? hostLink : links[i]).leave();
    await flush();
  };
  return { hub, host, hostStore, guests, stores, drop };
}

/** Host + Gus (seat 1) + Ivy (seat 2) + a bot (seat 3), started. */
async function startedGame(roundLimit = 60) {
  const r = await setup(['Gus', 'Ivy']);
  const [gus, ivy] = r.guests;
  gus.claimSeat(1);
  r.host.addSeat();
  await flush();
  ivy.claimSeat(2);
  r.host.addSeat();
  r.host.setSeat(3, { kind: 'bot' });
  r.host.setRoundLimit(roundLimit);
  await flush();
  r.host.start();
  await flush();
  return { ...r, gus, ivy };
}

const game = (s: Session) => s.snapshot!.game!;

function expectInSync(host: Session, others: Session[]) {
  for (const s of others) expect(s.snapshot).toEqual(host.snapshot);
}

/** Plays one step for whoever's turn it is: roll, buy if affordable, else end turn. Bots advance the clock. */
async function playStep(host: Session, clients: Session[]) {
  const g = game(host);
  const seat = host.snapshot!.seats[g.current];
  if (seat.kind === 'bot') {
    await vi.advanceTimersByTimeAsync(BOT_MS);
    await flush();
    return;
  }
  const who = clients.find((c) => c.clientId === seat.clientId)!;
  const p = g.players[g.current];
  let intent: Intent;
  if (g.phase === 'roll') intent = { type: 'roll' };
  else if (g.pendingBuy !== null && p.cash - (square(g.pendingBuy).price ?? 0) > 300) intent = { type: 'buy' };
  else intent = { type: 'endTurn' };
  who.send(intent);
  await flush();
  expect(who.lastRejection).toBeNull();
}

// ---------- protocol ----------

describe('protocol', () => {
  it('hashes like node:crypto and derives 16-hex client ids', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'y'.repeat(130), 'héllo 🎲']) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
    expect(clientIdFromKey('ABCDEFGHJKLMNPQRSTUVWXYZ23')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects malformed, out-of-range and oversized messages without throwing', () => {
    const bad: unknown[] = [
      null, 42, 'roll', [], {}, { t: 'nope' },
      { t: 'hello', v: 1, key: 'short', name: 'A' },
      { t: 'hello', v: 1, key: 'K'.repeat(26), name: 'x'.repeat(17) },
      { t: 'hello', v: 1, key: 'K'.repeat(26), name: '   ' },
      { t: 'hello', v: 1, key: 'K'.repeat(26), name: 'a\u0000b' },
      { t: 'intent', intent: { type: 'build', index: 1.5 } },
      { t: 'intent', intent: { type: 'build', index: -1 } },
      { t: 'intent', intent: { type: 'sell', index: 144 } },
      { t: 'intent', intent: { type: 'fly', dest: '5' } },
      { t: 'intent', intent: { type: 'fly', dest: null } },
      { t: 'intent', intent: { type: 'sail', dest: '16' } },
      { t: 'intent', intent: { type: 'sail', dest: null } },
      { t: 'intent', intent: { type: 'sail', dest: -1 } },
      { t: 'intent', intent: { type: 'sail', dest: 144 } },
      { t: 'intent', intent: { type: 'sail', dest: 16.5 } },
      { t: 'intent', intent: { type: 'sail' } },
      { t: 'intent', intent: { type: 'teleport' } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: 0, to: 1, give: [1], get: [], cash: 0.5 } } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: 0, to: 9, give: [1], get: [], cash: 0 } } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: 0, to: 1, give: [1, 1], get: [], cash: 0 } } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: 0, to: 1, give: Array(500).fill(1), get: [], cash: 0 } } },
      { t: 'intent', intent: { type: 'respondTrade', tradeId: 1, accept: 'yes' } },
      { t: 'intent', intent: { type: 'respondTrade', tradeId: -1, accept: true } },
      { t: 'intent', intent: { type: 'respondTrade', tradeId: 1.5, accept: true } },
      { t: 'intent', intent: { type: 'respondTrade', accept: true } },
      { t: 'intent', intent: { type: 'proposeTrade' } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: 0, to: 1, give: [1], get: [], cash: Number.NaN } } },
      { t: 'intent', intent: { type: 'proposeTrade', offer: { from: -1, to: 1, give: [1], get: [], cash: 0 } } },
      { t: 'lobby', op: { op: 'role', roleId: 'king' } },
      { t: 'lobby', op: { op: 'claim', seat: 6 } },
      { t: 'lobby', op: { op: 'name', name: 'x'.repeat(40) } },
      { t: 'snapshot', snapshot: { rev: 1 } },
      { t: 'reject', reason: 'x'.repeat(10_000) },
      JSON.parse('{"t":"intent","intent":{"__proto__":{"type":"roll"}}}'),
    ];
    for (const m of bad) expect(parseMessage(m)).toBeNull();
    const evil = { get t() { throw new Error('boom'); } };
    expect(parseMessage(evil)).toBeNull();
  });

  it('accepts only hex player colours in a snapshot (they reach inline styles)', () => {
    const t = createTable('0123456789abcdef', 'Hana');
    setSeat(t, 1, { kind: 'bot' });
    startGame(t, 1);
    expect(parseMessage({ t: 'snapshot', snapshot: JSON.parse(JSON.stringify(t)) })).not.toBeNull();
    for (const color of ['red;background-image:url(https://x.example/t)', '"><img src=x onerror=alert(1)>', '#12345', '']) {
      const bad = JSON.parse(JSON.stringify(t));
      bad.game.players[0].color = color;
      expect(parseMessage({ t: 'snapshot', snapshot: bad })).toBeNull();
    }
  });

  it('validates pendingTrades in snapshots', () => {
    const t = createTable('0123456789abcdef', 'Hana');
    setSeat(t, 1, { kind: 'bot' });
    startGame(t, 1);
    const offer = { from: 0, to: 1, give: [], get: [sectionCities('usa')[0]], cash: 5 };
    const snap = (pendingTrades: unknown) => ({ t: 'snapshot', snapshot: { ...JSON.parse(JSON.stringify(t)), pendingTrades } });
    expect(parseMessage(snap([]))).not.toBeNull();
    expect(parseMessage(snap([{ id: 3, offer }]))).not.toBeNull();
    expect(parseMessage(snap([{ id: 3, offer }, { id: 4, offer: { ...offer, from: 1, to: 0 } }]))).not.toBeNull();
    for (const bad of [
      null, undefined, {}, [{ id: -1, offer }], [{ id: 1.5, offer }], [{ id: 1 }], [{ id: 1, offer: { ...offer, to: 5 } }],
      [{ id: 1, offer: { ...offer, to: 0 } }],                                                  // to self
      [{ id: 1, offer }, { id: 1, offer: { ...offer, from: 1, to: 0 } }],                       // duplicate id
      [{ id: 1, offer }, { id: 2, offer }],                                                     // two offers from one proposer
      [{ id: 1, offer }, { id: 2, offer: { ...offer, from: 1, to: 0 } }, { id: 3, offer }],     // more than seats
    ]) expect(parseMessage(snap(bad))).toBeNull();
    // The old single-offer field is not a valid snapshot any more, and the lobby cannot hold offers.
    const legacy = JSON.parse(JSON.stringify(t));
    delete legacy.pendingTrades;
    legacy.pendingTrade = null;
    expect(parseMessage({ t: 'snapshot', snapshot: legacy })).toBeNull();
    const lobby = { ...JSON.parse(JSON.stringify(createTable('0123456789abcdef', 'Hana'))), pendingTrades: [{ id: 1, offer }] };
    expect(parseMessage({ t: 'snapshot', snapshot: lobby })).toBeNull();
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it('returns clean copies without extra fields', () => {
    expect(parseIntent({ type: 'build', index: 3, extra: 'x' })).toEqual({ type: 'build', index: 3 });
    expect(parseIntent({ type: 'sail', dest: 143, via: 'x' })).toEqual({ type: 'sail', dest: 143 });
    expect(parseMessage({ t: 'hello', v: 1, key: 'K'.repeat(26), name: '  Ann  ' })).toEqual({ t: 'hello', v: 1, key: 'K'.repeat(26), name: 'Ann' });
  });

  it('makes and reads room codes', () => {
    for (let i = 0; i < 200; i++) expect(newRoomCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    expect(normalizeRoomCode('ABCDEFGHJKMN')).toBe('ABCDEFGHJKMN');
    expect(normalizeRoomCode(' abcd-efgh-jkmn ')).toBe('ABCDEFGHJKMN');
    expect(normalizeRoomCode('abcd efgh\tjkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeRoomCode('ab-cdefgh-jk mn')).toBe('ABCDEFGHJKMN');
    expect(normalizeRoomCode('ABC234')).toBeNull(); // old 6-character codes are not accepted
    expect(normalizeRoomCode('ABCDEFGHJKMNP')).toBeNull();
    expect(normalizeRoomCode('ABCDEFGHJKM0')).toBeNull();
    expect(formatRoomCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(normalizeRoomCode(formatRoomCode(newRoomCode()))).not.toBeNull();
    expect(roomCodeFromHash('#room=xyz7-89ab-cd23')).toBe('XYZ789ABCD23');
    expect(roomCodeFromHash('#room=XYZ789')).toBeNull();
    expect(roomCodeFromHash('')).toBeNull();
    expect(roomLink('XYZ789ABCD23', 'https://me.github.io/world-monopoly/?a=1#old')).toBe('https://me.github.io/world-monopoly/?a=1#room=XYZ789ABCD23');
  });

  it('reads TURN servers from env only when set', () => {
    expect(turnFromEnv({})).toEqual([]);
    expect(turnFromEnv({ VITE_TURN_URLS: ' , ' })).toEqual([]);
    expect(turnFromEnv({ VITE_TURN_URLS: 'turn:a.example:3478, turns:a.example:5349', VITE_TURN_USERNAME: 'u', VITE_TURN_CREDENTIAL: 'p' }))
      .toEqual([{ urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'u', credential: 'p' }]);
  });
});

// ---------- authority (no transport) ----------

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);

const C = 'c'.repeat(16);

/** Host A in seat 0, humans B (1) and C (2), a bot (3); started in the roll phase (A to move), with a city each (bot gets c3). */
function tradeTable() {
  const t = createTable(A, 'Ann');
  applyLobbyOp(t, B, { op: 'claim', seat: 1 }, 'Ben');
  t.seats.push({ kind: 'open', name: '', roleId: 'landlord', clientId: null, connected: false });
  applyLobbyOp(t, C, { op: 'claim', seat: 2 }, 'Cy');
  t.seats.push({ kind: 'bot', name: 'Bot', roleId: 'diplomat', clientId: null, connected: true });
  expect(startGame(t, 7)).toEqual({ ok: true });
  const g = t.game!;
  const [c0, c1, c2, c3] = sectionCities('usa');
  [c0, c1, c2, c3].forEach((c, i) => (g.owners[c] = i));
  return { t, g, c0, c1, c2, c3 };
}

const offerOf = (from: number, to: number, give: number[], get: number[], cash = 0): Intent => ({ type: 'proposeTrade', offer: { from, to, give, get, cash } });
const idOf = (t: Snapshot, from: number) => t.pendingTrades.find((p) => p.offer.from === from)!.id;

describe('authority: trades', () => {
  it('lets anyone propose at any time: on another player\'s turn and before rolling', () => {
    const { t, c0, c1, c2 } = tradeTable();
    expect(t.game!.current).toBe(0);
    expect(t.game!.phase).toBe('roll');
    // Ben and Cy offer while it is Ann's turn and she has not rolled.
    expect(applyIntent(t, 1, offerOf(1, 0, [c1], [c0], 20))).toEqual({ ok: true });
    expect(applyIntent(t, 2, offerOf(2, 1, [c2], [], 0))).toEqual({ ok: true });
    expect(t.pendingTrades.map((p) => [p.offer.from, p.offer.to])).toEqual([[1, 0], [2, 1]]);
    // Ann herself can also offer before rolling.
    expect(applyIntent(t, 0, offerOf(0, 2, [c0], [], 0))).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(3);
    expect(new Set(t.pendingTrades.map((p) => p.id)).size).toBe(3);
  });

  it('keeps wire-level checks: own properties only, valid offers, one outstanding offer each', () => {
    const { t, c0, c1 } = tradeTable();
    expect(applyIntent(t, 1, offerOf(0, 1, [c0], [], 0))).toEqual({ ok: false, reason: 'You can only offer your own properties' });
    expect(applyIntent(t, 0, offerOf(0, 1, [c1], [], 0))).toEqual({ ok: false, reason: 'Ann does not own all offered properties' });
    expect(applyIntent(t, 0, offerOf(0, 0, [c0], [], 0)).ok).toBe(false);
    expect(applyIntent(t, 0, offerOf(0, 1, [c0], [c1], 50))).toEqual({ ok: true });
    const again = applyIntent(t, 0, offerOf(0, 2, [c0], [], 0));
    expect(again).toEqual({ ok: false, reason: 'You already have a trade offer out. Cancel it first' });
    expect(t.pendingTrades).toHaveLength(1);
    // Cancelling frees the slot.
    expect(applyIntent(t, 0, { type: 'cancelTrade' })).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(0);
    expect(applyIntent(t, 0, offerOf(0, 2, [c0], [], 0))).toEqual({ ok: true });
  });

  it('answers only from the target, executes on accept and leaves other offers alone', () => {
    const { t, g, c0, c1, c2 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1], 50));
    applyIntent(t, 2, offerOf(2, 0, [c2], [], 0)); // Cy gives Ann a city for nothing
    const id = idOf(t, 0);
    const other = idOf(t, 2);
    expect(applyIntent(t, 0, { type: 'respondTrade', tradeId: id, accept: true })).toEqual({ ok: false, reason: 'That trade is not for you' });
    expect(applyIntent(t, 2, { type: 'respondTrade', tradeId: id, accept: true })).toEqual({ ok: false, reason: 'That trade is not for you' });
    expect(applyIntent(t, 1, { type: 'respondTrade', tradeId: id + 1000, accept: true })).toEqual({ ok: false, reason: 'That trade is no longer on the table' });
    expect(applyIntent(t, 1, { type: 'cancelTrade' })).toEqual({ ok: false, reason: 'You have no pending trade' });
    const cash0 = t.game!.players[0].cash;
    expect(applyIntent(t, 1, { type: 'respondTrade', tradeId: id, accept: true })).toEqual({ ok: true });
    expect(t.pendingTrades.map((p) => p.id)).toEqual([other]);
    expect(t.game!.owners[c0]).toBe(1);
    expect(t.game!.owners[c1]).toBe(0);
    expect(t.game!.players[0].cash).toBe(cash0 - 50);
    expect(t.game!.log.some((l) => l.includes('🤝'))).toBe(true);
    expect(g).not.toBe(t.game); // actions run on a copy
    expect(applyIntent(t, 0, { type: 'respondTrade', tradeId: other, accept: true })).toEqual({ ok: true });
    expect(t.game!.owners[c2]).toBe(0);
    expect(t.pendingTrades).toHaveLength(0);
  });

  it('does not block the proposer\'s turn and survives the end of the turn', () => {
    const { t, c0, c1 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1], 0));
    const id = idOf(t, 0);
    expect(applyIntent(t, 0, { type: 'roll' })).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(1);
    expect(t.game!.phase).toBe('action');
    const g = t.game!;
    if (g.pendingBuy !== null) expect(applyIntent(t, 0, { type: 'buy' }).ok).toBe(true);
    expect(applyIntent(t, 0, { type: 'endTurn' })).toEqual({ ok: true });
    expect(t.game!.current).toBe(1);
    expect(t.pendingTrades.map((p) => p.id)).toEqual([id]);
    // Ben answers on his own turn, after Ann's turn ended.
    expect(applyIntent(t, 1, { type: 'respondTrade', tradeId: id, accept: true })).toEqual({ ok: true });
    expect(t.game!.owners[c0]).toBe(1);
  });

  it('declines, cancels, and refuses answers to old offers', () => {
    const { t, c0, c1 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1]));
    applyIntent(t, 1, { type: 'respondTrade', tradeId: idOf(t, 0), accept: false });
    expect(t.pendingTrades).toHaveLength(0);
    expect(t.game!.log.at(-1)).toBe("Ben declined Ann's trade.");
    expect(t.game!.owners[c0]).toBe(0);

    applyIntent(t, 0, offerOf(0, 1, [c0], [c1]));
    const oldId = idOf(t, 0);
    expect(applyIntent(t, 0, { type: 'cancelTrade' })).toEqual({ ok: true });
    expect(t.game!.log.at(-1)).toBe('Ann withdrew their trade offer.');
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1], 100));
    // An answer to the withdrawn offer must not accept the new one.
    expect(applyIntent(t, 1, { type: 'respondTrade', tradeId: oldId, accept: true })).toEqual({ ok: false, reason: 'That trade is no longer on the table' });
    expect(t.pendingTrades).toHaveLength(1);
    expect(t.game!.owners[c0]).toBe(0);
    // A decided offer's id is dead, too.
    const id = idOf(t, 0);
    applyIntent(t, 1, { type: 'respondTrade', tradeId: id, accept: false });
    expect(applyIntent(t, 1, { type: 'respondTrade', tradeId: id, accept: true }).ok).toBe(false);
  });

  it('re-validates on accept and drops the offer if it no longer works', () => {
    const { t, c0 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [], 500));
    const id = idOf(t, 0);
    t.game!.players[0].cash = 10; // e.g. changed by the host's own tooling
    const r = applyIntent(t, 1, { type: 'respondTrade', tradeId: id, accept: true });
    expect(r).toEqual({ ok: false, reason: 'Ann cannot afford $500' });
    expect(t.pendingTrades).toHaveLength(0);
    expect(t.game!.owners[c0]).toBe(0);
  });

  it('auto-cancels offers whose property changed hands, naming whose offer it was', () => {
    const { t, c0, c1, c2 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1])); // Ann -> Ben
    applyIntent(t, 2, offerOf(2, 0, [c2], [c0])); // Cy -> Ann, asks for the same c0
    expect(t.pendingTrades).toHaveLength(2);
    applyIntent(t, 1, { type: 'respondTrade', tradeId: idOf(t, 0), accept: true });
    expect(t.pendingTrades).toHaveLength(0);
    expect(t.game!.log.at(-1)).toBe("Cy's trade offer to Ann was cancelled.");
    expect(t.game!.owners[c2]).toBe(2);
  });

  it('auto-cancels offers when a party goes bankrupt', () => {
    const { t, c0, c1, c2 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1]));
    applyIntent(t, 2, offerOf(2, 0, [c2], []));
    t.game!.players[1].bankrupt = true; // as the engine would after a ruinous payment
    expect(applyIntent(t, 0, { type: 'roll' }).ok).toBe(true); // any change sweeps
    expect(t.pendingTrades.map((p) => p.offer.from)).toEqual([2]);
    expect(t.game!.log.some((l) => l === "Ann's trade offer to Ben was cancelled.")).toBe(true);
    // A bankrupt player cannot offer, and nobody can offer to them.
    expect(applyIntent(t, 1, offerOf(1, 0, [], [c0]))).toEqual({ ok: false, reason: 'You are bankrupt' });
    expect(applyIntent(t, 2, offerOf(2, 1, [c2], []))).toEqual({ ok: false, reason: 'You already have a trade offer out. Cancel it first' });
  });

  it('auto-cancels offers when a seat is handed to a bot, and resolves trades with bots at once', () => {
    const { t, c0, c1, c2, c3 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1]));
    applyIntent(t, 2, offerOf(2, 1, [c2], []));
    applyIntent(t, 1, offerOf(1, 2, [c1], []));
    expect(t.pendingTrades).toHaveLength(3);
    expect(convertToBot(t, 1)).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(0);
    expect(t.game!.log.filter((l) => l.endsWith('was cancelled.'))).toHaveLength(3);

    const stingy = applyIntent(t, 0, offerOf(0, 3, [], [c3]));
    expect(stingy.ok).toBe(false);
    expect(stingy.ok || stingy.reason).toContain('declined');
    expect(t.game!.owners[c3]).toBe(3);
    // Bots answer at once, on anyone's turn and before the roll.
    expect(applyIntent(t, 2, offerOf(2, 3, [c2], []))).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(0);
    expect(t.game!.owners[c2]).toBe(3);
    // Offers to a seat that is now a bot are answered by the bot instead of being left pending.
    expect(applyIntent(t, 0, offerOf(0, 1, [c0], []))).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(0);
  });

  it('drops every offer when the game ends and refuses trades afterwards', () => {
    const { t, c0, c1 } = tradeTable();
    applyIntent(t, 0, offerOf(0, 1, [c0], [c1]));
    expect(applyIntent(t, 0, { type: 'finish' })).toEqual({ ok: true });
    expect(t.pendingTrades).toHaveLength(0);
    expect(applyIntent(t, 1, offerOf(1, 0, [c1], []))).toEqual({ ok: false, reason: 'The game is over' });
  });

  it('refuses spectators and bot seats as proposers', () => {
    const { t, c0, c3 } = tradeTable();
    expect(applyIntent(t, null, offerOf(0, 1, [c0], []))).toEqual({ ok: false, reason: 'You do not have a seat' });
    expect(applyIntent(t, 3, offerOf(3, 0, [c3], []))).toEqual({ ok: false, reason: 'A bot plays this seat' });
    expect(t.pendingTrades).toHaveLength(0);
  });

  it('refuses bot seats, spectators and non-host finish', () => {
    const { t } = tradeTable();
    expect(applyIntent(t, null, { type: 'roll' })).toEqual({ ok: false, reason: 'You do not have a seat' });
    expect(applyIntent(t, 3, { type: 'roll' })).toEqual({ ok: false, reason: 'A bot plays this seat' });
    expect(applyIntent(t, 1, { type: 'roll' })).toEqual({ ok: false, reason: 'It is not your turn' });
    expect(applyIntent(t, 1, { type: 'finish' })).toEqual({ ok: false, reason: 'Only the host can end the game' });
    expect(applyIntent(t, 0, { type: 'finish' })).toEqual({ ok: true });
    expect(t.game!.phase).toBe('gameOver');
    expect(applyIntent(t, 0, { type: 'roll' })).toEqual({ ok: false, reason: 'The game is over' });
  });

  it('enforces lobby rules', () => {
    const t = createTable(A, 'Ann');
    expect(applyLobbyOp(t, B, { op: 'claim', seat: 0 }, 'Ben').ok).toBe(false);
    expect(applyLobbyOp(t, B, { op: 'role', roleId: 'banker' }, 'Ben')).toEqual({ ok: false, reason: 'You have no seat' });
    expect(applyLobbyOp(t, B, { op: 'claim', seat: 1 }, 'Ben').ok).toBe(true);
    expect(applyLobbyOp(t, B, { op: 'role', roleId: t.seats[0].roleId }, 'Ben')).toEqual({ ok: false, reason: 'Another seat has that role' });
    expect(setSeat(t, 1, { name: 'x'.repeat(17) }).ok).toBe(false);
    expect(startGame(t, 1).ok).toBe(true);
    expect(applyLobbyOp(t, B, { op: 'release' }, 'Ben')).toEqual({ ok: false, reason: 'The game has already started' });
  });
});

describe('determinism', () => {
  /** Same seed + same intents through the authority gives the same state as driving the engine directly. */
  function viaAuthority(seed: number) {
    const t = createTable(A, 'Ann');
    applyLobbyOp(t, B, { op: 'claim', seat: 1 }, 'Ben');
    t.seats.push({ kind: 'bot', name: 'Bot', roleId: 'diplomat', clientId: null, connected: true });
    startGame(t, seed);
    for (let k = 0; k < 400 && t.game!.phase !== 'gameOver'; k++) {
      if (needsBotStep(t)) {
        stepBot(t);
        continue;
      }
      const g = t.game!;
      applyIntent(t, g.current, g.phase === 'roll' ? { type: 'roll' } : g.pendingBuy !== null ? { type: 'buy' } : { type: 'endTurn' });
    }
    return t.game!;
  }
  function viaEngine(seed: number) {
    const g = createGame([
      { name: 'Ann', isBot: false, roleId: 'entrepreneur' },
      { name: 'Ben', isBot: false, roleId: 'banker' },
      { name: 'Bot', isBot: true, roleId: 'diplomat' },
    ], seed, 60);
    for (let k = 0; k < 400 && g.phase !== 'gameOver'; k++) {
      if (g.players[g.current].isBot) {
        botStep(g);
        continue;
      }
      try {
        if (g.phase === 'roll') engineRoll(g);
        else if (g.pendingBuy !== null) engineBuy(g);
        else engineEndTurn(g);
      } catch {
        /* same refusals as the authority */
      }
    }
    return g;
  }

  it('gives the same final state for the same seed and intents', () => {
    const a: GameState = viaAuthority(1234);
    expect(viaAuthority(1234)).toEqual(a);
    expect(viaEngine(1234)).toEqual(a);
    expect(viaAuthority(999)).not.toEqual(a);
  });
});

// ---------- sessions over the memory transport ----------

describe('sessions', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('runs a lobby: spectate, claim, unique roles, host-only controls, start', async () => {
    const { host, guests: [gus, ivy] } = await setup(['Gus', 'Ivy']);
    expect(host.role).toBe('host');
    expect(gus.status).toBe('connected');
    expect(gus.selfSeat).toBeNull();
    expect(gus.snapshot!.phase).toBe('lobby');

    gus.claimSeat(1);
    await flush();
    expect(gus.selfSeat).toBe(1);
    expect(host.snapshot!.seats[1]).toMatchObject({ kind: 'human', name: 'Gus', connected: true, clientId: gus.clientId });

    ivy.claimSeat(1);
    await flush();
    expect(ivy.lastRejection).toBe('That seat is taken');
    ivy.addSeat();
    expect(ivy.lastRejection).toBe('Only the host can do that');
    host.addSeat();
    await flush();
    ivy.claimSeat(2);
    ivy.setRole(host.snapshot!.seats[1].roleId);
    await flush();
    expect(ivy.lastRejection).toBe('Another seat has that role');
    ivy.setRole('landlord');
    ivy.setName('Ivy V');
    await flush();
    expect(host.snapshot!.seats[2]).toMatchObject({ name: 'Ivy V', roleId: 'landlord' });

    host.addSeat();
    host.start();
    expect(host.lastRejection).toBe('Fill or remove the open seats first');
    host.setSeat(3, { kind: 'bot', name: 'Robo' });
    host.setRoundLimit(5);
    host.start();
    await flush();
    expect(ivy.snapshot!.phase).toBe('playing');
    expect(game(ivy).players.map((p) => [p.name, p.isBot])).toEqual([['Hana', false], ['Gus', false], ['Ivy V', false], ['Robo', true]]);
    expect(game(ivy).roundLimit).toBe(5);
    expectInSync(host, [gus, ivy]);
  });

  it('plays a full game where every client matches the host after every step', async () => {
    const { host, gus, ivy } = await startedGame(6);
    const clients = [host, gus, ivy];
    let steps = 0;
    while (game(host).phase !== 'gameOver' && steps++ < 500) {
      await playStep(host, clients);
      expectInSync(host, [gus, ivy]);
    }
    expect(game(host).phase).toBe('gameOver');
    expect(steps).toBeGreaterThan(40);
    expect(game(host).turn).toBeGreaterThan(6);
    expect(game(host).log.some((l) => l.startsWith('Bot 4 rolled'))).toBe(true);
    expect(game(gus).winner).not.toBeNull();
    expect(Object.keys(game(host).owners).length).toBeGreaterThan(0);
  });

  it('rejects out-of-turn, wrong-seat and illegal intents with the reason', async () => {
    const { host, gus, ivy, hub } = await startedGame();
    const watcher = joinSession({ transport: hub.connect('watcher'), roomCode: ROOM, name: 'Wat', storage: fakeStorage() });
    await flush();
    expect(watcher.snapshot).toEqual(host.snapshot); // spectators get snapshots
    const rev = host.snapshot!.rev;
    gus.send({ type: 'roll' }); // seat 0 (host) is current
    watcher.send({ type: 'roll' });
    gus.send({ type: 'finish' });
    await flush();
    expect(gus.lastRejection).toBe('Only the host can end the game');
    expect(watcher.lastRejection).toBe('You do not have a seat');
    const seen: (string | undefined)[] = [];
    ivy.subscribe((r) => seen.push(r));
    ivy.send({ type: 'endTurn' });
    await flush();
    expect(seen).toContain('It is not your turn');
    host.send({ type: 'buy' });
    expect(host.lastRejection).toBe('nothing to buy'); // engine text
    host.send({ type: 'endTurn' });
    expect(host.lastRejection).toBe('roll first');
    expect(host.snapshot!.rev).toBe(rev);
    expectInSync(host, [gus, ivy, watcher]);
  });

  it('ignores malformed and hostile messages without crashing the host', async () => {
    const { host, gus, hub } = await startedGame();
    const evil = hub.connect('evil');
    const inbox: unknown[] = [];
    evil.onMessage((m) => inbox.push(m));
    await flush();
    const rev = host.snapshot!.rev;
    const junk: unknown[] = [
      null, 'hi', 7, [1, 2], { t: 'intent', intent: { type: 'roll' } }, // no hello yet
      { t: 'hello', v: PROTOCOL_VERSION, key: '!!', name: 'X' },
      { t: 'lobby', op: { op: 'claim', seat: 1 } },
      { t: 'snapshot', snapshot: { ...host.snapshot, hostEpoch: 99, game: { version: 1 } } },
      { t: 'snapshot', snapshot: { ...host.snapshot, hostEpoch: 99, seats: [] } },
      { t: 'intent', intent: { type: 'build', index: 1e9 } },
      { t: 'reject', reason: 'fake' },
    ];
    for (const m of junk) evil.send(m);
    evil.send({ t: 'hello', v: PROTOCOL_VERSION, key: 'E'.repeat(26), name: 'Eve' });
    evil.send({ t: 'intent', intent: { type: 'roll' } }); // valid shape, but a spectator
    evil.send({ t: 'intent', intent: { type: 'fly', dest: AIRPORTS[0] } });
    evil.send({ t: 'hello', v: PROTOCOL_VERSION - 1, key: 'E'.repeat(26), name: 'Eve' });
    await flush();
    expect(host.role).toBe('host');
    expect(host.snapshot!.rev).toBe(rev);
    expect(inbox).toContainEqual({ t: 'reject', reason: 'You do not have a seat' });
    expect(inbox).toContainEqual({ t: 'reject', reason: 'The host runs a different version of the game. Reload the page.' });
    expect(gus.lastRejection).toBeNull(); // rejections went only to the sender
    expect(gus.snapshot!.hostEpoch).toBe(host.snapshot!.hostEpoch);
    host.send({ type: 'roll' });
    await flush();
    expect(host.lastRejection).toBeNull();
    expectInSync(host, [gus]);
  });

  it('runs human-to-human trades over the wire', async () => {
    const { host, gus } = await startedGame();
    host.send({ type: 'roll' });
    await flush();
    // Give each a city directly on the host (setup only), then trade them.
    const [c0, c1] = sectionCities('africa');
    game(host).owners[c0] = 0;
    game(host).owners[c1] = 1;
    host.send({ type: 'proposeTrade', offer: { from: 0, to: 1, give: [c0], get: [c1], cash: 0 } });
    await flush();
    const pending = gus.snapshot!.pendingTrades[0];
    expect(pending.offer.to).toBe(gus.selfSeat);
    gus.send({ type: 'respondTrade', tradeId: pending.id, accept: true });
    await flush();
    expect(gus.lastRejection).toBeNull();
    expect(game(gus).owners[c0]).toBe(1);
    expect(game(gus).owners[c1]).toBe(0);
    expect(gus.snapshot!.pendingTrades).toEqual([]);
  });

  it('lets a guest offer on the host\'s turn before the roll, and several offers coexist over the wire', async () => {
    const { host, gus, ivy } = await startedGame();
    const [a, b, c] = sectionCities('africa');
    Object.assign(game(host).owners, { [a]: 0, [b]: 1, [c]: 2 });
    expect(game(host).current).toBe(0);
    expect(game(host).phase).toBe('roll');
    gus.send({ type: 'proposeTrade', offer: { from: 1, to: 2, give: [b], get: [c], cash: 0 } });
    ivy.send({ type: 'proposeTrade', offer: { from: 2, to: 0, give: [c], get: [a], cash: 0 } });
    host.send({ type: 'proposeTrade', offer: { from: 0, to: 1, give: [a], get: [], cash: 0 } });
    await flush();
    expect(host.lastRejection).toBeNull();
    expect(gus.lastRejection).toBeNull();
    expect(ivy.lastRejection).toBeNull();
    expect(host.snapshot!.pendingTrades).toHaveLength(3);
    expect(gus.snapshot!.pendingTrades).toEqual(host.snapshot!.pendingTrades);
    // Host rolls with its own offer open; a second offer from the host is refused.
    host.send({ type: 'roll' });
    host.send({ type: 'proposeTrade', offer: { from: 0, to: 2, give: [a], get: [], cash: 0 } });
    await flush();
    expect(game(host).phase).toBe('action');
    expect(host.lastRejection).toBe('You already have a trade offer out. Cancel it first');
    expect(host.snapshot!.pendingTrades).toHaveLength(3);
  });

  it('gives a reconnecting guest their seat back by client key, and never broadcasts the key', async () => {
    const { host, hub, guests: [gus], stores: [gusStore], drop } = await setup(['Gus']);
    gus.claimSeat(1);
    await flush();
    const key = gusStore.data.get('world-monopoly-net-client-v1')!;
    expect(JSON.stringify(host.snapshot)).not.toContain(key);

    await drop(0); // gus "reloads": old connection drops, a new one uses the same storage
    expect(host.snapshot!.seats[1].connected).toBe(false);
    const again = joinSession({ transport: hub.connect('gus-2'), roomCode: ROOM, name: 'Gus', storage: gusStore });
    await flush();
    expect(again.clientId).toBe(gus.clientId);
    expect(again.selfSeat).toBe(1);
    expect(host.snapshot!.seats[1].connected).toBe(true);
  });

  it('lets the host hand an absent player to a bot; the game goes on and the player can return', async () => {
    const { host, gus, ivy, hub, stores, drop } = await startedGame();
    await drop(0);
    expect(gus.status).toBe('connected'); // gus's own session cannot tell; the host can
    expect(host.snapshot!.seats[1].connected).toBe(false);
    ivy.convertToBot(1);
    expect(ivy.lastRejection).toBe('Only the host can do that');
    host.convertToBot(0);
    expect(host.lastRejection).toBe('The host cannot hand over their own seat');

    host.send({ type: 'roll' });
    await flush();
    if (game(host).phase === 'action') host.send({ type: 'endTurn' });
    await flush();
    expect(game(host).current).toBe(1); // stuck on Gus...
    await vi.advanceTimersByTimeAsync(5000);
    expect(game(host).current).toBe(1);
    host.convertToBot(1); // ...until the host hands the seat to a bot
    await flush();
    expect(host.snapshot!.seats[1].kind).toBe('bot');
    await vi.advanceTimersByTimeAsync(BOT_MS * 2);
    await flush();
    expect(game(host).current).toBe(2);
    expectInSync(host, [ivy]);

    const back = joinSession({ transport: hub.connect('gus-2'), roomCode: ROOM, name: 'Gus', storage: stores[0] });
    await flush();
    expect(host.snapshot!.seats[1]).toMatchObject({ kind: 'human', connected: true });
    expect(game(host).players[1].isBot).toBe(false);
    expect(back.selfSeat).toBe(1);
  });

  it('resumes a reloaded host from its save with hostEpoch + 1', async () => {
    const { host, hostStore, gus, ivy, hub, drop } = await startedGame();
    host.send({ type: 'roll' });
    await flush();
    const before = structuredClone(host.snapshot!);
    await drop('host'); // crash, not leave()
    expect(gus.status).toBe('host-lost');
    expect(gus.snapshot!.game).toEqual(before.game);
    gus.send({ type: 'roll' });
    expect(gus.lastRejection).toBe('Not connected to the host');

    const save = loadHostSave(hostStore)!;
    expect(save.roomCode).toBe(ROOM);
    // a save made with an old 6-character code is ignored, not resumed
    const stale = fakeStorage();
    stale.setItem('world-monopoly-net-host-v1', JSON.stringify({ roomCode: 'ABC234', snapshot: save.snapshot }));
    expect(loadHostSave(stale)).toBeNull();
    expect(loadHostSave(stale, true)).toBeNull();
    stale.setItem('world-monopoly-net-host-v1', JSON.stringify({ roomCode: formatRoomCode(ROOM), snapshot: save.snapshot }));
    expect(loadHostSave(stale)?.roomCode).toBe(ROOM);
    const host2 = hostSession({ transport: hub.connect('host-2'), roomCode: save.roomCode, name: 'Hana', storage: hostStore, resume: save.snapshot, botDelayMs: BOT_MS });
    await flush();
    expect(host2.snapshot!.hostEpoch).toBe(before.hostEpoch + 1);
    expect(host2.selfSeat).toBe(0);
    expect(gus.status).toBe('connected');
    expect(host2.snapshot!.seats.map((s) => s.connected)).toEqual([true, true, true, true]);
    expect(game(host2)).toEqual(before.game);
    expectInSync(host2, [gus, ivy]);
    host2.send({ type: 'endTurn' });
    await flush();
    expect(game(gus).current).toBe(1);
  });

  it('lets a guest take over a lost host; the old host demotes itself when it comes back', async () => {
    const { hostStore, gus, ivy, hub, drop } = await startedGame();
    await drop('host');
    const epoch = gus.snapshot!.hostEpoch;
    gus.takeOverAsHost();
    await flush();
    expect(gus.role).toBe('host');
    expect(ivy.status).toBe('connected');
    expect(ivy.snapshot!.hostEpoch).toBe(epoch + 2);
    expect(ivy.snapshot!.seats[0].connected).toBe(false); // old host is away

    // Gus (now host) finishes Hana's turn by handing her seat to a bot; bots now run on Gus.
    gus.convertToBot(0);
    await vi.advanceTimersByTimeAsync(BOT_MS * 2);
    await flush();
    expect(game(gus).current).toBe(1);
    expectInSync(gus, [ivy]);

    // Hana reloads and resumes from her stale save (epoch + 1): she must yield to Gus (epoch + 2).
    const save = loadHostSave(hostStore)!;
    const hana = hostSession({ transport: hub.connect('host-2'), roomCode: ROOM, name: 'Hana', storage: hostStore, resume: save.snapshot, botDelayMs: BOT_MS });
    await flush();
    expect(hana.role).toBe('guest');
    expect(loadHostSave(hostStore)).toBeNull();
    expect(hana.selfSeat).toBe(0); // reclaimed from the bot
    expect(gus.snapshot!.seats[0]).toMatchObject({ kind: 'human', connected: true });
    expectInSync(gus, [ivy, hana]);
  });

  it('converges when two hosts exist', async () => {
    // A live host sees a takeover: it demotes itself.
    const one = await startedGame();
    one.ivy.takeOverAsHost();
    await flush();
    expect(one.host.role).toBe('guest');
    expect(one.ivy.role).toBe('host');
    expectInSync(one.ivy, [one.host, one.gus]);
    expect(one.ivy.snapshot!.seats.every((s) => s.connected)).toBe(true);

    // Two guests take over at the same moment: equal epochs, the lower clientId wins.
    const two = await startedGame();
    await two.drop('host');
    two.gus.takeOverAsHost();
    two.ivy.takeOverAsHost();
    await flush();
    const [winner, loser] = two.gus.clientId < two.ivy.clientId ? [two.gus, two.ivy] : [two.ivy, two.gus];
    expect(winner.role).toBe('host');
    expect(loser.role).toBe('guest');
    expectInSync(winner, [loser]);
    expect(winner.snapshot!.seats[loser.selfSeat!].connected).toBe(true);
  });

  it('works when storage is unavailable', async () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    const hub = createMemoryTransportHub();
    const host = hostSession({ transport: hub.connect('h'), roomCode: ROOM, name: 'Hana', storage: throwing });
    const gus = joinSession({ transport: hub.connect('g'), roomCode: ROOM, name: 'Gus', storage: null });
    await flush();
    gus.claimSeat(1);
    await flush();
    expect(host.snapshot!.seats[1].name).toBe('Gus');
    expect(loadHostSave(throwing)).toBeNull();
  });

  it('leaves state untouched for every refused request from a raw seated peer', async () => {
    const { host, hub } = await setup([]);
    const evil = hub.connect('evil');
    const inbox: { t: string; reason?: string }[] = [];
    evil.onMessage((m) => inbox.push(m as { t: string }));
    await flush();
    evil.send({ t: 'hello', v: PROTOCOL_VERSION, key: 'E'.repeat(26), name: 'Eve' });
    evil.send({ t: 'lobby', op: { op: 'claim', seat: 0 } }); // the host's seat
    evil.send({ t: 'lobby', op: { op: 'claim', seat: 5 } }); // no such seat
    evil.send({ t: 'lobby', op: { op: 'claim', seat: 1 } });
    await flush();
    expect(host.snapshot!.seats.map((s) => s.name)).toEqual(['Hana', 'Eve']);
    host.start();
    await flush();
    const before = JSON.stringify(host.snapshot);
    const intents = [
      { type: 'roll' }, { type: 'finish' }, { type: 'endTurn' }, { type: 'cancelTrade' },
      { type: 'respondTrade', tradeId: host.snapshot!.rev, accept: true },
      { type: 'proposeTrade', offer: { from: 0, to: 1, give: [], get: [1], cash: 0 } },
      { type: 'build', index: 1 }, { type: 'sell', index: 1 }, { type: 'fly', dest: AIRPORTS[1] }, { type: 'sail', dest: SEAPORTS[1] },
    ];
    for (const intent of intents) evil.send({ t: 'intent', intent });
    for (const op of [{ op: 'name', name: 'Zed' }, { op: 'release' }, { op: 'claim', seat: 1 }, { op: 'role', roleId: 'banker' }]) evil.send({ t: 'lobby', op });
    await flush();
    expect(JSON.stringify(host.snapshot)).toBe(before);
    expect(inbox.filter((m) => m.t === 'reject')).toHaveLength(intents.length + 4 + 2); // + the two refused claims
  });

  it('accepts a trade answer once, and never for a withdrawn offer', async () => {
    const { host, gus } = await startedGame();
    host.send({ type: 'roll' });
    await flush();
    expect(game(host).phase).toBe('action');
    const [a, b, c] = sectionCities('africa');
    Object.assign(game(host).owners, { [a]: 0, [b]: 1, [c]: 1 });
    host.send({ type: 'proposeTrade', offer: { from: 0, to: 1, give: [a], get: [b], cash: 0 } });
    const first = host.snapshot!.pendingTrades[0].id;
    host.send({ type: 'cancelTrade' });
    host.send({ type: 'proposeTrade', offer: { from: 0, to: 1, give: [a], get: [c], cash: 0 } });
    const second = host.snapshot!.pendingTrades[0].id;
    expect(second).not.toBe(first);
    await flush();
    const seen: (string | undefined)[] = [];
    gus.subscribe((r) => r && seen.push(r));
    gus.send({ type: 'respondTrade', tradeId: first, accept: true });
    gus.send({ type: 'respondTrade', tradeId: second, accept: true });
    gus.send({ type: 'respondTrade', tradeId: second, accept: true });
    await flush();
    expect(game(host).owners[b]).toBe(1);
    expect(game(host).owners[c]).toBe(0);
    expect(game(host).owners[a]).toBe(1);
    expect(seen).toEqual(['That trade is no longer on the table', 'That trade is no longer on the table']);
  });

  it('marks the old identity away when a connection says hello with another key', async () => {
    const { host, hub } = await setup([]);
    const evil = hub.connect('evil');
    await flush();
    evil.send({ t: 'hello', v: PROTOCOL_VERSION, key: 'E'.repeat(26), name: 'Eve' });
    evil.send({ t: 'lobby', op: { op: 'claim', seat: 1 } });
    await flush();
    expect(host.snapshot!.seats[1]).toMatchObject({ name: 'Eve', connected: true });
    evil.send({ t: 'hello', v: PROTOCOL_VERSION, key: 'F'.repeat(26), name: 'Fay' });
    await flush();
    expect(host.snapshot!.seats[1].connected).toBe(false);
    for (let i = 0; i < 50; i++) evil.send({ t: 'hello', v: PROTOCOL_VERSION, key: `K${String(i).padStart(20, '0')}`, name: 'X' });
    await flush();
    expect((host as unknown as { helloNames: Map<string, string> }).helloNames.size).toBe(1); // bounded per connection
  });

  it('builds, sells and flies over the wire', async () => {
    const { host, gus } = await startedGame();
    host.send({ type: 'roll' });
    await flush();
    host.send({ type: 'endTurn' });
    await flush();
    expect(game(host).current).toBe(1);
    // Setup on the host only: Gus owns a city, stands on an airport and may fly.
    const g = game(host);
    const [city] = sectionCities('africa');
    g.owners[city] = 1;
    gus.send({ type: 'build', index: city });
    await flush();
    expect(gus.lastRejection).toBe('Roll first');
    g.phase = 'action';
    g.players[1].position = AIRPORTS[0];
    g.players[1].cash = 5000;
    g.canFly = true;
    gus.send({ type: 'build', index: city });
    await flush();
    expect(gus.lastRejection).toBe('Roll first'); // unchanged: no new rejection
    expect(game(gus).levels[city]).toBe(1);
    gus.send({ type: 'sell', index: city });
    await flush();
    expect(game(gus).levels[city] ?? 0).toBe(0);
    gus.send({ type: 'sell', index: city });
    await flush();
    expect(gus.lastRejection).toBe('cannot sell here');
    gus.send({ type: 'fly', dest: AIRPORTS[0] });
    await flush();
    expect(gus.lastRejection).toBe('bad destination');
    gus.send({ type: 'fly', dest: AIRPORTS[2] });
    await flush();
    expect(game(gus).players[1].position).toBe(AIRPORTS[2]);
    expect(game(gus).canFly).toBe(false);
    expectInSync(host, [gus]);
  });

  it('sails over the wire: only the current player, only along a route, once a turn', async () => {
    const { host, gus } = await startedGame();
    host.send({ type: 'roll' });
    await flush();
    const g = game(host);
    const [port, linked] = [SEAPORTS[3], SEAPORTS[4]]; // South Atlantic -> Coral Sea (Cape Route)
    const unlinked = SEAPORTS[1]; // Baltic: no route from the South Atlantic
    Object.assign(g.players[0], { position: port, cash: 5000 });
    Object.assign(g, { phase: 'action', canFly: false, canSail: true });
    gus.send({ type: 'sail', dest: linked });
    await flush();
    expect(gus.lastRejection).toBe('It is not your turn');
    host.send({ type: 'sail', dest: unlinked });
    await flush();
    expect(host.lastRejection).toBe('no sea route there');
    host.send({ type: 'sail', dest: linked });
    await flush();
    expect(game(gus).players[0].position).toBe(linked);
    expect(game(gus).players[0].cash).toBe(5000 - 75);
    expect(game(gus).canSail).toBe(false);
    host.send({ type: 'sail', dest: port });
    await flush();
    expect(host.lastRejection).toBe('cannot sail now');
    expectInSync(host, [gus]);
  });

  it('ends the game at the round limit, refuses further intents, and lets a spectator arrive mid-game', async () => {
    const { host, gus, ivy, hub } = await startedGame(2);
    const clients = [host, gus, ivy];
    for (let i = 0; i < 6; i++) await playStep(host, clients);
    const late = joinSession({ transport: hub.connect('late'), roomCode: ROOM, name: 'Lou', storage: fakeStorage() });
    await flush();
    expect(late.selfSeat).toBeNull();
    expect(late.snapshot).toEqual(host.snapshot);
    late.claimSeat(1);
    await flush();
    expect(late.lastRejection).toBe('The game has already started');
    let steps = 0;
    while (game(host).phase !== 'gameOver' && steps++ < 200) await playStep(host, clients);
    expect(game(host).phase).toBe('gameOver');
    expect(game(host).log).toContain('Round limit (2) reached.');
    expect(game(host).winner).not.toBeNull();
    expect(host.snapshot!.phase).toBe('playing'); // the room stays on the final board
    const rev = host.snapshot!.rev;
    host.send({ type: 'finish' });
    gus.send({ type: 'roll' });
    await flush();
    expect(host.lastRejection).toBe('The game is over');
    expect(gus.lastRejection).toBe('The game is over');
    expect(host.snapshot!.rev).toBe(rev);
    expectInSync(host, [gus, ivy, late]);
  });

  it('keeps a finished game in the host save so a reload of the room can resume it', async () => {
    const { host, hostStore } = await startedGame();
    host.send({ type: 'finish' });
    await flush();
    expect(game(host).phase).toBe('gameOver');
    expect(loadHostSave(hostStore)).toBeNull(); // not offered on the main menu
    expect(loadHostSave(hostStore, true)?.snapshot.game?.phase).toBe('gameOver');
    host.leave(); // "New game" / "Leave game"
    expect(loadHostSave(hostStore, true)).toBeNull();
  });

  it('keeps the snapshot small enough for one message', async () => {
    const { host, gus, ivy } = await startedGame(30);
    let steps = 0;
    while (game(host).phase !== 'gameOver' && steps++ < 2000) await playStep(host, [host, gus, ivy]);
    // Log is capped at 200 lines; a full late-game snapshot stays well under MAX_MESSAGE_BYTES.
    expect(JSON.stringify({ t: 'snapshot', snapshot: host.snapshot as Snapshot }).length).toBeLessThan(64 * 1024);
  });
});
