import { buildingValue, buy, build, canBuild, currentPlayer, endTurn, levelOf, ownedBy, roll, square } from './game';
import type { GameState, TradeOffer } from './types';

const BUY_RESERVE = 200;
const BUILD_RESERVE = 150;

/** Plays one step of the current bot's turn: roll, or (after rolling) buy/build/end. */
export function botStep(s: GameState) {
  if (s.phase === 'roll') {
    roll(s);
    return;
  }
  if (s.phase !== 'action') return;
  const p = currentPlayer(s);
  if (s.pendingBuy !== null && p.cash - (square(s.pendingBuy).price ?? 0) >= BUY_RESERVE) buy(s);
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

/** Bots accept a trade when what they receive is worth at least 30% more than what they give. */
export function botAcceptsTrade(s: GameState, t: TradeOffer) {
  const value = (xs: number[]) => xs.reduce((sum, i) => sum + (square(i).price ?? 0) + (square(i).type === 'city' ? buildingValue(s, i) : 0), 0);
  const gives = value(t.get) + Math.max(0, -t.cash);
  const gets = value(t.give) + Math.max(0, t.cash);
  return gets > 0 && gets >= gives * 1.3;
}
