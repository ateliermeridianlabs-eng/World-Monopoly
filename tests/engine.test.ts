import { describe, expect, it } from 'vitest';
import { BOARD, RULES, SECTIONS } from '../src/engine/data';
import { botStep } from '../src/engine/bot';
import {
  build, buy, canBuild, cityRent, createGame, endTurn, executeTrade, fly, roll, sectionCities, sectionUtilities, utilityFees,
} from '../src/engine/game';
import type { GameState } from '../src/engine/types';

const twoPlayers = () =>
  createGame([
    { name: 'A', isBot: false, roleId: 'banker' },
    { name: 'B', isBot: false, roleId: 'diplomat' },
  ], 42);

const firstCity = (sectionId: string) => sectionCities(sectionId)[0];

function give(s: GameState, playerId: number, indexes: number[]) {
  for (const i of indexes) s.owners[i] = playerId;
}

describe('board data', () => {
  it('has 144 squares with 12 salary checkpoints and unique ids', () => {
    expect(BOARD).toHaveLength(144);
    expect(BOARD.filter((s) => s.checkpoint)).toHaveLength(12);
    expect(new Set(BOARD.map((s) => s.id)).size).toBe(144);
    expect(BOARD[0].type).toBe('newYear');
  });

  it('has 8 cities and 4 utilities in each of the 9 sections', () => {
    expect(SECTIONS).toHaveLength(9);
    for (const s of SECTIONS) {
      expect(sectionCities(s.id)).toHaveLength(8);
      expect(sectionUtilities(s.id)).toHaveLength(4);
    }
  });
});

describe('rent', () => {
  it('adds 10% per extra square owned in the section, capped by role', () => {
    const s = twoPlayers();
    const cities = sectionCities('usa');
    const ny = cities[7];
    give(s, 0, [ny]);
    const base = cityRent(s, ny);
    expect(base).toBe(Math.round(600 * 0.08));
    give(s, 0, cities.slice(0, 3));
    expect(cityRent(s, ny)).toBe(Math.round(base * 1.3));
    give(s, 0, [...cities, ...sectionUtilities('usa')]);
    expect(cityRent(s, ny)).toBe(Math.round(base * 2.1));
    // Diplomat owner caps at +50%
    give(s, 1, [...cities, ...sectionUtilities('usa')]);
    expect(cityRent(s, ny)).toBe(Math.round(base * 1.5));
  });
});

describe('building', () => {
  it('charges utility fees to active meter owners and the bank otherwise', () => {
    const s = twoPlayers();
    s.phase = 'action';
    const sec = 'africa';
    const city = firstCity(sec);
    const [water, gas] = sectionUtilities(sec);
    give(s, 0, [city]);
    give(s, 1, [water, gas, sectionCities(sec)[1]]);
    const fees = utilityFees(s, city, s.players[0]);
    expect(fees.map((f) => f.to?.id ?? null)).toEqual([1, 1, null, null]);
    expect(fees.every((f) => f.amount === RULES.utilities.feePerHouse)).toBe(true);
    const before = s.players[1].cash;
    build(s, city);
    expect(s.levels[city]).toBe(1);
    expect(s.players[1].cash).toBe(before + 20);
  });

  it('blocks a hotel without the full section', () => {
    const s = twoPlayers();
    s.phase = 'action';
    const city = firstCity('japan');
    give(s, 0, [city]);
    s.levels[city] = 4;
    const check = canBuild(s, city);
    expect(check.ok).toBe(false);
    give(s, 0, sectionCities('japan'));
    expect(canBuild(s, city).ok).toBe(true);
  });
});

describe('turn flow', () => {
  it('pays salary when passing a checkpoint', () => {
    const s = twoPlayers();
    const p = s.players[0];
    // From square 10 any roll (2-12) crosses checkpoint 12 and stops before 24.
    p.position = 10;
    roll(s);
    expect(s.log.filter((l) => l.includes('salary'))).toHaveLength(1);
  });

  it('lets a player buy, end turn and fly between airports', () => {
    const s = twoPlayers();
    const airports = BOARD.filter((q) => q.type === 'airport').map((q) => q.index);
    const p = s.players[0];
    p.position = airports[0];
    s.phase = 'action';
    s.canFly = true;
    s.pendingBuy = airports[0];
    buy(s);
    expect(s.owners[airports[0]]).toBe(0);
    fly(s, airports[3]);
    expect(p.position).toBe(airports[3]);
    expect(s.pendingBuy).toBe(airports[3]);
    endTurn(s);
    expect(s.current).toBe(1);
  });

  it('trades properties and cash', () => {
    const s = twoPlayers();
    const [a, b] = sectionCities('uk');
    give(s, 0, [a]);
    give(s, 1, [b]);
    executeTrade(s, { from: 0, to: 1, give: [a], get: [b], cash: 100 });
    expect(s.owners[a]).toBe(1);
    expect(s.owners[b]).toBe(0);
    expect(s.players[1].cash).toBe(1500 + 100);
  });
});

describe('bot games', () => {
  it('runs full 4-bot games to a winner without errors', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = createGame(
        ['entrepreneur', 'banker', 'landlord', 'industrialist'].map((roleId, i) => ({ name: `Bot ${i}`, isBot: true, roleId })),
        seed,
        40,
      );
      let steps = 0;
      while (s.phase !== 'gameOver' && steps++ < 100000) botStep(s);
      expect(s.phase).toBe('gameOver');
      expect(s.winner).not.toBeNull();
      for (const p of s.players) expect(p.cash).toBeGreaterThanOrEqual(0);
    }
  });
});
