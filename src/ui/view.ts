// The game screen: board, panel, detail card and trade modal. One render path for hot-seat and online play.
// The mode only shows up through the `Controller` the screen is mounted with: it supplies the game state,
// says whether this device may act, and performs actions (engine calls locally, intents online).

import { BOARD, RULES, sectionById } from '../engine/data';
import {
  AIRPORTS, HOTEL, SIZE, activePlayers, canBuild, cityRent, costOfLiving, currentPlayer, flightBand, flightFare, incomeTaxRate, lapIncome, levelOf,
  money, netWorth, ownedBy, ownerOf, roleOf, sailFare, seaRoutesFrom, square, tierOf, transportMultiplier, validateTrade,
} from '../engine/game';
import type { GameState, Player, TradeOffer } from '../engine/types';
import type { Intent, PendingTrade, Seat, SessionStatus } from '../net';
import { LANES, MAP, arcPath, boardPosition, labelPoint, mapOverSvg, mapUnderSvg, seaName, territoryKind, territoryPath, tileArt, tileIcon } from './tiles';
import { store } from './store';

export const app = document.getElementById('app')!;

export const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What the game screen needs to know about an online room. Absent in hot-seat play. */
export interface RoomView {
  code: string;
  link: string;
  /** Seat this device plays, or null when watching. */
  selfSeat: number | null;
  isHost: boolean;
  hostId: string;
  seats: Seat[];
  status: SessionStatus;
  /** Open human-to-human offers (any proposer, any target), oldest first. */
  pendingTrades: PendingTrade[];
  /** The net layer lets only the host's own seat end the game. */
  canFinish: boolean;
  /** Other people in the room, for the indicator. */
  online: number;
  networkError: string | null;
}

export interface Controller {
  game(): GameState | null;
  /** Online room info, or null for hot-seat. */
  room(): RoomView | null;
  /** True when this device may act for the current player (not a bot, game still running, connected). */
  canAct(): boolean;
  /**
   * Do something as the current player (trades: as `offer.from`, any time). Hot-seat: runs the engine now and
   * throws on a rule error; there `proposeTrade` means "resolve it now" (a bot decides, a human has already
   * confirmed). Online: sends the intent; refusals arrive later through notify().
   */
  perform(intent: Intent): void;
  /** Online host only. */
  convertToBot(seat: number): void;
  takeOver(): void;
  /** "Main menu" / "Leave game". */
  leave(): void;
  /** "New game" on the winner panel. */
  newGame(): void;
  /** Called after every render (hot-seat: autosave and bot stepping). */
  afterRender?(): void;
}

let ctl: Controller | null = null;
let selected: number | null = null;
let toast = '';
/** Inline confirm in the panel footer: 'finish', 'leave' or `bot:<seat>`. Online only. */
let confirming: string | null = null;
let showLinkInput = false;
/** After this device's own roll/end/fly: select and scroll to where the current player ends up once the state changes. */
let followBase: string | null = null;
let selectAfter = false;
let lastTurnKey: string | null = null;
type ModalKind = 'builder' | 'prompt';
let modalKind: ModalKind | null = null;
let promptId: number | null = null;
let promptTotal = 0;
/** Offers this device already answered and the host has not yet dropped, so the prompt does not flash back. Cleared on a refusal. */
const answered = new Set<number>();

// ---------- small helpers shared with the lobby ----------

export function localStorageGet(k: string) {
  return store.get(k);
}
export function localStorageSet(k: string, v: string) {
  store.set(k, v);
}

/** Copies `text`; when the clipboard is unavailable the invite panel shows a read-only field to select instead. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Invite link controls: a copy button, plus a read-only field once copying has failed once. */
export function inviteHtml(link: string, label = 'Copy invite link') {
  return `<div class="invite">
      <button data-act="copy-link" aria-label="${esc(label)}">${esc(label)}</button>
      <span class="small muted" data-copy-note role="status"></span>
      ${showLinkInput ? `<input readonly class="invite-link" data-invite-link value="${esc(link)}" aria-label="Invite link" />` : ''}
    </div>`;
}

export function bindInvite(root: ParentNode, link: string) {
  const note = root.querySelector<HTMLElement>('[data-copy-note]');
  const field = root.querySelector<HTMLInputElement>('[data-invite-link]');
  field?.addEventListener('focus', () => field.select());
  root.querySelector('[data-act="copy-link"]')?.addEventListener('click', async () => {
    if (await copyText(link)) {
      if (note) note.textContent = 'Copied';
      return;
    }
    showLinkInput = true;
    let input = root.querySelector<HTMLInputElement>('[data-invite-link]');
    if (!input) {
      input = document.createElement('input');
      input.readOnly = true;
      input.className = 'invite-link';
      input.value = link;
      input.setAttribute('data-invite-link', '');
      input.setAttribute('aria-label', 'Invite link');
      root.querySelector('.invite')?.append(input);
    }
    if (note) note.textContent = 'Copy this link:';
    input.focus();
    input.select();
  });
}

export function hostLostHtml(room: RoomView) {
  if (room.status !== 'host-lost') return '';
  return `<div class="banner" role="status">
      <strong>Host disconnected.</strong> Waiting for them to return…
      <button class="primary" data-act="takeover">Take over as host</button>
      <p class="small muted">Taking over continues from the last state this device received.</p>
    </div>`;
}

// ---------- mount ----------

/** Shows the game screen for `controller`. */
export function showGame(controller: Controller) {
  ctl = controller;
  const s = ctl.game();
  const room = ctl.room();
  confirming = null;
  toast = '';
  followBase = null;
  lastTurnKey = null;
  modalKind = null;
  promptId = null;
  answered.clear();
  const me = room?.selfSeat != null ? s?.players[room.selfSeat] : undefined;
  selected = me ? me.position : s ? currentPlayer(s).position : null;
  mountGame();
  update();
}

/** Forget the controller (back to the setup or lobby screen). */
export function detachGame() {
  ctl = null;
  selected = null;
  toast = '';
  confirming = null;
  showLinkInput = false;
  modalKind = null;
  promptId = null;
  answered.clear();
}

/** Select a tile (hot-seat bots move the selection along with them). */
export function select(index: number | null) {
  selected = index;
}

/** Shows a message in the panel's toast slot (e.g. a refused online action). */
export function notify(message: string) {
  toast = message;
  answered.clear(); // a refused answer must bring its offer back
  followBase = null;
  update(false);
}

function mountGame() {
  app.innerHTML = `
    <div class="game">
      <section class="board-wrap" aria-label="Board">
        <div class="zoom">
          <button data-zoom="-1" aria-label="Zoom out">−</button>
          <button data-zoom="1" aria-label="Zoom in">+</button>
          <button data-fit aria-label="Fit whole board">⤢</button>
          <button data-follow aria-label="Jump to current player">◎</button>
        </div>
        <div class="board-scroll"><div class="board" id="board"></div></div>
      </section>
      <aside class="panel" id="panel"></aside>
    </div>
    <div class="banner-root" id="banner"></div>
    <div class="modal-root" id="modal"></div>`;

  const board = document.getElementById('board')!;
  const t = MAP.title;
  // Every square is a territory on the map: an SVG path (the clickable, focusable square) plus an HTML label
  // at its pole of inaccessibility (art, name, price, buildings, tokens), which lets clicks through.
  board.innerHTML =
    `<div class="map" style="--map-w:${MAP.width};--map-h:${MAP.height}">
      <svg class="map-svg" viewBox="0 0 ${MAP.width} ${MAP.height}" preserveAspectRatio="none">
        ${mapUnderSvg()}
        <g class="territories">${BOARD.map((sq) => {
          const section = sq.section ? sectionById.get(sq.section)! : null;
          const label = `${sq.name}${section && sq.type !== 'utility' ? `, ${section.name}` : ''}${sq.price ? `, ${money(sq.price)}` : ''}`;
          return `<path class="tile tile-${sq.type} ${territoryKind(sq.index)}" data-tile="${sq.index}" d="${territoryPath(sq.index)}" role="button" tabindex="0" aria-label="${esc(label)}"${section ? ` style="--section:${section.color}"` : ''}><title>${esc(label)}</title></path>`;
        }).join('')}</g>
        <defs>${BOARD.map((sq) => `<clipPath id="tc${sq.index}"><path d="${territoryPath(sq.index)}"/></clipPath>`).join('')}</defs>
        <g class="owner-rims"></g>
        ${mapOverSvg()}
        <g class="travel"></g>
        <path class="hl hl-current"/><path class="hl hl-selected"/><path class="hl hl-focus"/>
      </svg>` +
    BOARD.map((sq) => {
      const { x, y, r } = boardPosition(sq.index);
      const section = sq.section ? sectionById.get(sq.section)! : null;
      return `
        <div class="parcel-label label-${sq.type} ${territoryKind(sq.index)}" data-label="${sq.index}" style="--x:${x};--y:${y};--r:${r};${section ? `--section:${section.color}` : ''}" aria-hidden="true">
          <span class="art">${tileArt(sq)}<span class="levels"></span></span>
          <span class="name">${esc(shortName(sq))}</span>
          ${sq.price ? `<span class="price">${money(sq.price)}</span>` : ''}
          ${sq.checkpoint ? '<span class="checkpoint" title="Salary checkpoint">⭐</span>' : ''}
          <span class="tokens"></span>
        </div>`;
    }).join('') +
    `<div class="board-center" style="--tx:${t.x};--ty:${t.y};--tw:${t.w};--th:${t.h}">
      <h2>World Monopoly</h2>
      <div class="legend">${[...sectionById.values()].map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
      <div class="legend legend-lines">
        <span><svg viewBox="0 0 24 8" aria-hidden="true"><path class="key-route" d="M1 4H23"/></svg>Play order</span>
        <span><svg viewBox="0 0 24 8" aria-hidden="true"><path class="key-lane" d="M1 4H23"/></svg>⚓ Sea route</span>
        <span><svg viewBox="0 0 24 8" aria-hidden="true"><path class="arc arc-short" d="M1 4H23"/></svg>✈️ Short</span>
        <span><svg viewBox="0 0 24 8" aria-hidden="true"><path class="arc arc-medium" d="M1 4H23"/></svg>Medium</span>
        <span><svg viewBox="0 0 24 8" aria-hidden="true"><path class="arc arc-long" d="M1 4H23"/></svg>Long-haul</span>
      </div>
      <p class="muted">Tap any territory for details.</p>
    </div></div>`;

  const choose = (el: Element | null) => {
    const tile = el?.closest<SVGElement>('[data-tile]');
    if (!tile) return;
    const index = Number(tile.dataset.tile);
    // A highlighted flight or sea destination: go there (the panel lists the same trips as buttons).
    const s = ctl?.game();
    const trip = s && ctl?.canAct() ? travelOptions(s).find((t) => t.dest === index) : undefined;
    if (trip) return perform({ type: trip.kind, dest: trip.dest }, true);
    selected = index;
    update(false);
  };
  board.addEventListener('click', (e) => choose(e.target as Element));
  board.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).matches('[data-tile]')) {
      e.preventDefault();
      choose(e.target as Element);
    }
  });
  const focusRing = board.querySelector('.hl-focus')!;
  board.addEventListener('focusin', (e) => {
    const tile = (e.target as Element).closest<SVGElement>('[data-tile]');
    focusRing.setAttribute('d', tile && tile.matches(':focus-visible') ? territoryPath(Number(tile.dataset.tile)) : '');
  });
  board.addEventListener('focusout', () => focusRing.setAttribute('d', ''));

  let cell = Number(localStorageGet('world-monopoly-cell') ?? 56);
  const applyZoom = () => {
    document.documentElement.style.setProperty('--cell', `${cell}px`);
    board.classList.toggle('compact', cell < 44);
    board.classList.toggle('tiny', cell < 12);
    localStorageSet('world-monopoly-cell', String(cell));
  };
  applyZoom();
  app.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      cell = Math.min(110, Math.max(Math.min(MIN_CELL, cell), cell + Number(b.dataset.zoom) * 12));
      applyZoom();
      follow();
    }));
  app.querySelector('[data-fit]')!.addEventListener('click', () => {
    const scroller = document.querySelector<HTMLElement>('.board-scroll')!;
    // 32px horizontal and 72px vertical padding around the map (see .board in styles.css)
    cell = Math.max(4, Math.floor(Math.min((scroller.clientWidth - 32) / MAP.width, (scroller.clientHeight - 72) / MAP.height)));
    applyZoom();
  });
  app.querySelector('[data-follow]')!.addEventListener('click', follow);
}

/** Smallest zoom-out step (px per map cell); Fit may go smaller to show the whole map on a phone. */
const MIN_CELL = 10;

function shortName(sq: { type: string; name: string; utility?: string }) {
  if (sq.type === 'utility') return RULES.utilities.kinds.find((k) => k.id === sq.utility)!.name;
  return sq.name;
}

function follow() {
  const s = ctl?.game();
  if (!s) return;
  const scroller = document.querySelector<HTMLElement>('.board-scroll');
  const tile = document.querySelector<HTMLElement>(`[data-tile="${currentPlayer(s).position}"]`);
  if (!scroller || !tile) return;
  // Scroll only the board, never the page or the panel.
  const box = scroller.getBoundingClientRect(), r = tile.getBoundingClientRect();
  scroller.scrollTo({
    left: scroller.scrollLeft + r.left - box.left - scroller.clientWidth / 2 + r.width / 2,
    top: scroller.scrollTop + r.top - box.top - scroller.clientHeight / 2 + r.height / 2,
    behavior: 'smooth',
  });
}

const stateKey = (s: GameState) => `${s.turn}|${s.current}|${s.phase}|${s.players[s.current]?.position}`;

/**
 * Re-renders board and panel from the controller's state. Hot-seat scrolls to the current player on every
 * action. Online, updates also arrive from other players, so it scrolls only when the turn changes (or after
 * this device's own action), and only moves the selected tile after this device's own roll/end/fly.
 */
export function update(scroll = true) {
  const s = ctl?.game();
  if (!ctl || !s) return;
  const room = ctl.room();
  const turnKey = `${s.turn}:${s.current}`;
  const turnChanged = turnKey !== lastTurnKey;
  lastTurnKey = turnKey;
  const mine = followBase !== null && followBase !== stateKey(s);
  if (mine) {
    followBase = null;
    if (selectAfter) selected = currentPlayer(s).position;
  }
  if (confirming?.startsWith('bot:') && !(room?.isHost && room.seats[Number(confirming.slice(4))]?.kind === 'human')) confirming = null;
  renderBoardState(s);
  renderPanel(s);
  renderBanner();
  syncModal();
  if (scroll && (!room || turnChanged || mine)) follow();
  ctl.afterRender?.();
}

function renderBoardState(s: GameState) {
  const cur = currentPlayer(s).position;
  document.querySelectorAll<SVGElement>('[data-tile]').forEach((tile) => {
    const i = Number(tile.dataset.tile);
    const owner = ownerOf(s, i);
    const label = document.querySelector<HTMLElement>(`[data-label="${i}"]`)!;
    for (const el of [tile, label]) {
      el.style.setProperty('--owner', owner ? owner.color : 'transparent');
      el.classList.toggle('owned', !!owner);
      el.classList.toggle('selected', i === selected);
      el.classList.toggle('current', i === cur);
    }
    const level = levelOf(s, i);
    label.querySelector('.levels')!.innerHTML = level === HOTEL ? '<b class="hotel">H</b>' : '<b class="house"></b>'.repeat(level);
    label.querySelector('.tokens')!.innerHTML = s.players
      .filter((p) => !p.bankrupt && p.position === i)
      .map((p) => `<i class="token" style="background:${esc(p.color)}" title="${esc(p.name)}"></i>`)
      .join('');
  });
  // A band in the owner's colour just inside each owned territory's border (clipped to the territory).
  const rims = document.querySelector('.owner-rims');
  if (rims) rims.innerHTML = Object.entries(s.owners)
    .map(([i]) => `<path d="${territoryPath(Number(i))}" clip-path="url(#tc${i})" stroke="${esc(ownerOf(s, Number(i))?.color ?? 'transparent')}"/>`)
    .join('');
  renderTravel(s);
  document.querySelector('.hl-current')?.setAttribute('d', territoryPath(cur));
  document.querySelector('.hl-selected')?.setAttribute('d', selected === null ? '' : territoryPath(selected));
}

// ---------- travel (flights and sea routes) ----------

interface Trip {
  kind: 'fly' | 'sail';
  dest: number;
  fare: number;
  /** Flights: short, medium or long. */
  band?: { id: string; name: string };
  /** Sailing: the route taken. */
  route?: { id: string; name: string };
}

/** Trips open to the current player right now: every other airport after landing on one, or each sea route's far end after landing on a seaport. */
function travelOptions(s: GameState): Trip[] {
  if (s.phase !== 'action') return [];
  const here = currentPlayer(s).position;
  if (s.canFly && square(here).type === 'airport') {
    return AIRPORTS.filter((a) => a !== here).map((a) => ({ kind: 'fly' as const, dest: a, fare: flightFare(s, a), band: flightBand(here, a) }));
  }
  if (s.canSail && square(here).type === 'seaport') {
    return seaRoutesFrom(here).map(({ route, dest }) => ({ kind: 'sail' as const, dest, fare: sailFare(s, dest), route }));
  }
  return [];
}

/** Map overlay: flight arcs styled by band, or the open sea lanes picked out; destination territories outlined with their fare. */
function renderTravel(s: GameState) {
  const layer = document.querySelector('.travel');
  const lanes = document.querySelector('.map-lanes');
  if (!layer) return;
  const trips = travelOptions(s);
  const open = new Set(trips.filter((t) => t.route).map((t) => t.route!.id));
  lanes?.classList.toggle('dim', open.size > 0);
  lanes?.querySelectorAll<SVGGElement>('[data-lane]').forEach((g) => g.classList.toggle('open', open.has(g.dataset.lane!)));
  document.querySelectorAll<SVGElement>('[data-tile]').forEach((t) => t.classList.toggle('dest', trips.some((x) => x.dest === Number(t.dataset.tile))));
  const here = currentPlayer(s).position;
  const arcs = trips.filter((t) => t.kind === 'fly')
    // Long arcs first, so shorter ones stay on top.
    .sort((a, b) => order(b.band!.id) - order(a.band!.id))
    .map((t) => `<path class="arc arc-${t.band!.id}" d="${arcPath(here, t.dest)}"/>`).join('');
  // Open lanes again on top of the territories, so the way out of the port shows.
  const sea = trips.filter((t) => t.route).map((t) => `<path class="lane-open" d="${LANES.find((l) => l.id === t.route!.id)!.d}"/>`).join('');
  const badges = trips.map((t) => {
    const p = labelPoint(t.dest);
    const text = money(t.fare);
    const w = 0.2 + text.length * 0.17;
    return `<g class="fare fare-${t.band?.id ?? 'sea'}" transform="translate(${p.x} ${p.y - Math.min(p.r, 1) - 0.1})"><rect x="${-w / 2}" y="-0.24" width="${w}" height="0.48" rx="0.24"/><text>${text}</text></g>`;
  }).join('');
  const outlines = trips.map((t) => `<path class="dest-ring" d="${territoryPath(t.dest)}"/>`).join('');
  layer.innerHTML = trips.length ? `<g class="arcs">${sea}${arcs}</g>${outlines}${badges}` : '';
}

const BAND_ORDER = ['short', 'medium', 'long'];
const order = (band: string) => BAND_ORDER.indexOf(band);

/** Panel: trips as buttons (flights grouped by band), with a hint that the map works too. */
function travelPanel(s: GameState, trips: Trip[], p: Player) {
  if (!trips.length) return '';
  const button = (t: Trip) => {
    const owner = ownerOf(s, t.dest);
    const where = t.kind === 'fly' ? `${esc(square(t.dest).name)} <span class="muted">${esc(seaName(t.dest))}</span>` : `${esc(square(t.dest).name)} <span class="muted">${esc(t.route!.name)}</span>`;
    const ownerNote = owner ? (owner.id === p.id ? ' · yours' : ` · to ${esc(owner.name)}`) : '';
    return `<button class="trip" data-trip="${t.kind}:${t.dest}" ${p.cash < t.fare ? 'disabled' : ''}>
        <span>${where}</span><strong>${money(t.fare)}<span class="small muted">${ownerNote}</span></strong></button>`;
  };
  if (trips[0].kind === 'fly') {
    const groups = RULES.airports.flightBands.map((b) => {
      const list = trips.filter((t) => t.band!.id === b.id);
      if (!list.length) return '';
      return `<div class="trip-group"><h4><svg viewBox="0 0 24 8" aria-hidden="true"><path class="arc arc-${b.id}" d="M1 4H23"/></svg>${esc(b.name)} <span class="muted">from ${money(b.fare)}</span></h4>${list.map(button).join('')}</div>`;
    }).join('');
    return `<div class="travel-panel"><p class="small"><strong>✈️ Fly</strong> once to any airport. Tap a lit airport on the map or a button. Flying skips lap-income progress.</p>${groups}</div>`;
  }
  return `<div class="travel-panel"><p class="small"><strong>⚓ Sail</strong> once along a sea route. Tap a lit port on the map or a button. Sailing skips lap-income progress.</p><div class="trip-group">${trips.map(button).join('')}</div></div>`;
}

function renderBanner() {
  const el = document.getElementById('banner');
  const room = ctl?.room();
  if (!el) return;
  el.innerHTML = room ? hostLostHtml(room) : '';
  el.querySelector('[data-act="takeover"]')?.addEventListener('click', () => ctl?.takeOver());
}

function renderPanel(s: GameState) {
  const c = ctl!;
  const panel = document.getElementById('panel')!;
  const room = c.room();
  const p = currentPlayer(s);
  const over = s.phase === 'gameOver';
  const can = c.canAct();
  const buying = s.pendingBuy !== null ? square(s.pendingBuy) : null;
  const frozen = !!room && room.status !== 'connected' && !over;
  const spectating = !!room && room.selfSeat === null;

  let actions = '';
  if (over) {
    const w = s.winner !== null ? s.players[s.winner] : undefined;
    actions = `<div class="winner">${w ? `🏆 ${esc(w.name)} wins with ${money(netWorth(s, w))} net worth.` : 'Game over.'}</div>
      <button class="primary wide" data-act="new">New game</button>`;
  } else if (frozen) {
    actions = `<p class="muted">Paused until the host is back.</p>`;
  } else if (!can) {
    actions = p.isBot ? `<p class="muted">${esc(p.name)} is thinking…</p>` : `<p class="muted">Waiting for ${esc(p.name)}…${room?.seats[p.id]?.kind === 'human' && !room.seats[p.id].connected ? ' (away)' : ''}</p>`;
  } else if (s.phase === 'roll') {
    actions = `<button class="primary wide" data-act="roll">🎲 Roll dice</button>`;
  } else {
    actions = `
      ${buying ? `<button class="primary wide" data-act="buy" ${p.cash < buying.price! ? 'disabled' : ''}>Buy ${esc(buying.name)} for ${money(buying.price!)}</button>` : ''}
      ${travelPanel(s, travelOptions(s), p)}
      <button class="primary wide" data-act="end">End turn</button>`;
  }

  // Trading is open to everyone at any time, so it lives outside the turn's action block.
  let tradeBar = '';
  if (!frozen && canTrade(s, room)) {
    const mine = room?.pendingTrades.find((pt) => pt.offer.from === room.selfSeat);
    tradeBar = mine
      ? `<p class="muted">Waiting for ${esc(s.players[mine.offer.to]?.name ?? 'the other player')} to answer your trade…</p>
        <button class="wide" data-act="cancel-trade">Cancel trade</button>`
      : '<button class="wide" data-act="trade">🤝 Trade</button>';
  }

  const seatTags = (id: number) => {
    if (!room) return '';
    const seat = room.seats[id];
    const tags = [];
    if (id === room.selfSeat) tags.push('<span class="chip you">you</span>');
    if (seat && seat.clientId !== null && seat.clientId === room.hostId && seat.kind === 'human') tags.push('<span class="chip">host</span>');
    if (seat?.kind === 'human' && !seat.connected) tags.push('<span class="chip away">away</span>');
    return tags.join(' ');
  };
  const canHandOver = (id: number) => {
    const seat = room?.seats[id];
    return !!room?.isHost && !over && seat?.kind === 'human' && seat.clientId !== room.hostId && !s.players[id].bankrupt;
  };
  const confirmHtml = (message: string, yes: string) => `
    <div class="confirm" role="alertdialog" aria-label="Confirm">
      <p class="small">${message}</p>
      <div class="row"><button class="ghost" data-act="confirm-no">Cancel</button><button class="primary" data-act="confirm-yes">${esc(yes)}</button></div>
    </div>`;

  let footer: string;
  if (confirming === 'finish') {
    footer = confirmHtml('End the game for everyone now? The highest net worth wins.', 'End game');
  } else if (confirming === 'leave') {
    footer = confirmHtml(
      room?.isHost
        ? 'Leave as host? The game pauses for everyone until someone takes over as host. Your saved room on this device is discarded.'
        : 'Leave this game? You can rejoin with the invite link from this browser.',
      'Leave game');
  } else {
    footer = `
      ${!over && (!room || room.canFinish) ? '<button class="ghost" data-act="finish">End game now</button>' : ''}
      <button class="ghost" data-act="quit">${room ? 'Leave game' : 'Main menu'}</button>`;
  }

  const roomBar = room ? `
    <div class="room-bar">
      <div class="small"><span class="muted">Room</span> <strong class="mono">${esc(room.code)}</strong>
        <span class="muted">· ${room.online + 1} here</span>${spectating ? ' <span class="chip">Spectating</span>' : ''}</div>
      ${inviteHtml(room.link, 'Copy link')}
      ${room.networkError ? `<p class="small muted">${esc(room.networkError)}</p>` : ''}
    </div>` : '';

  const top = panel.scrollTop;
  panel.innerHTML = `
    <header class="turn" style="--who:${esc(p.color)}">
      <div><strong>${esc(p.name)}</strong> <span class="muted">· ${esc(roleOf(p).name)}</span></div>
      <div class="muted small">Round ${s.turn}${s.roundLimit ? ` / ${s.roundLimit}` : ''}</div>
    </header>
    ${roomBar}
    ${s.dice ? `<div class="dice">${s.dice.map((d) => `<span>${d}</span>`).join('')}</div>` : ''}
    ${s.lastEvent ? `<div class="event event-${esc(s.lastEvent.kind)}"><strong>${esc(s.lastEvent.title)}</strong><p>${esc(s.lastEvent.text)}</p></div>` : ''}
    ${toast ? `<div class="toast" role="status">${esc(toast)}</div>` : ''}
    <div class="actions">${actions}</div>
    ${tradeBar ? `<div class="trade-bar">${tradeBar}</div>` : ''}
    ${selected !== null ? detail(s, selected, can && !frozen) : ''}
    <h3>Players</h3>
    <ul class="players">
      ${s.players.map((pl) => `
        <li class="${pl.bankrupt ? 'out' : ''} ${pl.id === p.id ? 'active' : ''}">
          <i class="token" style="background:${esc(pl.color)}"></i>
          <div>
            <strong>${esc(pl.name)}</strong> <span class="muted small">${esc(roleOf(pl).name)}${pl.isBot ? ' · bot' : ''}</span> ${seatTags(pl.id)}
            <div class="small">${pl.bankrupt ? 'Bankrupt' : `Cash ${money(pl.cash)} · Worth ${money(netWorth(s, pl))} · ${ownedBy(s, pl.id).length} props`}
              ${pl.skipNextTurn ? ' · misses next turn' : ''}${pl.skipAirportIncome ? ' · flight delayed' : ''}</div>
            ${!pl.bankrupt ? `<div class="small muted">${roleOf(pl).noSalary ? 'No salary' : `Income tax ${Math.round(incomeTaxRate(s, pl) * 100)}%`} · Living ${money(costOfLiving(s, pl))}/turn · Lap ${pl.laps}</div>
            ${lapMeter(pl)}` : ''}
            ${canHandOver(pl.id) ? (confirming === `bot:${pl.id}`
              ? confirmHtml(`Hand ${esc(pl.name)}'s seat to a bot? This changes the game for everyone. ${esc(pl.name)} gets the seat back by reconnecting.`, 'Hand to bot')
              : `<button class="ghost small" data-botseat="${pl.id}">Hand to bot</button>`) : ''}
          </div>
        </li>`).join('')}
    </ul>
    <h3>Log</h3>
    <ul class="log">${s.log.slice(-40).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="row footer-actions">${footer}</div>`;
  panel.scrollTop = top;
  toast = '';

  const on = (act: string, fn: () => void) => panel.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn);
  const act = (intent: Intent, selectAfterAction = false) => perform(intent, selectAfterAction);
  on('roll', () => act({ type: 'roll' }, true));
  on('buy', () => act({ type: 'buy' }));
  on('end', () => act({ type: 'endTurn' }, true));
  panel.querySelectorAll<HTMLButtonElement>('[data-trip]').forEach((b) => b.addEventListener('click', () => {
    const [kind, dest] = b.dataset.trip!.split(':');
    act({ type: kind as 'fly' | 'sail', dest: Number(dest) }, true);
  }));
  on('trade', () => openTrade());
  on('cancel-trade', () => act({ type: 'cancelTrade' }));
  on('finish', () => (room ? ask('finish') : act({ type: 'finish' })));
  on('new', () => ctl?.newGame());
  on('quit', () => (room ? ask('leave') : ctl?.leave()));
  on('confirm-no', () => ask(null));
  on('confirm-yes', () => {
    const what = confirming;
    confirming = null;
    if (what === 'finish') act({ type: 'finish' });
    else if (what === 'leave') ctl?.leave();
    else if (what?.startsWith('bot:')) {
      ctl?.convertToBot(Number(what.slice(4)));
      update(false);
    }
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-botseat]').forEach((b) => b.addEventListener('click', () => ask(`bot:${b.dataset.botseat}`)));
  panel.querySelectorAll<HTMLButtonElement>('[data-build]').forEach((b) => b.addEventListener('click', () => act({ type: 'build', index: Number(b.dataset.build) })));
  panel.querySelectorAll<HTMLButtonElement>('[data-sell]').forEach((b) => b.addEventListener('click', () => act({ type: 'sell', index: Number(b.dataset.sell) })));
  if (room) bindInvite(panel, room.link);
}

function ask(what: string | null) {
  confirming = what;
  update(false);
}

/** Runs an action through the controller. Rule errors thrown locally become a toast; online refusals arrive via notify(). */
function perform(intent: Intent, selectAfterAction = false) {
  const s = ctl?.game();
  if (!ctl || !s) return;
  followBase = selectAfterAction ? stateKey(s) : null;
  selectAfter = selectAfterAction;
  try {
    ctl.perform(intent);
  } catch (e) {
    toast = (e as Error).message;
    followBase = null;
  }
  update();
}

/** Progress toward the next lap income: squares walked since the last New Year and what New Year would pay now. */
function lapMeter(p: Player) {
  const walked = Math.min(p.lapProgress, SIZE);
  const pct = Math.round((walked / SIZE) * 100);
  return `<div class="lap-meter small" title="Lap income at the next New Year: ${money(RULES.lapIncome.amount)} x squares walked / ${SIZE}">
      <span class="bar" role="progressbar" aria-label="Lap income progress" aria-valuemin="0" aria-valuemax="${SIZE}" aria-valuenow="${walked}"><i style="width:${pct}%"></i></span>
      <span>New Year pays <strong>${money(lapIncome(p))}</strong> <span class="muted">(${walked}/${SIZE} walked)</span></span>
    </div>`;
}

function detail(s: GameState, index: number, human: boolean) {
  const sq = square(index);
  const section = sq.section ? sectionById.get(sq.section)! : null;
  const owner = ownerOf(s, index);
  const p = currentPlayer(s);
  const city = section?.cities.find((c) => c.id === sq.id);
  let body = '';
  if (sq.type === 'city') {
    const level = levelOf(s, index);
    const check = canBuild(s, index);
    const mine = human && s.phase === 'action' && owner?.id === p.id;
    const rentNow = cityRent(s, index);
    body = `
      <p class="small">${city ? esc(city.landmark) : ''}${sq.image ? '' : ' · <em>art pending</em>'}</p>
      <p>Price ${money(sq.price!)} · ${tierOf(sq.price!).id} tier · House ${money(tierOf(sq.price!).houseCost)}</p>
      <p>Owner: ${owner ? esc(owner.name) : 'Bank'} · ${level === HOTEL ? 'Hotel' : `${level} house${level === 1 ? '' : 's'}`}</p>
      <p>Rent now: <strong>${money(rentNow)}</strong></p>
      ${mine ? `<div class="row">
        <button data-build="${index}" ${check.ok ? '' : 'disabled'}>${level + 1 === HOTEL ? 'Build hotel' : 'Build house'}${check.ok ? ` ${money(check.cost + check.fees.reduce((a, f) => a + f.amount, 0))}` : ''}</button>
        <button data-sell="${index}" ${level ? '' : 'disabled'}>Sell building</button>
      </div>${check.ok ? '' : `<p class="small muted">${esc(check.reason)}</p>`}` : ''}`;
  } else if (sq.type === 'utility') {
    body = `<p>Price ${money(sq.price!)} · Owner: ${owner ? esc(owner.name) : 'Bank'}</p>
      <p class="small">Earns ${money(RULES.utilities.feePerHouse)} per house and ${money(RULES.utilities.feePerHotel)} per hotel anyone else builds in ${esc(section!.name)}.${RULES.utilities.requiresCityInSection ? ' Only active while the owner has a city in this section.' : ''}</p>`;
  } else if (sq.type === 'airport') {
    const bonus = owner ? transportMultiplier(s, owner, 'airport') : 1;
    const flights = RULES.airports.flightBands.map((b) => {
      const to = AIRPORTS.filter((a) => a !== index && flightBand(index, a).id === b.id);
      return to.length ? `<li><strong>${esc(b.name)}</strong> ${money(b.fare)}: ${to.map((a) => `${esc(square(a).name)} <span class="muted">(${esc(seaName(a))})</span>`).join(', ')}</li>` : '';
    }).join('');
    body = `<p>Price ${money(sq.price!)} · Owner: ${owner ? esc(owner.name) : 'Bank'}</p>
      <p>Landing fee <strong>${money(Math.round(RULES.airports.landingFee * bonus))}</strong>${bonus > 1 ? ` <span class="muted">(+${Math.round((bonus - 1) * 100)}% for ${esc(owner!.name)}'s other airports)</span>` : ''}</p>
      <p class="small">Land here by dice to fly once to any other airport. Flights to or from here, base fare (paid to the destination airport's owner, or the bank):</p>
      <ul class="small route-list">${flights}</ul>
      <p class="small muted">+${RULES.airports.bonusPerExtraAirport * 100}% on fees and fares per extra airport the owner has. Diplomats pay half.</p>`;
  } else if (sq.type === 'seaport') {
    const bonus = owner ? transportMultiplier(s, owner, 'seaport') : 1;
    const routes = seaRoutesFrom(index).map(({ route, dest }) => {
      const destOwner = ownerOf(s, dest);
      const fare = destOwner ? Math.round(RULES.seaports.sailFare * transportMultiplier(s, destOwner, 'seaport')) : RULES.seaports.sailFare;
      return `<li><strong>${esc(route.name)}</strong> to ${esc(square(dest).name)} · ${money(fare)}${destOwner ? ` to ${esc(destOwner.name)}` : ''}</li>`;
    }).join('');
    body = `<p>Price ${money(sq.price!)} · Owner: ${owner ? esc(owner.name) : 'Bank'}</p>
      <p>Docking fee <strong>${money(Math.round(RULES.seaports.dockingFee * bonus))}</strong>${bonus > 1 ? ` <span class="muted">(+${Math.round((bonus - 1) * 100)}% for ${esc(owner!.name)}'s other ports)</span>` : ''}</p>
      <p class="small">Land here by dice to sail once along a route:</p>
      <ul class="small route-list">${routes}</ul>
      <p class="small muted">Fares go to the destination port's owner, or the bank. +${RULES.seaports.bonusPerExtraSeaport * 100}% per extra seaport the owner has. Diplomats pay half.</p>`;
  } else {
    const text: Record<string, string> = {
      newYear: `Salary checkpoint and lap marker. Reaching or passing it pays lap income: ${money(RULES.lapIncome.amount)} x squares walked since the last one / ${SIZE} (flights and sailing do not count). Then pay ${RULES.propertyTax.percentOfPropertyValue}% property tax; Bankers earn interest.`,
      event: 'Draw a World Event card.',
      disaster: section ? `Regional disaster: ${section.disasters.join(' or ')}. Damages buildings in ${section.name}.` : '',
      tax: `Pay ${money(RULES.taxSquare.amount)}.`,
    };
    body = `<p class="small">${esc(text[sq.type] ?? '')}</p>`;
  }
  return `
    <div class="detail" style="${section ? `--section:${esc(section.color)}` : ''}">
      <div class="detail-art">${tileArt(sq)}</div>
      <div>
        <h3>${tileIcon(sq)} ${esc(sq.name)}</h3>
        ${section ? `<div class="small muted">${esc(section.name)} · square ${index}</div>` : `<div class="small muted">Square ${index}</div>`}
        ${body}
      </div>
    </div>`;
}

// ---------- trading ----------

const tradeNames = (xs: number[]) => (xs.length ? xs.map((i) => esc(square(i).name)).join(', ') : 'nothing');

/** "A offers X + $n for Y" as HTML (names escaped). */
function tradeSummary(s: GameState, offer: TradeOffer) {
  const from = s.players[offer.from];
  return `${esc(from.name)} offers <strong>${tradeNames(offer.give)}</strong>${offer.cash > 0 ? ` + ${money(offer.cash)}` : ''}
    for <strong>${tradeNames(offer.get)}</strong>${offer.cash < 0 ? ` + ${money(-offer.cash)}` : ''}.`;
}

/** Who may open the trade modal: online, a seated non-bankrupt human; hot-seat, anyone while a human is still in. */
function canTrade(s: GameState, room: RoomView | null) {
  if (s.phase === 'gameOver' || activePlayers(s).length < 2) return false;
  if (!room) return s.players.some((p) => !p.isBot && !p.bankrupt);
  const me = room.selfSeat;
  return me !== null && room.status === 'connected' && room.seats[me]?.kind === 'human' && !s.players[me].bankrupt;
}

function openTrade() {
  const c = ctl!;
  const room = c.room();
  const first = c.game()!;
  if (!canTrade(first, room)) return;
  // Online "me" is this device's seat. Hot-seat shares one device, so "From" is a picker (default: the current player).
  let from = room ? room.selfSeat! : first.players.some((p) => p.id === first.current && !p.isBot && !p.bankrupt) ? first.current : first.players.find((p) => !p.isBot && !p.bankrupt)!.id;
  const froms = room ? [] : first.players.filter((p) => !p.isBot && !p.bankrupt);
  const partnersOf = (s: GameState) => activePlayers(s).filter((o) => o.id !== from);
  let partner = partnersOf(first)[0].id;
  const modal = document.getElementById('modal')!;
  modalKind = 'builder';

  const propList = (s: GameState, playerId: number, name: string) =>
    ownedBy(s, playerId)
      .sort((a, b) => a - b)
      .map((i) => `<label class="check"><input type="checkbox" name="${name}" value="${i}" />${tileIcon(square(i))} ${esc(square(i).name)} <span class="muted">${money(square(i).price!)}${levelOf(s, i) ? ` · L${levelOf(s, i)}` : ''}</span></label>`)
      .join('') || '<p class="muted small">No properties</p>';

  const draw = (message = '') => {
    const s = c.game();
    if (!s) return;
    const me = s.players[from];
    const them = s.players[partner];
    const others = partnersOf(s);
    modal.className = 'modal-root open';
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-label="Trade">
        <h3>Trade</h3>
        ${room ? '' : `<label>From <select data-from>${froms.map((o) => `<option value="${o.id}" ${o.id === from ? 'selected' : ''}>${esc(s.players[o.id].name)}</option>`).join('')}</select></label>`}
        <label>With <select data-partner>${others.map((o) => `<option value="${o.id}" ${o.id === partner ? 'selected' : ''}>${esc(s.players[o.id].name)}</option>`).join('')}</select></label>
        <div class="trade-cols">
          <div><h4>${room ? 'You give' : `${esc(me.name)} gives`}</h4>${propList(s, me.id, 'give')}</div>
          <div><h4>${esc(them.name)} gives</h4>${propList(s, them.id, 'get')}</div>
        </div>
        <label>Cash <input type="number" step="10" value="0" data-cash /> <span class="small muted">positive = ${room ? 'you pay' : `${esc(me.name)} pays`}, negative = they pay</span></label>
        ${message ? `<p class="toast">${esc(message)}</p>` : ''}
        <div class="row">
          <button class="ghost" data-close>Cancel</button>
          <button class="primary" data-propose>Propose</button>
        </div>
      </div>`;
    modal.querySelector('[data-from]')?.addEventListener('change', (e) => {
      from = Number((e.target as HTMLSelectElement).value);
      if (partner === from) partner = partnersOf(s)[0].id;
      draw();
    });
    modal.querySelector('[data-partner]')!.addEventListener('change', (e) => {
      partner = Number((e.target as HTMLSelectElement).value);
      draw();
    });
    modal.querySelector('[data-close]')!.addEventListener('click', () => closeModal());
    modal.querySelector('[data-propose]')!.addEventListener('click', () => {
      const picked = (name: string) => [...modal.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((x) => Number(x.value));
      const offer: TradeOffer = { from: me.id, to: partner, give: picked('give'), get: picked('get'), cash: Math.round(Number(modal.querySelector<HTMLInputElement>('[data-cash]')!.value) || 0) };
      const err = validateTrade(s, offer);
      if (err) return draw(err);
      if (room) {
        // The host decides: a bot answers at once (a refusal comes back as a toast), a human gets a prompt.
        closeModal(false);
        perform({ type: 'proposeTrade', offer });
      } else if (them.isBot) {
        // Hot-seat: the controller asks the bot and throws its refusal.
        try {
          c.perform({ type: 'proposeTrade', offer });
        } catch (e) {
          return draw((e as Error).message);
        }
        toast = `${them.name} accepted.`;
        closeModal();
      } else {
        confirmLocal(s, offer);
      }
    });
  };

  // Hot-seat only: the other player confirms on this device, then the controller executes the trade.
  const confirmLocal = (s: GameState, offer: TradeOffer) => {
    const them = s.players[offer.to];
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-label="Accept trade">
        <h3>Pass the device to ${esc(them.name)}</h3>
        <p>${tradeSummary(s, offer)}</p>
        <div class="row">
          <button class="ghost" data-decline>Decline</button>
          <button class="primary" data-accept>Accept</button>
        </div>
      </div>`;
    modal.querySelector('[data-decline]')!.addEventListener('click', () => {
      toast = `${them.name} declined.`;
      closeModal();
    });
    modal.querySelector('[data-accept]')!.addEventListener('click', () => {
      try {
        c.perform({ type: 'proposeTrade', offer });
        toast = `${them.name} accepted.`;
      } catch (e) {
        toast = (e as Error).message;
      }
      closeModal();
    });
  };

  draw();
}

/** Online: the prompt the target of an offer sees (`n` of `total` when several wait), whichever screen state they are in. */
function showPrompt(s: GameState, pt: PendingTrade, n: number, total: number) {
  const modal = document.getElementById('modal')!;
  modalKind = 'prompt';
  promptId = pt.id;
  promptTotal = total;
  modal.className = 'modal-root open';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Trade offer">
      <h3>Trade offer${total > 1 ? ` (${n} of ${total})` : ''}</h3>
      <p>${tradeSummary(s, pt.offer)}</p>
      <div class="row">
        <button class="ghost" data-decline>Decline</button>
        <button class="primary" data-accept>Accept</button>
      </div>
    </div>`;
  const respond = (accept: boolean) => {
    closeModal(false);
    answered.add(pt.id);
    // If the host refuses, notify() forgets this and syncModal() shows the offer again. Otherwise the next waiting offer comes up.
    perform({ type: 'respondTrade', tradeId: pt.id, accept });
  };
  modal.querySelector('[data-decline]')!.addEventListener('click', () => respond(false));
  modal.querySelector('[data-accept]')!.addEventListener('click', () => respond(true));
}

/** Online: keep the modal in step with the snapshot (one prompt at a time for incoming offers; close stale modals). */
function syncModal() {
  const room = ctl?.room();
  const s = ctl?.game();
  if (!ctl || !room || !s) return;
  const me = room.selfSeat;
  for (const id of answered) if (!room.pendingTrades.some((pt) => pt.id === id)) answered.delete(id);
  const incoming = me === null || s.phase === 'gameOver' ? [] : room.pendingTrades.filter((pt) => pt.offer.to === me && !answered.has(pt.id));
  const shown = incoming.findIndex((pt) => pt.id === promptId);
  if (modalKind === 'prompt') {
    if (shown >= 0) {
      if (incoming.length !== promptTotal) showPrompt(s, incoming[shown], shown + 1, incoming.length); // refresh the "n of m" count
      return;
    }
    if (incoming.length) return showPrompt(s, incoming[0], 1, incoming.length);
    closeModal(false);
  } else if (modalKind === 'builder') {
    // Never swallow a trade being written; incoming offers wait until it is closed.
    if (!canTrade(s, room) || room.pendingTrades.some((pt) => pt.offer.from === me)) closeModal(false);
  } else if (incoming.length) {
    showPrompt(s, incoming[0], 1, incoming.length);
  }
}

function closeModal(redraw = true) {
  const modal = document.getElementById('modal');
  modalKind = null;
  promptId = null;
  if (!modal) return;
  modal.className = 'modal-root';
  modal.innerHTML = '';
  if (redraw) update(false);
}
