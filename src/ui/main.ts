import { BOARD, PLAYER_COLORS, ROLES, RULES, sectionById } from '../engine/data';
import { botAcceptsTrade, botStep } from '../engine/bot';
import {
  AIRPORTS, HOTEL, activePlayers, build, buy, canBuild, cityRent, costOfLiving, createGame, currentPlayer, endGameByNetWorth,
  endTurn, executeTrade, flightFare, fly, incomeTaxRate, levelOf, money, netWorth, ownedBy, ownerOf, roleOf, roll, sellBuilding,
  square, tierOf, validateTrade,
} from '../engine/game';
import type { GameState, PlayerSetup, Square, TradeOffer } from '../engine/types';
import { boardPosition, tileArt, tileIcon } from './tiles';

const SAVE_KEY = 'world-monopoly-save-v1';
const BOT_DELAY_MS = 450;

const app = document.getElementById('app')!;
let game: GameState | null = null;
let selected: number | null = null;
let botTimer: number | undefined;
let toast = '';

const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- persistence ----------

function save() {
  try {
    if (game) localStorage.setItem(SAVE_KEY, JSON.stringify(game));
  } catch {
    /* storage unavailable */
  }
}

function loadSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const s = raw ? (JSON.parse(raw) as GameState) : null;
    return s && s.version === 1 && s.phase !== 'gameOver' ? s : null;
  } catch {
    return null;
  }
}

function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ---------- setup screen ----------

interface SetupRow { name: string; isBot: boolean; roleId: string }
let setupRows: SetupRow[] = [
  { name: 'You', isBot: false, roleId: 'entrepreneur' },
  { name: 'Bot Ada', isBot: true, roleId: 'banker' },
  { name: 'Bot Ken', isBot: true, roleId: 'diplomat' },
  { name: 'Bot Zoe', isBot: true, roleId: 'industrialist' },
];
let roundLimit = RULES.roundLimit.default;

function renderSetup() {
  const saved = loadSave();
  const used = (i: number) => new Set(setupRows.filter((_, j) => j !== i).map((r) => r.roleId));
  app.innerHTML = `
    <main class="setup">
      <h1>World Monopoly</h1>
      <p class="muted">${BOARD.length} squares · 9 sections · 72 cities. Pick players and draft one role each.</p>
      ${saved ? `<button class="primary wide" data-act="resume">Resume saved game (round ${saved.turn})</button>` : ''}
      <div class="setup-rows">
        ${setupRows.map((r, i) => `
          <div class="setup-row">
            <span class="swatch" style="background:${PLAYER_COLORS[i]}"></span>
            <input data-name="${i}" value="${esc(r.name)}" maxlength="16" aria-label="Player ${i + 1} name" />
            <select data-bot="${i}" aria-label="Player ${i + 1} type">
              <option value="human" ${r.isBot ? '' : 'selected'}>Human</option>
              <option value="bot" ${r.isBot ? 'selected' : ''}>Bot</option>
            </select>
            <select data-role="${i}" aria-label="Player ${i + 1} role">
              ${ROLES.map((role) => `<option value="${role.id}" ${role.id === r.roleId ? 'selected' : ''} ${used(i).has(role.id) ? 'disabled' : ''}>${role.name}</option>`).join('')}
            </select>
            ${setupRows.length > RULES.players.min ? `<button class="ghost" data-remove="${i}" aria-label="Remove player">✕</button>` : ''}
          </div>
          <p class="role-summary">${esc(ROLES.find((x) => x.id === r.roleId)!.summary)}</p>`).join('')}
      </div>
      <div class="setup-actions">
        ${setupRows.length < RULES.players.max ? '<button data-act="add">+ Add player</button>' : ''}
        <label>Round limit <input type="number" min="0" max="999" value="${roundLimit}" data-limit /></label>
      </div>
      <p class="muted small">Round limit 0 = play until one player is left (4-bot games run about 230 rounds). At the limit, highest net worth wins.</p>
      <button class="primary wide" data-act="start">Start game</button>
      <details class="rules">
        <summary>Rules in short</summary>
        <ul>
          <li>Pass a ⭐ checkpoint (every 12 squares): collect ${money(RULES.salary.perCheckpoint)} salary minus income tax (10/18/25% by net worth).</li>
          <li>Every turn you pay cost of living (${money(RULES.costOfLiving.minimum)} minimum, more for pricier cities). Each New Year you pay ${RULES.propertyTax.percentOfPropertyValue}% property tax.</li>
          <li>No full set needed to build houses. Rent rises 10% for each extra square you own in that section (up to +110%). Hotels need all 8 cities of the section.</li>
          <li>Each section has Water, Gas, Electricity and WiFi meters. Anyone building there pays the meter owners a fee.</li>
          <li>Airports: pay a landing fee to the owner, or pay a fare to fly to any other airport.</li>
          <li>Highways are safe. World Event and Disaster squares draw cards. No jail.</li>
        </ul>
      </details>
    </main>`;

  app.querySelectorAll<HTMLInputElement>('[data-name]').forEach((el) =>
    el.addEventListener('input', () => (setupRows[Number(el.dataset.name)].name = el.value)));
  app.querySelectorAll<HTMLSelectElement>('[data-bot]').forEach((el) =>
    el.addEventListener('change', () => (setupRows[Number(el.dataset.bot)].isBot = el.value === 'bot')));
  app.querySelectorAll<HTMLSelectElement>('[data-role]').forEach((el) =>
    el.addEventListener('change', () => {
      setupRows[Number(el.dataset.role)].roleId = el.value;
      renderSetup();
    }));
  app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((el) =>
    el.addEventListener('click', () => {
      setupRows.splice(Number(el.dataset.remove), 1);
      renderSetup();
    }));
  app.querySelector<HTMLInputElement>('[data-limit]')!.addEventListener('input', (e) => {
    roundLimit = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
  });
  app.querySelector('[data-act="add"]')?.addEventListener('click', () => {
    const taken = new Set(setupRows.map((r) => r.roleId));
    setupRows.push({ name: `Bot ${setupRows.length + 1}`, isBot: true, roleId: ROLES.find((r) => !taken.has(r.id))!.id });
    renderSetup();
  });
  app.querySelector('[data-act="resume"]')?.addEventListener('click', () => startWith(saved!));
  app.querySelector('[data-act="start"]')!.addEventListener('click', () => {
    const setups: PlayerSetup[] = setupRows.map((r, i) => ({ ...r, name: r.name.trim() || `Player ${i + 1}` }));
    startWith(createGame(setups, Date.now(), roundLimit));
  });
}

function startWith(s: GameState) {
  game = s;
  selected = currentPlayer(s).position;
  mountGame();
  update();
}

// ---------- game screen ----------

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
    <div class="modal-root" id="modal"></div>`;

  const board = document.getElementById('board')!;
  board.innerHTML =
    BOARD.map((sq) => {
      const { row, col } = boardPosition(sq.index, BOARD.length);
      const section = sq.section ? sectionById.get(sq.section)! : null;
      return `
        <button class="tile tile-${sq.type}" data-tile="${sq.index}" style="grid-row:${row + 1};grid-column:${col + 1};${section ? `--section:${section.color}` : ''}" title="${esc(sq.name)}">
          ${section ? '<span class="band"></span>' : ''}
          <span class="art">${tileArt(sq)}</span>
          <span class="label">${esc(shortName(sq))}</span>
          ${sq.price ? `<span class="price">${money(sq.price)}</span>` : ''}
          ${sq.checkpoint ? '<span class="checkpoint" title="Salary checkpoint">⭐</span>' : ''}
          <span class="levels"></span>
          <span class="tokens"></span>
        </button>`;
    }).join('') +
    `<div class="board-center">
      <h2>World Monopoly</h2>
      <div class="legend">${[...sectionById.values()].map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
      <p class="muted small">Tap any square for details.</p>
    </div>`;

  board.addEventListener('click', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-tile]');
    if (!tile) return;
    selected = Number(tile.dataset.tile);
    update(false);
  });

  let cell = Number(localStorageGet('world-monopoly-cell') ?? 56);
  const applyZoom = () => {
    document.documentElement.style.setProperty('--cell', `${cell}px`);
    board.classList.toggle('compact', cell < 44);
    localStorageSet('world-monopoly-cell', String(cell));
  };
  applyZoom();
  app.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      cell = Math.min(110, Math.max(16, cell + Number(b.dataset.zoom) * 12));
      applyZoom();
      follow();
    }));
  app.querySelector('[data-fit]')!.addEventListener('click', () => {
    const scroller = document.querySelector<HTMLElement>('.board-scroll')!;
    const n = boardPosition(0, BOARD.length).row + 1;
    // 2px grid gap, 32px horizontal and 72px vertical padding (see .board in styles.css)
    cell = Math.max(16, Math.floor(Math.min((scroller.clientWidth - 32) / n, (scroller.clientHeight - 72) / n) - 2));
    applyZoom();
  });
  app.querySelector('[data-follow]')!.addEventListener('click', follow);
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

function shortName(sq: Square) {
  if (sq.type === 'utility') return RULES.utilities.kinds.find((k) => k.id === sq.utility)!.name;
  return sq.name;
}

function follow() {
  if (!game) return;
  const scroller = document.querySelector<HTMLElement>('.board-scroll');
  const tile = document.querySelector<HTMLElement>(`[data-tile="${currentPlayer(game).position}"]`);
  if (!scroller || !tile) return;
  // Scroll only the board, never the page or the panel.
  scroller.scrollTo({
    left: tile.offsetLeft - scroller.clientWidth / 2 + tile.offsetWidth / 2,
    top: tile.offsetTop - scroller.clientHeight / 2 + tile.offsetHeight / 2,
    behavior: 'smooth',
  });
}

function update(scroll = true) {
  if (!game) return;
  const s = game;
  save();
  renderBoardState(s);
  renderPanel(s);
  if (scroll) follow();
  scheduleBot();
}

function renderBoardState(s: GameState) {
  document.querySelectorAll<HTMLElement>('[data-tile]').forEach((tile) => {
    const i = Number(tile.dataset.tile);
    const owner = ownerOf(s, i);
    tile.style.setProperty('--owner', owner ? owner.color : 'transparent');
    tile.classList.toggle('owned', !!owner);
    tile.classList.toggle('selected', i === selected);
    tile.classList.toggle('current', i === currentPlayer(s).position);
    const level = levelOf(s, i);
    tile.querySelector('.levels')!.innerHTML = level === HOTEL ? '<b class="hotel">H</b>' : '<b class="house"></b>'.repeat(level);
    tile.querySelector('.tokens')!.innerHTML = s.players
      .filter((p) => !p.bankrupt && p.position === i)
      .map((p) => `<i class="token" style="background:${p.color}" title="${esc(p.name)}"></i>`)
      .join('');
  });
}

function renderPanel(s: GameState) {
  const panel = document.getElementById('panel')!;
  const p = currentPlayer(s);
  const human = !p.isBot && s.phase !== 'gameOver';
  const here = square(p.position);
  const pending = s.pendingBuy !== null ? square(s.pendingBuy) : null;

  let actions = '';
  if (s.phase === 'gameOver') {
    const w = s.players[s.winner!];
    actions = `<div class="winner">🏆 ${esc(w.name)} wins with ${money(netWorth(s, w))} net worth.</div>
      <button class="primary wide" data-act="new">New game</button>`;
  } else if (!human) {
    actions = `<p class="muted">${esc(p.name)} is thinking…</p>`;
  } else if (s.phase === 'roll') {
    actions = `<button class="primary wide" data-act="roll">🎲 Roll dice</button>`;
  } else {
    actions = `
      ${pending ? `<button class="primary wide" data-act="buy" ${p.cash < pending.price! ? 'disabled' : ''}>Buy ${esc(pending.name)} for ${money(pending.price!)}</button>` : ''}
      ${s.canFly && here.type === 'airport' ? `
        <div class="fly">
          <select data-fly aria-label="Destination airport">
            ${AIRPORTS.filter((a) => a !== p.position).map((a) => `<option value="${a}">${esc(square(a).name)} · ${nearbySection(a)} · ${money(flightFare(s, a))}</option>`).join('')}
          </select>
          <button data-act="fly">✈️ Fly</button>
        </div>` : ''}
      <div class="row">
        <button data-act="trade">🤝 Trade</button>
        <button class="primary" data-act="end">End turn</button>
      </div>`;
  }

  panel.innerHTML = `
    <header class="turn" style="--who:${p.color}">
      <div><strong>${esc(p.name)}</strong> <span class="muted">· ${esc(roleOf(p).name)}</span></div>
      <div class="muted small">Round ${s.turn}${s.roundLimit ? ` / ${s.roundLimit}` : ''}</div>
    </header>
    ${s.dice ? `<div class="dice">${s.dice.map((d) => `<span>${d}</span>`).join('')}</div>` : ''}
    ${s.lastEvent ? `<div class="event event-${s.lastEvent.kind}"><strong>${esc(s.lastEvent.title)}</strong><p>${esc(s.lastEvent.text)}</p></div>` : ''}
    ${toast ? `<div class="toast">${esc(toast)}</div>` : ''}
    <div class="actions">${actions}</div>
    ${selected !== null ? detail(s, selected, human) : ''}
    <h3>Players</h3>
    <ul class="players">
      ${s.players.map((pl) => `
        <li class="${pl.bankrupt ? 'out' : ''} ${pl.id === p.id ? 'active' : ''}">
          <i class="token" style="background:${pl.color}"></i>
          <div>
            <strong>${esc(pl.name)}</strong> <span class="muted small">${esc(roleOf(pl).name)}${pl.isBot ? ' · bot' : ''}</span>
            <div class="small">${pl.bankrupt ? 'Bankrupt' : `Cash ${money(pl.cash)} · Worth ${money(netWorth(s, pl))} · ${ownedBy(s, pl.id).length} props`}
              ${pl.skipNextTurn ? ' · misses next turn' : ''}${pl.skipAirportIncome ? ' · flight delayed' : ''}</div>
            ${!pl.bankrupt ? `<div class="small muted">${roleOf(pl).noSalary ? 'No salary' : `Income tax ${Math.round(incomeTaxRate(s, pl) * 100)}%`} · Living ${money(costOfLiving(s, pl))}/turn · Lap ${pl.laps}</div>` : ''}
          </div>
        </li>`).join('')}
    </ul>
    <h3>Log</h3>
    <ul class="log">${s.log.slice(-40).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="row footer-actions">
      ${s.phase !== 'gameOver' ? '<button class="ghost" data-act="finish">End game now</button>' : ''}
      <button class="ghost" data-act="quit">Main menu</button>
    </div>`;

  toast = '';
  const on = (act: string, fn: () => void) => panel.querySelector(`[data-act="${act}"]`)?.addEventListener('click', () => guard(fn));
  on('roll', () => {
    roll(s);
    selected = currentPlayer(s).id === p.id ? p.position : selected;
  });
  on('buy', () => buy(s));
  on('end', () => {
    endTurn(s);
    selected = currentPlayer(s).position;
  });
  on('fly', () => {
    const dest = Number(panel.querySelector<HTMLSelectElement>('[data-fly]')!.value);
    fly(s, dest);
    selected = dest;
  });
  on('trade', () => openTrade(s));
  on('finish', () => endGameByNetWorth(s));
  on('new', () => quit());
  on('quit', () => quit(false));
  panel.querySelectorAll<HTMLButtonElement>('[data-build]').forEach((b) => b.addEventListener('click', () => guard(() => build(s, Number(b.dataset.build)))));
  panel.querySelectorAll<HTMLButtonElement>('[data-sell]').forEach((b) => b.addEventListener('click', () => guard(() => sellBuilding(s, Number(b.dataset.sell)))));
}

function nearbySection(airport: number) {
  for (let i = airport; i >= 0; i--) if (BOARD[i].section) return sectionById.get(BOARD[i].section!)!.name;
  return '';
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
    body = `<p>Price ${money(sq.price!)} · Owner: ${owner ? esc(owner.name) : 'Bank'}</p>
      <p class="small">Landing fee ${money(RULES.airports.landingFee)}, flight fare ${money(RULES.airports.flightFare)}, +${RULES.airports.bonusPerExtraAirport * 100}% per extra airport the owner has.</p>`;
  } else {
    const text: Record<string, string> = {
      newYear: `Salary checkpoint and lap marker. Each lap: pay ${RULES.propertyTax.percentOfPropertyValue}% property tax; Bankers earn interest.`,
      event: 'Draw a World Event card.',
      disaster: section ? `Regional disaster: ${section.disasters.join(' or ')}. Damages buildings in ${section.name}.` : '',
      highway: 'Safe zone. Nothing happens.',
      tax: `Pay ${money(RULES.taxSquare.amount)}.`,
    };
    body = `<p class="small">${esc(text[sq.type] ?? '')}</p>`;
  }
  return `
    <div class="detail" style="${section ? `--section:${section.color}` : ''}">
      <div class="detail-art">${tileArt(sq)}</div>
      <div>
        <h3>${tileIcon(sq)} ${esc(sq.name)}</h3>
        ${section ? `<div class="small muted">${esc(section.name)} · square ${index}</div>` : `<div class="small muted">Square ${index}</div>`}
        ${body}
      </div>
    </div>`;
}

function guard(fn: () => void) {
  try {
    fn();
  } catch (e) {
    toast = (e as Error).message;
  }
  update();
}

function quit(clear = true) {
  if (clear) clearSave();
  window.clearTimeout(botTimer);
  game = null;
  renderSetup();
}

function scheduleBot() {
  window.clearTimeout(botTimer);
  if (!game || game.phase === 'gameOver' || !currentPlayer(game).isBot) return;
  if (document.querySelector('.modal-root.open')) return;
  botTimer = window.setTimeout(() => {
    if (!game) return;
    botStep(game);
    selected = currentPlayer(game).position;
    update();
  }, BOT_DELAY_MS);
}

// ---------- trading ----------

function openTrade(s: GameState) {
  const me = currentPlayer(s);
  const others = activePlayers(s).filter((o) => o.id !== me.id);
  let partner = others[0].id;
  const modal = document.getElementById('modal')!;

  const propList = (playerId: number, name: string) =>
    ownedBy(s, playerId)
      .sort((a, b) => a - b)
      .map((i) => `<label class="check"><input type="checkbox" name="${name}" value="${i}" />${tileIcon(square(i))} ${esc(square(i).name)} <span class="muted">${money(square(i).price!)}${levelOf(s, i) ? ` · L${levelOf(s, i)}` : ''}</span></label>`)
      .join('') || '<p class="muted small">No properties</p>';

  const draw = (message = '') => {
    const them = s.players[partner];
    modal.className = 'modal-root open';
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-label="Trade">
        <h3>Trade</h3>
        <label>With <select data-partner>${others.map((o) => `<option value="${o.id}" ${o.id === partner ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
        <div class="trade-cols">
          <div><h4>You give</h4>${propList(me.id, 'give')}</div>
          <div><h4>${esc(them.name)} gives</h4>${propList(them.id, 'get')}</div>
        </div>
        <label>Cash <input type="number" step="10" value="0" data-cash /> <span class="small muted">positive = you pay, negative = they pay</span></label>
        ${message ? `<p class="toast">${esc(message)}</p>` : ''}
        <div class="row">
          <button class="ghost" data-close>Cancel</button>
          <button class="primary" data-propose>Propose</button>
        </div>
      </div>`;
    modal.querySelector('[data-partner]')!.addEventListener('change', (e) => {
      partner = Number((e.target as HTMLSelectElement).value);
      draw();
    });
    modal.querySelector('[data-close]')!.addEventListener('click', closeModal);
    modal.querySelector('[data-propose]')!.addEventListener('click', () => {
      const picked = (name: string) => [...modal.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((x) => Number(x.value));
      const offer: TradeOffer = { from: me.id, to: partner, give: picked('give'), get: picked('get'), cash: Math.round(Number(modal.querySelector<HTMLInputElement>('[data-cash]')!.value) || 0) };
      const err = validateTrade(s, offer);
      if (err) return draw(err);
      if (them.isBot) {
        if (botAcceptsTrade(s, offer)) {
          executeTrade(s, offer);
          toast = `${them.name} accepted.`;
          closeModal();
        } else {
          draw(`${them.name} declined. Bots want about 30% more value than they give.`);
        }
      } else {
        confirmTrade(offer);
      }
    });
  };

  const confirmTrade = (offer: TradeOffer) => {
    const them = s.players[offer.to];
    const names = (xs: number[]) => (xs.length ? xs.map((i) => esc(square(i).name)).join(', ') : 'nothing');
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-label="Accept trade">
        <h3>Pass the device to ${esc(them.name)}</h3>
        <p>${esc(me.name)} offers <strong>${names(offer.give)}</strong>${offer.cash > 0 ? ` + ${money(offer.cash)}` : ''}
          for <strong>${names(offer.get)}</strong>${offer.cash < 0 ? ` + ${money(-offer.cash)}` : ''}.</p>
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
        executeTrade(s, offer);
        toast = `${them.name} accepted.`;
      } catch (e) {
        toast = (e as Error).message;
      }
      closeModal();
    });
  };

  draw();
}

function closeModal() {
  const modal = document.getElementById('modal')!;
  modal.className = 'modal-root';
  modal.innerHTML = '';
  update(false);
}

renderSetup();
