// Host-side rules for online play: lobby, intents, trades, bots. Pure functions over a Snapshot:
// no DOM, no transport, no timers. Every function that changes something bumps `rev` and returns
// { ok: true }; a refused request changes nothing and returns { ok: false, reason }.
// Trades are not tied to the turn: any seated human may offer one at any time (see applyIntent).

import { ROLES, RULES } from '../engine/data';
import { botAcceptsTrade, botStep } from '../engine/bot';
import { build, buy, createGame, endGameByNetWorth, endTurn, executeTrade, fly, roll, sellBuilding, validateTrade } from '../engine/game';
import type { GameState, PlayerSetup } from '../engine/types';
import { NAME_MAX, cleanName } from './protocol';
import type { Intent, LobbyOp, Seat, Snapshot } from './protocol';

export type Result = { ok: true } | { ok: false; reason: string };

const OK: Result = { ok: true };
const no = (reason: string): Result => ({ ok: false, reason });
/** Every state change goes through here: offers that can no longer happen are dropped, then `rev` moves. */
const changed = (t: Snapshot): Result => {
  sweepTrades(t);
  t.rev += 1;
  return OK;
};

/** Same cap as the engine's log. */
const MAX_LOG = 200;
function note(g: GameState, line: string) {
  g.log.push(line);
  if (g.log.length > MAX_LOG) g.log.splice(0, g.log.length - MAX_LOG);
}

const openSeat = (roleId: string): Seat => ({ kind: 'open', name: '', roleId, clientId: null, connected: false });
const unusedRole = (t: Snapshot) => ROLES.find((r) => !t.seats.some((s) => s.roleId === r.id))!.id;

/** New lobby: seat 0 is the host, seat 1 is open. */
export function createTable(hostId: string, hostName: string): Snapshot {
  return {
    rev: 0,
    hostEpoch: 0,
    hostId,
    phase: 'lobby',
    seats: [
      { kind: 'human', name: hostName, roleId: ROLES[0].id, clientId: hostId, connected: true },
      openSeat(ROLES[1].id),
    ],
    game: null,
    pendingTrades: [],
    roundLimit: RULES.roundLimit.default,
  };
}

/** Seat index a client plays (human seats only), or null for spectators. */
export function seatOf(t: Snapshot, clientId: string): number | null {
  const i = t.seats.findIndex((s) => s.kind === 'human' && s.clientId === clientId);
  return i < 0 ? null : i;
}

// ---------- presence ----------

/**
 * Marks a client's seat as connected or not. When a returning client's seat was handed to a bot
 * mid-game, it becomes theirs again (the bot stops after its current step).
 */
export function setConnected(t: Snapshot, clientId: string, connected: boolean): Result {
  const i = t.seats.findIndex((s) => s.clientId === clientId && s.kind !== 'open');
  if (i < 0) return no('no seat');
  const seat = t.seats[i];
  if (connected && seat.kind === 'bot' && t.game) {
    seat.kind = 'human';
    t.game.players[i].isBot = false;
    note(t.game, `${seat.name} is back and plays again.`);
  } else if (seat.kind === 'bot' || seat.connected === connected) {
    return no('unchanged');
  }
  seat.connected = connected;
  return changed(t);
}

/** After a host change: every remote human counts as away until they say hello to the new host. */
export function resetPresence(t: Snapshot) {
  for (const s of t.seats) if (s.kind === 'human' && s.clientId !== t.hostId) s.connected = false;
}

// ---------- lobby ----------

/** A client's own lobby change (guests over the wire; the host for its own seat). */
export function applyLobbyOp(t: Snapshot, clientId: string, op: LobbyOp, helloName: string): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  const mine = seatOf(t, clientId);
  switch (op.op) {
    case 'claim': {
      const seat = t.seats[op.seat];
      if (!seat || seat.kind !== 'open') return no('That seat is taken');
      const name = mine === null ? helloName : t.seats[mine].name;
      if (mine !== null) t.seats[mine] = openSeat(t.seats[mine].roleId);
      t.seats[op.seat] = { kind: 'human', name, roleId: seat.roleId, clientId, connected: true };
      return changed(t);
    }
    case 'release':
      if (mine === null) return no('You have no seat');
      t.seats[mine] = openSeat(t.seats[mine].roleId);
      return changed(t);
    case 'name':
      if (mine === null) return no('You have no seat');
      t.seats[mine].name = op.name;
      return changed(t);
    case 'role':
      if (mine === null) return no('You have no seat');
      return setRole(t, mine, op.roleId);
  }
}

function setRole(t: Snapshot, i: number, roleId: string): Result {
  if (!ROLES.some((r) => r.id === roleId)) return no('Unknown role');
  if (t.seats.some((s, j) => j !== i && s.roleId === roleId)) return no('Another seat has that role');
  t.seats[i].roleId = roleId;
  return changed(t);
}

/** Host only: add an open seat. */
export function addSeat(t: Snapshot): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  if (t.seats.length >= RULES.players.max) return no(`At most ${RULES.players.max} players`);
  t.seats.push(openSeat(unusedRole(t)));
  return changed(t);
}

/** Host only: remove a seat (its player, if any, becomes a spectator). Later seats move up one. */
export function removeSeat(t: Snapshot, i: number): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  if (!t.seats[i]) return no('No such seat');
  if (t.seats.length <= RULES.players.min) return no(`At least ${RULES.players.min} players`);
  t.seats.splice(i, 1);
  return changed(t);
}

/**
 * Host only: change any seat. `kind: 'open'` empties it (a seated human becomes a spectator),
 * `kind: 'bot'` makes it a bot. `name` applies to bot and human seats; `roleId` must be unused.
 */
export function setSeat(t: Snapshot, i: number, patch: { kind?: 'open' | 'bot'; name?: string; roleId?: string }): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  const seat = t.seats[i];
  if (!seat) return no('No such seat');
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  if (name === null) return no(`Names are 1-${NAME_MAX} characters`);
  if (patch.roleId !== undefined && patch.roleId !== seat.roleId) {
    const r = setRole(t, i, patch.roleId);
    if (!r.ok) return r;
  }
  if (patch.kind === 'open') t.seats[i] = openSeat(seat.roleId);
  if (patch.kind === 'bot' && seat.kind !== 'bot') t.seats[i] = { kind: 'bot', name: `Bot ${i + 1}`, roleId: seat.roleId, clientId: null, connected: true };
  if (name && t.seats[i].kind !== 'open') t.seats[i].name = name;
  return changed(t);
}

/** Host only: round limit, 0 = none. */
export function setRoundLimit(t: Snapshot, rounds: number): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 999) return no('Round limit must be 0-999');
  t.roundLimit = rounds;
  return changed(t);
}

/** Host only: start the game. Every seat must be a human or a bot. */
export function startGame(t: Snapshot, seed: number): Result {
  if (t.phase !== 'lobby') return no('The game has already started');
  if (t.seats.some((s) => s.kind === 'open')) return no('Fill or remove the open seats first');
  const setups: PlayerSetup[] = t.seats.map((s) => ({ name: s.name, isBot: s.kind === 'bot', roleId: s.roleId }));
  try {
    t.game = createGame(setups, seed, t.roundLimit);
  } catch (e) {
    return no((e as Error).message);
  }
  t.phase = 'playing';
  return changed(t);
}

/**
 * Host only, mid-game: hand a remote human's seat to a bot (the escape hatch for absent players;
 * works whether or not they are connected). The seat keeps their clientId, so when they reconnect
 * the seat becomes theirs again. Pending offers involving the seat are cancelled (by `changed`).
 */
export function convertToBot(t: Snapshot, i: number): Result {
  const seat = t.seats[i];
  if (!t.game || !seat) return no('No such seat');
  if (seat.kind !== 'human') return no('Only a human seat can be handed to a bot');
  if (seat.clientId === t.hostId) return no('The host cannot hand over their own seat');
  seat.kind = 'bot';
  seat.connected = true;
  t.game.players[i].isBot = true;
  note(t.game, `${seat.name} is now played by a bot.`);
  return changed(t);
}

// ---------- intents ----------

const TURN_ACTIONS: Record<string, (g: GameState, i: Intent) => void> = {
  roll: (g) => roll(g),
  buy: (g) => buy(g),
  build: (g, i) => build(g, (i as { index: number }).index),
  sell: (g, i) => sellBuilding(g, (i as { index: number }).index),
  fly: (g, i) => fly(g, (i as { dest: number }).dest),
  endTurn: (g) => endTurn(g),
};

/** Runs an engine action on a copy and keeps it only if nothing threw, so a refused intent never half-applies. */
function onCopy(t: Snapshot, fn: (g: GameState) => void): Result {
  const draft = structuredClone(t.game!);
  try {
    fn(draft);
  } catch (e) {
    return no((e as Error).message);
  }
  t.game = draft;
  return OK;
}

/**
 * Applies a seated player's intent. Rules on top of the engine:
 * - turn actions only from the seat whose turn it is (`game.current`), never a bot seat;
 * - trades ignore the turn: any seated human may `proposeTrade` to another player at any time while the
 *   game runs, with at most one outstanding offer each (`pendingTrades`, one per proposer). A pending
 *   offer does not block the proposer's turn actions and survives the end of the turn;
 * - `respondTrade` only from the offer's target, quoting its `id`; `cancelTrade` only from the proposer;
 *   `finish` only from the host's own seat;
 * - offers that can no longer happen (game over, a party bankrupt or turned into a bot, `validateTrade`
 *   failing) are dropped after every change, with a log note;
 * - a trade with a bot is answered at once by `botAcceptsTrade`; a refusal comes back as a rejection.
 * Engine errors come back as `{ ok: false, reason }` with the engine's message.
 */
export function applyIntent(t: Snapshot, seatIndex: number | null, intent: Intent): Result {
  const g = t.game;
  if (t.phase !== 'playing' || !g) return no('The game has not started');
  if (seatIndex === null || !t.seats[seatIndex]) return no('You do not have a seat');
  if (t.seats[seatIndex].kind !== 'human') return no('A bot plays this seat');
  if (g.phase === 'gameOver') return no('The game is over');

  let r: Result;
  switch (intent.type) {
    case 'finish':
      if (t.seats[seatIndex].clientId !== t.hostId) return no('Only the host can end the game');
      r = onCopy(t, endGameByNetWorth);
      break;
    case 'proposeTrade':
      return propose(t, g, seatIndex, intent.offer);
    case 'respondTrade': {
      const pending = t.pendingTrades.find((p) => p.id === intent.tradeId);
      if (!pending) return no('That trade is no longer on the table');
      if (pending.offer.to !== seatIndex) return no('That trade is not for you');
      t.pendingTrades = t.pendingTrades.filter((p) => p !== pending);
      const from = g.players[pending.offer.from].name;
      if (!intent.accept) {
        note(g, `${g.players[seatIndex].name} declined ${from}'s trade.`);
        return changed(t);
      }
      r = onCopy(t, (d) => executeTrade(d, pending.offer));
      if (!r.ok) {
        note(g, `${from}'s trade fell through: ${r.reason}.`);
        changed(t);
        return r;
      }
      break;
    }
    case 'cancelTrade': {
      const mine = t.pendingTrades.find((p) => p.offer.from === seatIndex);
      if (!mine) return no('You have no pending trade');
      t.pendingTrades = t.pendingTrades.filter((p) => p !== mine);
      note(g, `${g.players[seatIndex].name} withdrew their trade offer.`);
      return changed(t);
    }
    default:
      if (g.current !== seatIndex) return no('It is not your turn');
      r = onCopy(t, (d) => TURN_ACTIONS[intent.type](d, intent));
  }
  return r.ok ? changed(t) : r;
}

function propose(t: Snapshot, g: GameState, seatIndex: number, offer: Extract<Intent, { type: 'proposeTrade' }>['offer']): Result {
  if (offer.from !== seatIndex) return no('You can only offer your own properties');
  if (g.players[seatIndex].bankrupt) return no('You are bankrupt');
  if (t.pendingTrades.some((p) => p.offer.from === seatIndex)) return no('You already have a trade offer out. Cancel it first');
  if (t.pendingTrades.length >= t.seats.length) return no('Too many trade offers are open');
  const err = validateTrade(g, offer);
  if (err) return no(err);
  const target = g.players[offer.to];
  if (t.seats[offer.to].kind === 'bot') {
    if (!botAcceptsTrade(g, offer)) return no(`${target.name} declined. Bots want about 30% more value than they give.`);
    const r = onCopy(t, (d) => executeTrade(d, offer));
    return r.ok ? changed(t) : r;
  }
  // rev only grows, so ids never repeat and an answer to an old offer cannot accept a newer one.
  t.pendingTrades.push({ id: t.rev + 1, offer: { ...offer, give: [...offer.give], get: [...offer.get] } });
  note(g, `${g.players[seatIndex].name} offered ${target.name} a trade.`);
  return changed(t);
}

/** Drops offers that can no longer happen (see applyIntent), logging whose offer it was. Silent after game over. */
function sweepTrades(t: Snapshot) {
  const g = t.game;
  if (!g || !t.pendingTrades.length) return;
  const over = g.phase === 'gameOver';
  t.pendingTrades = t.pendingTrades.filter(({ offer }) => {
    const live = !over && [offer.from, offer.to].every((i) => t.seats[i]?.kind === 'human' && !g.players[i].bankrupt) && !validateTrade(g, offer);
    if (!live && !over) note(g, `${g.players[offer.from].name}'s trade offer to ${g.players[offer.to].name} was cancelled.`);
    return live;
  });
}

// ---------- bots ----------

/** True when the current player is a bot and the game is still running. */
export function needsBotStep(t: Snapshot): boolean {
  const g = t.game;
  return t.phase === 'playing' && !!g && g.phase !== 'gameOver' && t.seats[g.current]?.kind === 'bot';
}

/** Plays one bot step (roll, or buy/build/end turn). Returns false when it is not a bot's turn. */
export function stepBot(t: Snapshot): boolean {
  if (!needsBotStep(t)) return false;
  if (!onCopy(t, botStep).ok) return false;
  changed(t);
  return true;
}
