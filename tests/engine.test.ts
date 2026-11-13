import { describe, expect, it } from 'vitest';
import { BOARD, CARDS, FLIGHTS, ROLES, RULES, SEA_ROUTES, SECTIONS } from '../src/engine/data';
import { botStep } from '../src/engine/bot';
import {
  AIRPORTS, SEAPORTS, SIZE, build, buy, canBuild, cityRent, createGame, endTurn, executeTrade, flightBand, flightFare, fly, lapIncome, roll, sail,
  sailFare, seaRoutesFrom, sectionCities, sectionUtilities, utilityFees, validateTrade,
} from '../src/engine/game';
import { nextRandom } from '../src/engine/rng';
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
    const ny = BOARD.find((q) => q.id === 'new-york')!.index;
    give(s, 0, [ny]);
    const base = cityRent(s, ny);
    expect(base).toBe(Math.round(600 * 0.08));
    give(s, 0, cities.filter((c) => c !== ny).slice(0, 3));
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
    expect(s.players[1].cash).toBe(RULES.startingCash + 100);
  });

  it('validates trades regardless of whose turn it is or the phase', () => {
    const s = createGame(['banker', 'diplomat', 'landlord'].map((roleId, i) => ({ name: `P${i}`, isBot: false, roleId })), 42);
    const [a, b] = sectionCities('uk');
    give(s, 1, [a]);
    give(s, 2, [b]);
    expect(s.current).toBe(0);
    for (const phase of ['roll', 'action'] as const) {
      s.phase = phase;
      // Players 1 and 2 trade while player 0 is up.
      expect(validateTrade(s, { from: 1, to: 2, give: [a], get: [b], cash: 10 })).toBeNull();
    }
    executeTrade(s, { from: 1, to: 2, give: [a], get: [b], cash: 10 });
    expect(s.owners[a]).toBe(2);
    expect(s.owners[b]).toBe(1);
    expect(s.current).toBe(0); // trading never touches the turn
    expect(s.phase).toBe('action');
    s.players[2].bankrupt = true;
    expect(validateTrade(s, { from: 1, to: 2, give: [b], get: [], cash: 0 })).toBe('Pick another player');
    s.players[2].bankrupt = false;
    s.phase = 'gameOver';
    expect(validateTrade(s, { from: 1, to: 2, give: [b], get: [], cash: 0 })).toBe('The game is over');
    expect(() => executeTrade(s, { from: 1, to: 2, give: [b], get: [], cash: 0 })).toThrow('The game is over');
  });

  it('rejects trade cash that is not a whole number', () => {
    const s = twoPlayers();
    const [a] = sectionCities('uk');
    give(s, 0, [a]);
    for (const cash of [Number.NaN, 0.5, Infinity, -Infinity]) {
      expect(validateTrade(s, { from: 0, to: 1, give: [a], get: [], cash })).toMatch(/whole number/);
      expect(() => executeTrade(s, { from: 0, to: 1, give: [a], get: [], cash })).toThrow();
    }
    expect(validateTrade(s, { from: 0, to: 1, give: [a], get: [], cash: 0 })).toBeNull();
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

// ---------- helpers for lap income and travel ----------

/** An rng state whose next two dice add up to `sum` (2-12), so tests can choose rolls. */
function seedFor(sum: number) {
  for (let r = 1; r < 1e6; r++) {
    const t = { rng: r };
    const d = [1 + Math.floor(nextRandom(t) * 6), 1 + Math.floor(nextRandom(t) * 6)];
    if (d[0] + d[1] === sum) return r;
  }
  throw new Error('no seed');
}
const SEEDS = new Map(Array.from({ length: 11 }, (_, i) => [i + 2, seedFor(i + 2)]));
const cardIndex = (id: string) => CARDS.findIndex((c) => c.id === id);

/** Player 0 rolls exactly `sum` (it is their turn again, World Events only pay a tax refund unless `deck` says otherwise). */
function rollAs(s: GameState, sum: number, deck = [cardIndex('tax-refund')]) {
  s.current = 0;
  s.phase = 'roll';
  s.deck = Array(20).fill(deck).flat();
  s.rng = SEEDS.get(sum)!;
  roll(s);
}

/** Player 0 walks `steps` squares by dice (rolls of 12, then the rest). */
function walk(s: GameState, steps: number) {
  while (steps > 0) {
    const n = steps >= 14 ? 12 : steps <= 12 ? steps : steps - 2;
    rollAs(s, n);
    steps -= n;
  }
}

const lapLines = (s: GameState, name = 'A') => s.log.filter((l) => l.startsWith(`${name} collected`) && l.includes('lap income'));
const lapPaid = (line: string) => Number(line.match(/collected \$([\d,]+) lap income/)![1].replace(/,/g, ''));

describe('money', () => {
  it('starts every player with $10,000 plus their role delta', () => {
    expect(RULES.startingCash).toBe(10000);
    const s = createGame(ROLES.map((r, i) => ({ name: `P${i}`, isBot: true, roleId: r.id })), 1);
    s.players.forEach((p) => expect(p.cash).toBe(10000 + (ROLES.find((r) => r.id === p.roleId)!.startingCashDelta ?? 0)));
    expect(s.players.every((p) => p.lapProgress === 0)).toBe(true);
    expect(s.version).toBe(4);
  });

  it('pays the full $2,000 lap income for a full lap walked, before property tax', () => {
    const s = twoPlayers();
    const p = s.players[0];
    give(s, 0, [firstCity('usa')]); // so there is property tax to pay
    walk(s, 140);
    expect(lapLines(s)).toHaveLength(0);
    expect(p.lapProgress).toBe(140);
    walk(s, 6);
    const lines = lapLines(s);
    expect(lines).toHaveLength(1);
    expect(lapPaid(lines[0])).toBe(2000);
    expect(p.laps).toBe(1);
    expect(p.lapProgress).toBe(2);
    expect(p.position).toBe(2);
    // Lap income comes before property tax and interest in the log.
    const at = s.log.indexOf(lines[0]);
    expect(s.log.findIndex((l) => l.includes('property tax'))).toBeGreaterThan(at);
  });

  it('prorates lap income after a flight: skipping a third of the board pays about $1,330', () => {
    const s = twoPlayers();
    const p = s.players[0];
    walk(s, 15); // New Year -> Airport 1
    expect(p.position).toBe(AIRPORTS[0]);
    expect(s.canFly).toBe(true);
    fly(s, AIRPORTS[3]); // Airport 1 (15) -> Airport 4 (63): 48 squares skipped
    expect(p.lapProgress).toBe(15);
    walk(s, SIZE - AIRPORTS[3] + 1);
    expect(lapPaid(lapLines(s)[0])).toBe(Math.floor((2000 * 96) / 144 / 10) * 10);
    expect(lapPaid(lapLines(s)[0])).toBe(1330);
  });

  it('counts forward card moves but not backward moves, swaps, flights or sailing', () => {
    const s = twoPlayers();
    const p = s.players[0];
    const event = BOARD.filter((q) => q.type === 'event')[1].index;
    // Advance to New Year from a World Event: the squares to New Year count.
    p.position = event - 4;
    p.lapProgress = 100;
    rollAs(s, 4, [cardIndex('advance-new-year')]);
    expect(lapPaid(lapLines(s)[0])).toBe(lapIncome({ ...p, lapProgress: 100 + 4 + SIZE - event }));
    expect(p.position).toBe(0);
    expect(p.lapProgress).toBe(0);
    // Wrong turn: back 3, no progress.
    p.position = event - 5;
    p.lapProgress = 10;
    rollAs(s, 5, [cardIndex('go-back-3')]);
    expect(p.position).toBe(event - 3);
    expect(p.lapProgress).toBe(15);
    // Swap places: a teleport, no progress.
    s.players[1].position = 140;
    p.position = event - 6;
    rollAs(s, 6, [cardIndex('swap-places')]);
    expect(p.position).toBe(140);
    expect(p.lapProgress).toBe(21);
    // Remote work: forward 2 counts.
    p.position = event - 7;
    rollAs(s, 7, [cardIndex('remote-work')]);
    expect(p.lapProgress).toBe(21 + 7 + 2);
  });

  it('never pays more than $2,000 per 144 squares walked, whatever mix of rolls, flights, sailing, swaps and backward cards', () => {
    const deck = ['tax-refund', 'go-back-3', 'visa-denied', 'swap-places', 'burglary'].map(cardIndex);
    const seen = { fly: 0, sail: 0, swap: 0, payouts: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const s = createGame(['diplomat', 'banker', 'landlord'].map((roleId, i) => ({ name: `P${i}`, isBot: false, roleId })), seed, 0);
      const walked = [0, 0, 0];
      const paid = [0, 0, 0];
      let pick = seed * 7919;
      const choose = (n: number) => ((pick = (pick * 1103515245 + 12345) % 2147483648) >>> 16) % n;
      for (let step = 0; step < 900 && s.phase !== 'gameOver'; step++) {
        const p = s.players[s.current];
        s.log = [];
        if (s.phase === 'roll') {
          const k = choose(deck.length);
          s.deck = Array(6).fill([...deck.slice(k), ...deck.slice(0, k)]).flat(); // only cards that never move a player forward
          p.cash = Math.max(p.cash, 5000); // keep everyone in the game
          roll(s);
          if (s.dice) walked[p.id] += s.dice[0] + s.dice[1];
        } else {
          const r = choose(4);
          if (r === 0 && s.canFly) fly(s, AIRPORTS.filter((a) => a !== p.position)[choose(AIRPORTS.length - 1)]), seen.fly++;
          else if (r === 1 && s.canSail) sail(s, seaRoutesFrom(p.position)[choose(seaRoutesFrom(p.position).length)].dest), seen.sail++;
          else endTurn(s);
        }
        if (s.log.some((l) => l.includes('swapped places'))) seen.swap++;
        for (const q of s.players) for (const l of lapLines(s, q.name)) paid[q.id] += lapPaid(l), seen.payouts++;
        for (const q of s.players) expect(paid[q.id], `seed ${seed} ${q.name}`).toBeLessThanOrEqual((RULES.lapIncome.amount * walked[q.id]) / SIZE);
      }
      expect(walked.some((w) => w > 2 * SIZE)).toBe(true);
    }
    // The sequences really did mix in every kind of move.
    expect(seen.fly).toBeGreaterThan(20);
    expect(seen.sail).toBeGreaterThan(20);
    expect(seen.swap).toBeGreaterThan(20);
    expect(seen.payouts).toBeGreaterThan(100);
  });
});

describe('flights', () => {
  it('charges each band its fare, to the destination owner with the airport bonus, or to the bank', () => {
    const bands = Object.fromEntries(RULES.airports.flightBands.map((b) => [b.id, b.fare]));
    expect(bands).toEqual({ short: 100, medium: 200, long: 400 });
    for (const band of ['short', 'medium', 'long'] as const) {
      const f = FLIGHTS.find((x) => x.band === band)!;
      // To the bank (unowned destination).
      let s = twoPlayers();
      Object.assign(s.players[0], { position: f.a });
      Object.assign(s, { phase: 'action', canFly: true });
      expect(flightFare(s, f.b)).toBe(bands[band]);
      fly(s, f.b);
      expect(s.players[0].cash).toBe(10000 - bands[band]);
      expect(s.players[1].cash).toBe(10000);
      // To the owner of the destination, +10% per extra airport they own.
      s = twoPlayers();
      Object.assign(s.players[0], { position: f.a });
      Object.assign(s, { phase: 'action', canFly: true });
      const others = AIRPORTS.filter((x) => x !== f.a && x !== f.b);
      give(s, 1, [f.b, others[0], others[1]]);
      const fare = Math.round(bands[band] * 1.2);
      expect(flightFare(s, f.b)).toBe(fare);
      fly(s, f.b);
      expect(s.players[0].cash).toBe(10000 - fare);
      expect(s.players[1].cash).toBe(10000 + fare);
      expect(s.players[0].position).toBe(f.b);
      expect(s.pendingBuy).toBeNull();
      expect(() => fly(s, f.a)).toThrow('cannot fly now');
    }
  });

  it('gives the Diplomat half fares, skips a delayed owner, and flies free into your own airport', () => {
    const f = FLIGHTS.find((x) => x.band === 'long')!;
    const s = twoPlayers(); // player 1 is the Diplomat
    s.current = 1;
    Object.assign(s.players[1], { position: f.a });
    Object.assign(s, { phase: 'action', canFly: true });
    expect(flightFare(s, f.b)).toBe(200);
    give(s, 0, [f.b]);
    s.players[0].skipAirportIncome = true;
    fly(s, f.b);
    expect(s.players[1].cash).toBe(10000 - 200);
    expect(s.players[0].cash).toBe(10000); // flight delayed: the fare goes nowhere
    expect(s.players[0].skipAirportIncome).toBe(false);
    const t = twoPlayers();
    give(t, 0, [f.b]);
    Object.assign(t.players[0], { position: f.a });
    Object.assign(t, { phase: 'action', canFly: true });
    expect(flightFare(t, f.b)).toBe(0);
  });

  it('has a band for every pair of airports, the same both ways', () => {
    for (const a of AIRPORTS) for (const b of AIRPORTS) if (a !== b) expect(flightBand(a, b)).toBe(flightBand(b, a));
  });
});

describe('seaports and sailing', () => {
  const route = SEA_ROUTES.find((r) => r.id === 'cape-route')!; // South Atlantic Port <-> Coral Sea Port

  it('lets you sail only after landing on a seaport, only along a listed route, and once a turn', () => {
    const s = twoPlayers();
    const p = s.players[0];
    p.position = route.a - 6;
    rollAs(s, 6);
    expect(p.position).toBe(route.a);
    expect(s.canSail).toBe(true);
    expect(s.canFly).toBe(false);
    const notLinked = SEAPORTS.find((x) => x !== route.a && !seaRoutesFrom(route.a).some((r) => r.dest === x))!;
    expect(() => sail(s, notLinked)).toThrow('no sea route there');
    expect(() => sail(s, AIRPORTS[0])).toThrow('no sea route there');
    expect(() => sail(s, route.a)).toThrow('no sea route there');
    expect(() => fly(s, AIRPORTS[0])).toThrow('cannot fly now');
    const before = p.cash;
    sail(s, route.b);
    expect(p.position).toBe(route.b);
    expect(p.cash).toBe(before - RULES.seaports.sailFare);
    expect(s.players[1].cash).toBe(10000); // nobody owns the port: the fare goes to the bank
    expect(s.pendingBuy).toBe(route.b);
    expect(s.canSail).toBe(false);
    expect(() => sail(s, route.a)).toThrow('cannot sail now');
    // Standing on a seaport without having landed there this turn is not enough.
    endTurn(s);
    s.current = 0;
    s.phase = 'action';
    expect(() => sail(s, route.a)).toThrow('cannot sail now');
  });

  it('pays the sail fare to the destination owner (with the seaport bonus), and the Diplomat pays half', () => {
    const s = twoPlayers();
    s.current = 1; // Diplomat
    Object.assign(s.players[1], { position: route.a });
    Object.assign(s, { phase: 'action', canSail: true });
    give(s, 0, [route.b, SEAPORTS.find((x) => x !== route.a && x !== route.b)!]);
    const fare = Math.round(RULES.seaports.sailFare * 1.1 * 0.5);
    expect(sailFare(s, route.b)).toBe(fare);
    sail(s, route.b);
    expect(s.players[1].cash).toBe(10000 - fare);
    expect(s.players[0].cash).toBe(10000 + fare);
    // Sailing into your own port is free; to the bank otherwise.
    const t = twoPlayers();
    Object.assign(t.players[0], { position: route.b });
    Object.assign(t, { phase: 'action', canSail: true });
    give(t, 0, [route.a]);
    expect(sailFare(t, route.a)).toBe(0);
  });

  it('charges a docking fee to the owner, +10% per extra seaport, half for the Diplomat', () => {
    for (const [owned, payer, expected] of [[1, 0, 50], [2, 0, 55], [3, 0, 60], [3, 1, 30]] as const) {
      const s = twoPlayers();
      const owner = 1 - payer;
      const port = route.a;
      give(s, owner, [port, ...SEAPORTS.filter((x) => x !== port).slice(0, owned - 1)]);
      s.players[payer].position = port - 4;
      s.current = payer;
      s.phase = 'roll';
      s.rng = SEEDS.get(4)!;
      const before = s.players[owner].cash;
      roll(s);
      expect(s.players[payer].position).toBe(port);
      expect(s.players[owner].cash - before, `${owned} ports, payer ${payer}`).toBe(expected);
    }
  });

  it('can be bought and traded like any other property', () => {
    const s = twoPlayers();
    const p = s.players[0];
    p.position = route.a - 6;
    rollAs(s, 6);
    expect(s.pendingBuy).toBe(route.a);
    const before = p.cash;
    buy(s);
    expect(s.owners[route.a]).toBe(0);
    expect(p.cash).toBe(before - RULES.seaports.price);
    expect(validateTrade(s, { from: 0, to: 1, give: [route.a], get: [], cash: -100 })).toBeNull();
    executeTrade(s, { from: 0, to: 1, give: [route.a], get: [], cash: -100 });
    expect(s.owners[route.a]).toBe(1);
  });
});
