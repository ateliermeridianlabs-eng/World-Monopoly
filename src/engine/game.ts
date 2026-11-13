import { BOARD, CARDS, FLIGHTS, PLAYER_COLORS, RULES, SEA_ROUTES, roleById, sectionById } from './data';
import { nextRandom, randomInt, shuffle } from './rng';
import type { Card, Flight, GameState, Player, PlayerSetup, Role, SeaRoute, Square, TradeOffer } from './types';

const SIZE = BOARD.length;
const HOTEL = RULES.building.maxHousesBeforeHotel + 1;
const MAX_LOG = 200;

const citiesBySection = new Map<string, number[]>();
const utilitiesBySection = new Map<string, number[]>();
for (const sq of BOARD) {
  if (!sq.section) continue;
  const map = sq.type === 'city' ? citiesBySection : sq.type === 'utility' ? utilitiesBySection : null;
  if (!map) continue;
  if (!map.has(sq.section)) map.set(sq.section, []);
  map.get(sq.section)!.push(sq.index);
}
const AIRPORTS = BOARD.filter((s) => s.type === 'airport').map((s) => s.index);
const SEAPORTS = BOARD.filter((s) => s.type === 'seaport').map((s) => s.index);
const flightByPair = new Map<string, Flight>(FLIGHTS.map((f) => [`${Math.min(f.a, f.b)}-${Math.max(f.a, f.b)}`, f]));

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function createGame(setups: PlayerSetup[], seed = Date.now(), roundLimit = RULES.roundLimit.default): GameState {
  if (setups.length < RULES.players.min || setups.length > RULES.players.max) {
    throw new Error(`need ${RULES.players.min}-${RULES.players.max} players`);
  }
  const roleIds = setups.map((s) => s.roleId);
  if (new Set(roleIds).size !== roleIds.length) throw new Error('roles must be unique');
  const players: Player[] = setups.map((s, i) => {
    const role = roleById.get(s.roleId);
    if (!role) throw new Error(`unknown role ${s.roleId}`);
    return {
      id: i,
      name: s.name,
      color: PLAYER_COLORS[i],
      isBot: s.isBot,
      roleId: s.roleId,
      cash: RULES.startingCash + (role.startingCashDelta ?? 0),
      position: 0,
      laps: 0,
      lapProgress: 0,
      bankrupt: false,
      skipNextTurn: false,
      skipAirportIncome: false,
    };
  });
  const state: GameState = {
    version: 4,
    players,
    owners: {},
    levels: {},
    current: 0,
    phase: 'roll',
    turn: 1,
    roundLimit,
    dice: null,
    pendingBuy: null,
    canFly: false,
    canSail: false,
    lastEvent: null,
    deck: [],
    rng: seed | 0,
    winner: null,
    log: [],
  };
  state.deck = shuffle(state, CARDS.map((_, i) => i));
  log(state, `Game started. ${players[0].name} goes first.`);
  return state;
}

// ---------- queries ----------

export const square = (index: number): Square => BOARD[index];
export const roleOf = (p: Player): Role => roleById.get(p.roleId)!;
export const currentPlayer = (s: GameState): Player => s.players[s.current];
export const ownerOf = (s: GameState, index: number): Player | null => {
  const id = s.owners[index];
  return id === undefined ? null : s.players[id];
};
export const levelOf = (s: GameState, index: number) => s.levels[index] ?? 0;
export const ownedBy = (s: GameState, playerId: number) =>
  Object.keys(s.owners).map(Number).filter((i) => s.owners[i] === playerId);
export const sectionCities = (sectionId: string) => citiesBySection.get(sectionId) ?? [];
export const sectionUtilities = (sectionId: string) => utilitiesBySection.get(sectionId) ?? [];
export const isOver = (s: GameState) => s.phase === 'gameOver';
export const activePlayers = (s: GameState) => s.players.filter((p) => !p.bankrupt);

export function tierOf(price: number) {
  return RULES.tiers.find((t) => price <= t.maxPrice)!;
}

export function buildCost(index: number, player: Player) {
  const base = tierOf(square(index).price!).houseCost;
  return Math.round(base * (roleOf(player).buildCostMultiplier ?? 1));
}

export function buildingValue(s: GameState, index: number) {
  return tierOf(square(index).price!).houseCost * levelOf(s, index);
}

export function netWorth(s: GameState, p: Player) {
  return ownedBy(s, p.id).reduce((sum, i) => sum + (square(i).price ?? 0) + (square(i).type === 'city' ? buildingValue(s, i) : 0), p.cash);
}

function countInSection(s: GameState, playerId: number, sectionId: string, utilities: boolean) {
  const squares = utilities ? [...sectionCities(sectionId), ...sectionUtilities(sectionId)] : sectionCities(sectionId);
  return squares.filter((i) => s.owners[i] === playerId).length;
}

export function sectionBonus(s: GameState, owner: Player, sectionId: string) {
  const r = RULES.rent;
  const owned = countInSection(s, owner.id, sectionId, r.sectionBonusCounts === 'citiesAndUtilities');
  const cap = roleOf(owner).sectionBonusCap ?? r.sectionBonusCap;
  return Math.min(cap, r.sectionBonusPerExtraSquare * Math.max(0, owned - 1));
}

export function cityRent(s: GameState, index: number) {
  const owner = ownerOf(s, index);
  const sq = square(index);
  const r = RULES.rent;
  const base = Math.max(r.minimumBaseRent, Math.round((sq.price! * r.baseRentPercentOfPrice) / 100));
  const raw = base * r.levelMultipliers[levelOf(s, index)];
  return owner ? Math.round(raw * (1 + sectionBonus(s, owner, sq.section!))) : raw;
}

/** Owner bonus on fees and fares at an airport or seaport: +bonus for each other square of that type the owner has. */
export function transportMultiplier(s: GameState, owner: Player, type: 'airport' | 'seaport') {
  const own = (type === 'airport' ? AIRPORTS : SEAPORTS).filter((i) => s.owners[i] === owner.id).length;
  const bonus = type === 'airport' ? RULES.airports.bonusPerExtraAirport : RULES.seaports.bonusPerExtraSeaport;
  return 1 + bonus * Math.max(0, own - 1);
}

/** A fee or fare of `base` at airport/seaport `index`, paid by `payer`: owner bonus, then the payer's role discount. */
export function travelFee(s: GameState, index: number, payer: Player, base: number) {
  const owner = ownerOf(s, index);
  const type = square(index).type === 'seaport' ? 'seaport' : 'airport';
  const mult = owner ? transportMultiplier(s, owner, type) : 1;
  return Math.round(base * mult * (roleOf(payer).travelFeeMultiplier ?? 1));
}

/** The flight between two airports (its band and distance). */
export function flightBetween(a: number, b: number): Flight {
  const f = flightByPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
  if (!f) throw new Error('bad destination');
  return f;
}

export const flightBand = (a: number, b: number) => RULES.airports.flightBands.find((x) => x.id === flightBetween(a, b).band)!;

/** Sea routes from seaport `from`, each with the port at its other end. */
export function seaRoutesFrom(from: number): { route: SeaRoute; dest: number }[] {
  return SEA_ROUTES.filter((r) => r.a === from || r.b === from).map((route) => ({ route, dest: route.a === from ? route.b : route.a }));
}

/** Lap income a player would get at New Year now: amount x min(1, lapProgress / board size), rounded down. */
export function lapIncome(p: Player) {
  const l = RULES.lapIncome;
  const share = Math.min(1, p.lapProgress / SIZE);
  return Math.floor((l.amount * share) / l.roundDownTo) * l.roundDownTo;
}

/** Multiplier on build fees a meter owner earns. */
export function utilityMultiplier(s: GameState, owner: Player, sectionId: string) {
  const u = RULES.utilities;
  let m = 1;
  if (sectionUtilities(sectionId).every((i) => s.owners[i] === owner.id)) m *= u.allFourMetersMultiplier;
  const control = roleOf(owner).alwaysControlBonus || countInSection(s, owner.id, sectionId, false) >= u.controlBonusMajorityOfCities;
  if (control) m *= u.controlBonusMultiplier;
  return Math.min(m, u.maxMultiplier);
}

export interface FeeLine { meter: number; to: Player | null; amount: number }

/** Utility build fees the builder pays for raising `index` by one level. */
export function utilityFees(s: GameState, index: number, builder: Player): FeeLine[] {
  const u = RULES.utilities;
  const sectionId = square(index).section!;
  const hotel = levelOf(s, index) + 1 === HOTEL;
  const base = hotel ? u.feePerHotel : u.feePerHouse;
  const lines: FeeLine[] = [];
  for (const meter of sectionUtilities(sectionId)) {
    const owner = ownerOf(s, meter);
    if (owner?.id === builder.id) continue;
    const surcharge = roleOf(builder).utilityFeeMultiplier ?? 1;
    const active = owner && !owner.bankrupt && (!u.requiresCityInSection || countInSection(s, owner.id, sectionId, false) > 0);
    if (active) lines.push({ meter, to: owner, amount: Math.round(base * surcharge * utilityMultiplier(s, owner, sectionId)) });
    else lines.push({ meter, to: null, amount: Math.round(base * surcharge) });
  }
  return lines;
}

export type BuildCheck = { ok: true; cost: number; fees: FeeLine[] } | { ok: false; reason: string };

export function canBuild(s: GameState, index: number): BuildCheck {
  const p = currentPlayer(s);
  const sq = square(index);
  if (s.phase !== 'action') return { ok: false, reason: 'Roll first' };
  if (sq.type !== 'city') return { ok: false, reason: 'Only cities take buildings' };
  if (s.owners[index] !== p.id) return { ok: false, reason: 'You do not own this city' };
  const level = levelOf(s, index);
  if (level >= HOTEL) return { ok: false, reason: 'Already has a hotel' };
  if (level + 1 === HOTEL && RULES.building.hotelRequiresFullSection && countInSection(s, p.id, sq.section!, false) < sectionCities(sq.section!).length) {
    return { ok: false, reason: `Hotel needs all ${sectionCities(sq.section!).length} cities in ${sectionById.get(sq.section!)!.name}` };
  }
  const cost = buildCost(index, p);
  const fees = utilityFees(s, index, p);
  const total = cost + fees.reduce((a, f) => a + f.amount, 0);
  if (p.cash < total) return { ok: false, reason: `Needs ${money(total)} (build + utility fees)` };
  return { ok: true, cost, fees };
}

export function incomeTaxRate(s: GameState, p: Player) {
  const flat = roleOf(p).flatIncomeTax;
  if (flat !== undefined) return flat;
  const worth = netWorth(s, p);
  return RULES.salary.incomeTaxBrackets.find((b) => b.netWorthBelow === null || worth < b.netWorthBelow)!.rate;
}

export function costOfLiving(s: GameState, p: Player) {
  const c = RULES.costOfLiving;
  const tierSum = ownedBy(s, p.id)
    .filter((i) => square(i).type === 'city')
    .reduce((sum, i) => sum + tierOf(square(i).price!).level, 0);
  let amount = Math.max(c.minimum, tierSum * c.perTierLevel);
  if (p.laps < c.gracePeriodLaps) amount *= c.gracePeriodMultiplier;
  amount *= roleOf(p).costOfLivingMultiplier ?? 1;
  return Math.round(amount);
}

// ---------- internals ----------

function log(s: GameState, line: string) {
  s.log.push(line);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
}

function receive(p: Player, amount: number) {
  p.cash += amount;
}

/** Pays `amount`, liquidating assets if needed. Returns false if the payer went bankrupt. */
function pay(s: GameState, p: Player, amount: number, to: Player | null, reason: string): boolean {
  if (amount <= 0) return true;
  p.cash -= amount;
  if (p.cash < 0) liquidate(s, p);
  const shortfall = Math.max(0, -p.cash);
  if (to) receive(to, amount - shortfall);
  log(s, `${p.name} paid ${money(amount - shortfall)}${to ? ` to ${to.name}` : ''} (${reason}).`);
  if (shortfall > 0) {
    goBankrupt(s, p);
    return false;
  }
  return true;
}

function liquidate(s: GameState, p: Player) {
  const refund = RULES.building.sellRefundPercent / 100;
  const cities = () => ownedBy(s, p.id).filter((i) => levelOf(s, i) > 0).sort((a, b) => levelOf(s, b) - levelOf(s, a));
  while (p.cash < 0 && cities().length) {
    const i = cities()[0];
    s.levels[i] = levelOf(s, i) - 1;
    p.cash += Math.round(tierOf(square(i).price!).houseCost * refund);
    log(s, `${p.name} sold a building in ${square(i).name} to cover debt.`);
  }
  const sale = RULES.bankruptcy.propertySaleRefundPercent / 100;
  const props = ownedBy(s, p.id).sort((a, b) => (square(a).price ?? 0) - (square(b).price ?? 0));
  while (p.cash < 0 && props.length) {
    const i = props.shift()!;
    delete s.owners[i];
    p.cash += Math.round((square(i).price ?? 0) * sale);
    log(s, `${p.name} sold ${square(i).name} to the bank to cover debt.`);
  }
}

function goBankrupt(s: GameState, p: Player) {
  p.bankrupt = true;
  p.cash = 0;
  for (const i of ownedBy(s, p.id)) {
    delete s.owners[i];
    delete s.levels[i];
  }
  log(s, `💥 ${p.name} is bankrupt.`);
  const left = activePlayers(s);
  if (left.length === 1) finish(s, left[0]);
}

function finish(s: GameState, winner: Player) {
  s.phase = 'gameOver';
  s.winner = winner.id;
  s.pendingBuy = null;
  s.canFly = false;
  s.canSail = false;
  log(s, `🏆 ${winner.name} wins.`);
}

function payCheckpoint(s: GameState, p: Player) {
  if (roleOf(p).noSalary) return;
  const gross = RULES.salary.perCheckpoint;
  const rate = incomeTaxRate(s, p);
  const net = Math.round(gross * (1 - rate));
  receive(p, net);
  log(s, `${p.name} collected ${money(net)} salary (${Math.round(rate * 100)}% income tax).`);
}

/** Every way of reaching or passing New Year goes through move(), which calls this. */
function newYear(s: GameState, p: Player) {
  const income = lapIncome(p);
  const walked = Math.min(p.lapProgress, SIZE);
  p.lapProgress = 0;
  p.laps += 1;
  receive(p, income);
  log(s, `${p.name} collected ${money(income)} lap income (${walked} of ${SIZE} squares walked).`);
  const role = roleOf(p);
  if (role.interestRate && p.cash > (role.interestAbove ?? 0)) {
    const interest = Math.round((p.cash - (role.interestAbove ?? 0)) * role.interestRate);
    receive(p, interest);
    log(s, `${p.name} earned ${money(interest)} interest.`);
  }
  const propValue = ownedBy(s, p.id).reduce((sum, i) => sum + (square(i).price ?? 0), 0);
  const tax = Math.round((propValue * RULES.propertyTax.percentOfPropertyValue) / 100 * (role.propertyTaxMultiplier ?? 1));
  log(s, `🎆 ${p.name} reached New Year (lap ${p.laps}).`);
  pay(s, p, tax, null, 'property tax');
}

/**
 * Moves along the track: forward (each square counts toward lap income; pays every checkpoint and New Year
 * passed) or backward (pays and counts nothing). The only way to reach New Year.
 */
function move(s: GameState, p: Player, steps: number) {
  if (steps < 0) {
    p.position = (p.position + steps + SIZE * 10) % SIZE;
    return;
  }
  for (let k = 0; k < steps && !p.bankrupt; k++) {
    p.position = (p.position + 1) % SIZE;
    p.lapProgress += 1;
    const sq = square(p.position);
    if (sq.checkpoint) payCheckpoint(s, p);
    if (p.position === 0) newYear(s, p);
  }
}

function moveTo(s: GameState, p: Player, target: number) {
  move(s, p, (target - p.position + SIZE) % SIZE);
}

/** Airport landing fee or seaport docking fee for landing on `index`. */
function landingFee(s: GameState, p: Player, index: number, multiplier = 1) {
  const owner = ownerOf(s, index);
  if (!owner || owner.id === p.id) return;
  const port = square(index).type === 'seaport';
  const fee = travelFee(s, index, p, port ? RULES.seaports.dockingFee : RULES.airports.landingFee) * multiplier;
  if (port) {
    pay(s, p, fee, owner, `docking fee at ${square(index).name}`);
    return;
  }
  if (owner.skipAirportIncome) {
    owner.skipAirportIncome = false;
    log(s, `${owner.name}'s airport income was skipped (flight delayed).`);
    return;
  }
  pay(s, p, fee, owner, `landing fee at ${square(index).name}`);
}

function resolveLanding(s: GameState, p: Player, depth = 0) {
  if (p.bankrupt || s.phase === 'gameOver') return;
  const sq = square(p.position);
  log(s, `${p.name} landed on ${sq.name}.`);
  switch (sq.type) {
    case 'city':
    case 'utility':
    case 'airport':
    case 'seaport': {
      const owner = ownerOf(s, sq.index);
      if (!owner) s.pendingBuy = sq.index;
      else if (owner.id !== p.id && sq.type === 'city') pay(s, p, cityRent(s, sq.index), owner, `rent in ${sq.name}`);
      else if (sq.type === 'airport' || sq.type === 'seaport') landingFee(s, p, sq.index);
      if (sq.type === 'airport') s.canFly = true;
      if (sq.type === 'seaport') s.canSail = true;
      break;
    }
    case 'tax':
      pay(s, p, RULES.taxSquare.amount, null, 'tax office');
      break;
    case 'event':
      if (depth < 3) drawCard(s, p, depth);
      break;
    case 'disaster':
      disaster(s, sq.section!);
      break;
    default:
      break;
  }
}

function drawCard(s: GameState, p: Player, depth: number) {
  if (!s.deck.length) s.deck = shuffle(s, CARDS.map((_, i) => i));
  const card: Card = CARDS[s.deck.shift()!];
  s.lastEvent = { title: card.name, text: card.text, kind: card.kind };
  log(s, `🃏 ${p.name} drew "${card.name}": ${card.text}`);
  const e = card.effect;
  switch (e.type) {
    case 'gain':
      receive(p, e.amount);
      break;
    case 'gainPerProperty':
      receive(p, e.amount * ownedBy(s, p.id).length);
      break;
    case 'gainAndMove':
      receive(p, e.amount);
      move(s, p, e.steps);
      resolveLanding(s, p, depth + 1);
      break;
    case 'payAndSkip':
      p.skipNextTurn = true;
      pay(s, p, e.amount, null, card.name);
      break;
    case 'skipAirportIncome':
      p.skipAirportIncome = true;
      break;
    case 'payPercentCash':
      pay(s, p, Math.round((p.cash * e.percent) / 100), null, card.name);
      break;
    case 'pay':
      pay(s, p, e.amount, null, card.name);
      break;
    case 'payPerCityInSection': {
      const sectionId = square(p.position).section;
      const n = sectionId ? countInSection(s, p.id, sectionId, false) : 0;
      pay(s, p, e.amount * n, null, card.name);
      break;
    }
    case 'backToAirport': {
      const behind = AIRPORTS.map((a) => ({ a, d: (p.position - a + SIZE) % SIZE })).filter((x) => x.d > 0).sort((x, y) => x.d - y.d)[0];
      move(s, p, -behind.d);
      resolveLanding(s, p, depth + 1);
      break;
    }
    case 'nearestAirport': {
      const ahead = AIRPORTS.map((a) => ({ a, d: (a - p.position + SIZE) % SIZE })).filter((x) => x.d > 0).sort((x, y) => x.d - y.d)[0];
      move(s, p, ahead.d);
      if (p.bankrupt) break;
      log(s, `${p.name} landed on ${square(p.position).name}.`);
      if (!ownerOf(s, p.position)) s.pendingBuy = p.position;
      else landingFee(s, p, p.position, e.feeMultiplier);
      s.canFly = true;
      break;
    }
    case 'nearestSeaport': {
      const ahead = SEAPORTS.map((a) => ({ a, d: (a - p.position + SIZE) % SIZE })).filter((x) => x.d > 0).sort((x, y) => x.d - y.d)[0];
      move(s, p, ahead.d);
      if (p.bankrupt) break;
      log(s, `${p.name} landed on ${square(p.position).name}.`);
      if (!ownerOf(s, p.position)) s.pendingBuy = p.position;
      else landingFee(s, p, p.position, e.feeMultiplier);
      s.canSail = true;
      break;
    }
    case 'payPerSeaport':
      pay(s, p, e.amount * SEAPORTS.filter((i) => s.owners[i] === p.id).length, null, card.name);
      break;
    case 'advanceTo':
      moveTo(s, p, e.square);
      break;
    case 'move':
      move(s, p, e.steps);
      resolveLanding(s, p, depth + 1);
      break;
    case 'swapPlaces': {
      const others = activePlayers(s).filter((o) => o.id !== p.id);
      const o = others[randomInt(s, others.length)];
      [p.position, o.position] = [o.position, p.position];
      log(s, `${p.name} swapped places with ${o.name}.`);
      break;
    }
  }
}

function disaster(s: GameState, sectionId: string) {
  const section = sectionById.get(sectionId)!;
  const name = section.disasters[randomInt(s, section.disasters.length)];
  const destroy = nextRandom(s) < RULES.disasters.destroyChance;
  const developed = sectionCities(sectionId).filter((i) => levelOf(s, i) > 0 && s.owners[i] !== undefined);
  let text: string;
  if (!developed.length) {
    text = `${name} hits ${section.name}. No buildings there yet, no damage.`;
  } else if (destroy) {
    const hit: string[] = [];
    const byOwner = new Map<number, number>();
    for (const i of developed) {
      const o = s.owners[i];
      const best = byOwner.get(o);
      if (best === undefined || levelOf(s, i) > levelOf(s, best)) byOwner.set(o, i);
    }
    for (const i of byOwner.values()) {
      s.levels[i] = 0;
      hit.push(square(i).name);
    }
    text = `${name} destroys all buildings in ${hit.join(', ')}.`;
  } else {
    for (const i of developed) s.levels[i] = levelOf(s, i) - 1;
    text = `${name} hits ${section.name}. Every developed city loses one building level.`;
  }
  s.lastEvent = { title: `${name} in ${section.name}`, text, kind: 'disaster' };
  log(s, `⚠️ ${text}`);
}

// ---------- actions ----------

export function roll(s: GameState) {
  if (s.phase !== 'roll') throw new Error('not in roll phase');
  const p = currentPlayer(s);
  s.lastEvent = null;
  s.dice = Array.from({ length: RULES.dice.count }, () => 1 + randomInt(s, RULES.dice.sides));
  const steps = s.dice.reduce((a, b) => a + b, 0);
  log(s, `${p.name} rolled ${s.dice.join(' + ')} = ${steps}.`);
  move(s, p, steps);
  resolveLanding(s, p);
  if (isOver(s)) return;
  if (!p.bankrupt) pay(s, p, costOfLiving(s, p), null, 'cost of living');
  if (isOver(s)) return;
  if (p.bankrupt) {
    advance(s);
    return;
  }
  s.phase = 'action';
}

export function buy(s: GameState) {
  const p = currentPlayer(s);
  const i = s.pendingBuy;
  if (s.phase !== 'action' || i === null) throw new Error('nothing to buy');
  const price = square(i).price!;
  if (p.cash < price) throw new Error('not enough cash');
  p.cash -= price;
  s.owners[i] = p.id;
  s.pendingBuy = null;
  log(s, `${p.name} bought ${square(i).name} for ${money(price)}.`);
}

export function build(s: GameState, index: number) {
  const check = canBuild(s, index);
  if (!check.ok) throw new Error(check.reason);
  const p = currentPlayer(s);
  p.cash -= check.cost;
  for (const f of check.fees) {
    p.cash -= f.amount;
    if (f.to) receive(f.to, f.amount);
  }
  s.levels[index] = levelOf(s, index) + 1;
  const feeTotal = check.fees.reduce((a, f) => a + f.amount, 0);
  const what = s.levels[index] === HOTEL ? 'a hotel' : `house ${s.levels[index]}`;
  log(s, `${p.name} built ${what} in ${square(index).name} for ${money(check.cost)} + ${money(feeTotal)} utility fees.`);
}

export function sellBuilding(s: GameState, index: number) {
  const p = currentPlayer(s);
  if (s.phase !== 'action' || s.owners[index] !== p.id || levelOf(s, index) === 0) throw new Error('cannot sell here');
  s.levels[index] = levelOf(s, index) - 1;
  const refund = Math.round((tierOf(square(index).price!).houseCost * RULES.building.sellRefundPercent) / 100);
  receive(p, refund);
  log(s, `${p.name} sold a building in ${square(index).name} for ${money(refund)}.`);
}

/** Fare for the current player to fly from `from` (default: where they stand) to airport `dest`: the band's fare, owner bonus, role discount; free into their own airport. */
export function flightFare(s: GameState, dest: number, from = currentPlayer(s).position) {
  const p = currentPlayer(s);
  const owner = ownerOf(s, dest);
  if (owner?.id === p.id) return 0;
  return travelFee(s, dest, p, flightBand(from, dest).fare);
}

export function fly(s: GameState, dest: number) {
  const p = currentPlayer(s);
  if (s.phase !== 'action' || !s.canFly || square(p.position).type !== 'airport') throw new Error('cannot fly now');
  if (square(dest)?.type !== 'airport' || dest === p.position) throw new Error('bad destination');
  const band = flightBand(p.position, dest);
  const fare = flightFare(s, dest);
  if (p.cash < fare) throw new Error('not enough cash');
  const owner = ownerOf(s, dest);
  if (owner && owner.id !== p.id && owner.skipAirportIncome) {
    owner.skipAirportIncome = false;
    p.cash -= fare;
    log(s, `${p.name} paid ${money(fare)} fare; ${owner.name}'s income was skipped (flight delayed).`);
  } else {
    pay(s, p, fare, owner && owner.id !== p.id ? owner : null, `flight to ${square(dest).name}`);
  }
  p.position = dest;
  s.canFly = false;
  s.canSail = false;
  s.pendingBuy = ownerOf(s, dest) ? null : dest;
  log(s, `✈️ ${p.name} flew ${band.name.toLowerCase()} to ${square(dest).name}.`);
}

/** Fare for the current player to sail to seaport `dest`: sailFare, owner bonus, role discount; free into their own port. */
export function sailFare(s: GameState, dest: number) {
  const p = currentPlayer(s);
  const owner = ownerOf(s, dest);
  if (owner?.id === p.id) return 0;
  return travelFee(s, dest, p, RULES.seaports.sailFare);
}

/** Sails along a sea route from the seaport the current player landed on to the port at its other end. Arrival works like a flight's. */
export function sail(s: GameState, dest: number) {
  const p = currentPlayer(s);
  if (s.phase !== 'action' || !s.canSail || square(p.position).type !== 'seaport') throw new Error('cannot sail now');
  const way = seaRoutesFrom(p.position).find((r) => r.dest === dest);
  if (!way) throw new Error('no sea route there');
  const fare = sailFare(s, dest);
  if (p.cash < fare) throw new Error('not enough cash');
  const owner = ownerOf(s, dest);
  pay(s, p, fare, owner && owner.id !== p.id ? owner : null, `${way.route.name} to ${square(dest).name}`);
  p.position = dest;
  s.canSail = false;
  s.canFly = false;
  s.pendingBuy = ownerOf(s, dest) ? null : dest;
  log(s, `⚓ ${p.name} sailed the ${way.route.name} to ${square(dest).name}.`);
}

export function endTurn(s: GameState) {
  if (s.phase !== 'action') throw new Error('roll first');
  advance(s);
}

function advance(s: GameState) {
  s.pendingBuy = null;
  s.canFly = false;
  s.canSail = false;
  for (let guard = 0; guard < s.players.length * 2; guard++) {
    s.current = (s.current + 1) % s.players.length;
    if (s.current === 0) {
      s.turn += 1;
      if (s.roundLimit > 0 && s.turn > s.roundLimit) {
        log(s, `Round limit (${s.roundLimit}) reached.`);
        endGameByNetWorth(s);
        return;
      }
    }
    const p = currentPlayer(s);
    if (p.bankrupt) continue;
    if (p.skipNextTurn) {
      p.skipNextTurn = false;
      log(s, `${p.name} misses this turn.`);
      continue;
    }
    break;
  }
  s.phase = 'roll';
  s.dice = null;
}

/** Ends the game now; richest net worth wins. */
export function endGameByNetWorth(s: GameState) {
  const best = activePlayers(s).sort((a, b) => netWorth(s, b) - netWorth(s, a))[0];
  finish(s, best);
}

// ---------- trading ----------

/** Pure and independent of whose turn it is or the phase; only a finished game refuses trades. */
export function validateTrade(s: GameState, t: TradeOffer): string | null {
  if (s.phase === 'gameOver') return 'The game is over';
  const from = s.players[t.from];
  const to = s.players[t.to];
  if (!from || !to || from.id === to.id || from.bankrupt || to.bankrupt) return 'Pick another player';
  if (!t.give.length && !t.get.length) return 'Trade must include at least one property';
  if (!Number.isInteger(t.cash)) return 'Cash must be a whole number';
  if (t.give.some((i) => s.owners[i] !== from.id)) return `${from.name} does not own all offered properties`;
  if (t.get.some((i) => s.owners[i] !== to.id)) return `${to.name} does not own all requested properties`;
  if (t.cash > 0 && from.cash < t.cash) return `${from.name} cannot afford ${money(t.cash)}`;
  if (t.cash < 0 && to.cash < -t.cash) return `${to.name} cannot afford ${money(-t.cash)}`;
  return null;
}

export function executeTrade(s: GameState, t: TradeOffer) {
  const err = validateTrade(s, t);
  if (err) throw new Error(err);
  const from = s.players[t.from];
  const to = s.players[t.to];
  for (const i of t.give) s.owners[i] = to.id;
  for (const i of t.get) s.owners[i] = from.id;
  from.cash -= t.cash;
  to.cash += t.cash;
  const names = (xs: number[]) => (xs.length ? xs.map((i) => square(i).name).join(', ') : 'nothing');
  log(s, `🤝 ${from.name} traded ${names(t.give)}${t.cash > 0 ? ` + ${money(t.cash)}` : ''} to ${to.name} for ${names(t.get)}${t.cash < 0 ? ` + ${money(-t.cash)}` : ''}.`);
}

export { AIRPORTS, HOTEL, SEAPORTS, SIZE };
