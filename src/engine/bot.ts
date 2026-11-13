import { RULES } from './data';
import {
  AIRPORTS, SIZE, buildingValue, buy, build, canBuild, cityRent, currentPlayer, endTurn, fly, flightFare, lapIncome, levelOf, ownedBy, ownerOf, roll,
  sail, sailFare, seaRoutesFrom, square,
} from './game';
import type { GameState, Player, TradeOffer } from './types';

const BUY_RESERVE = 200;
const BUILD_RESERVE = 150;
/** A trip may cost at most this share of the bot's cash. */
const TRAVEL_CASH_SHARE = 0.05;
/** A trip must save at least this many times its cost. */
const TRAVEL_MARGIN = 1.5;
/** Average squares moved per roll (two dice): the chance of landing on a given square ahead is about 1 / 7. */
const AVG_ROLL = (RULES.dice.count * (RULES.dice.sides + 1)) / 2;

/** Plays one step of the current bot's turn: roll, or (after rolling) buy, travel, build, end. */
export function botStep(s: GameState) {
  if (s.phase === 'roll') {
    roll(s);
    return;
  }
  if (s.phase !== 'action') return;
  const p = currentPlayer(s);
  buyIfAffordable(s, p);
  // At most one trip a turn (the engine allows one flight or one sail), then buy where it arrived.
  const trip = bestTrip(s, p);
  if (trip) {
    if (trip.kind === 'fly') fly(s, trip.dest);
    else sail(s, trip.dest);
    buyIfAffordable(s, p);
  }
  // Build cheapest-first on the least developed cities while cash stays above the reserve.
  for (let guard = 0; guard < 20; guard++) {
    const options = ownedBy(s, p.id)
      .filter((i) => square(i).type === 'city')
      .map((i) => ({ i, check: canBuild(s, i) }))
      .filter((o) => o.check.ok)
      .sort((a, b) => levelOf(s, a.i) - levelOf(s, b.i) || (square(a.i).price ?? 0) - (square(b.i).price ?? 0));
    const next = options[0];
    if (!next || !next.check.ok) break;
    const total = next.check.cost + next.check.fees.reduce((a, f) => a + f.amount, 0);
    if (p.cash - total < BUILD_RESERVE) break;
    build(s, next.i);
  }
  endTurn(s);
}

function buyIfAffordable(s: GameState, p: Player) {
  if (s.pendingBuy !== null && p.cash - (square(s.pendingBuy).price ?? 0) >= BUY_RESERVE) buy(s);
}

/**
 * The best flight or sail, or null. Only forward along the track without passing New Year, so it never skips
 * a payout. It skips the squares in between: worth the rent the bot would expect to pay there (each square ahead
 * is landed on about once in AVG_ROLL), minus the lap income those squares would have earned, minus the fare.
 * Taken only when that saving is at least TRAVEL_MARGIN times the cost and the fare is small next to its cash.
 */
function bestTrip(s: GameState, p: Player): { kind: 'fly' | 'sail'; dest: number } | null {
  const here = p.position;
  const options: { kind: 'fly' | 'sail'; dest: number; fare: number }[] = [];
  if (s.canFly && square(here).type === 'airport') for (const a of AIRPORTS) if (a !== here) options.push({ kind: 'fly', dest: a, fare: flightFare(s, a) });
  if (s.canSail && square(here).type === 'seaport') for (const r of seaRoutesFrom(here)) options.push({ kind: 'sail', dest: r.dest, fare: sailFare(s, r.dest) });
  let best: { kind: 'fly' | 'sail'; dest: number; score: number } | null = null;
  for (const o of options) {
    if (o.dest <= here) continue; // would pass New Year or go back
    if (o.fare > p.cash * TRAVEL_CASH_SHARE) continue;
    const skipped = o.dest - here;
    let rentAvoided = 0;
    for (let i = here + 1; i < o.dest; i++) rentAvoided += expectedRent(s, p, i) / AVG_ROLL;
    const lapLoss = lapIncome({ ...p, lapProgress: p.lapProgress + SIZE - here }) - lapIncome({ ...p, lapProgress: p.lapProgress + SIZE - o.dest });
    const cost = o.fare + lapLoss;
    const score = rentAvoided - cost;
    if (skipped > 0 && rentAvoided >= cost * TRAVEL_MARGIN && score > 0 && (!best || score > best.score)) best = { kind: o.kind, dest: o.dest, score };
  }
  return best && { kind: best.kind, dest: best.dest };
}

/** Rent `p` would pay landing on square `i` now (cities only; fees elsewhere are small). */
function expectedRent(s: GameState, p: Player, i: number) {
  const owner = ownerOf(s, i);
  if (!owner || owner.id === p.id || square(i).type !== 'city') return 0;
  return cityRent(s, i);
}

/** Bots accept a trade when what they receive is worth at least 30% more than what they give. */
export function botAcceptsTrade(s: GameState, t: TradeOffer) {
  const value = (xs: number[]) => xs.reduce((sum, i) => sum + (square(i).price ?? 0) + (square(i).type === 'city' ? buildingValue(s, i) : 0), 0);
  const gives = value(t.get) + Math.max(0, -t.cash);
  const gets = value(t.give) + Math.max(0, t.cash);
  return gets > 0 && gets >= gives * 1.3;
}
