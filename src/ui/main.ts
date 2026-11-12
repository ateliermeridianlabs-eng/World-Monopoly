import { BOARD, PLAYER_COLORS, ROLES, RULES } from '../engine/data';
import { botAcceptsTrade, botStep } from '../engine/bot';
import {
  build, buy, createGame, currentPlayer, endGameByNetWorth, endTurn, executeTrade, fly, money, roll, sellBuilding,
} from '../engine/game';
import type { GameState, PlayerSetup } from '../engine/types';
import type { Controller } from './view';
import { app, detachGame, esc, select, showGame, update } from './view';
import { HOST_SAVE_KEY, NAME_KEY, store } from './store';

const SAVE_KEY = 'world-monopoly-save-v1';
const BOT_DELAY_MS = 450;

let game: GameState | null = null;
let botTimer: number | undefined;

// ---------- persistence (hot-seat) ----------

function save() {
  if (game) store.set(SAVE_KEY, JSON.stringify(game));
}

function loadSave(): GameState | null {
  try {
    const raw = store.get(SAVE_KEY);
    const s = raw ? (JSON.parse(raw) as GameState) : null;
    return s && s.version === 1 && s.phase !== 'gameOver' ? s : null;
  } catch {
    return null;
  }
}

function clearSave() {
  store.remove(SAVE_KEY);
}

// ---------- hot-seat controller ----------

const local: Controller = {
  game: () => game,
  room: () => null,
  canAct: () => !!game && game.phase !== 'gameOver' && !currentPlayer(game).isBot,
  perform(intent) {
    const s = game!;
    switch (intent.type) {
      case 'roll': return roll(s);
      case 'buy': return buy(s);
      case 'build': return build(s, intent.index);
      case 'sell': return sellBuilding(s, intent.index);
      case 'fly': return fly(s, intent.dest);
      case 'endTurn': return endTurn(s);
      case 'finish': return endGameByNetWorth(s);
      case 'proposeTrade': {
        const them = s.players[intent.offer.to];
        if (them.isBot && !botAcceptsTrade(s, intent.offer)) throw new Error(`${them.name} declined. Bots want about 30% more value than they give.`);
        return executeTrade(s, intent.offer);
      }
      default: return; // respondTrade / cancelTrade only exist online
    }
  },
  convertToBot() {},
  takeOver() {},
  leave: () => quit(false),
  newGame: () => quit(true),
  afterRender() {
    save();
    scheduleBot();
  },
};

function quit(clear: boolean) {
  if (clear) clearSave();
  window.clearTimeout(botTimer);
  game = null;
  detachGame();
  renderSetup();
}

function scheduleBot() {
  window.clearTimeout(botTimer);
  if (!game || game.phase === 'gameOver' || !currentPlayer(game).isBot) return;
  if (document.querySelector('.modal-root.open')) return;
  botTimer = window.setTimeout(() => {
    if (!game) return;
    botStep(game);
    select(currentPlayer(game).position);
    update();
  }, BOT_DELAY_MS);
}

function startWith(s: GameState) {
  game = s;
  showGame(local);
}

// ---------- online entry (the net code is a separate chunk, loaded on demand) ----------

type OnlineModule = typeof import('./online');
let onlineModule: Promise<OnlineModule> | null = null;
const loadOnline = () => (onlineModule ??= import('./online').catch((e) => {
  onlineModule = null;
  throw e;
}));

let onlineName = store.get(NAME_KEY) ?? '';
let joinInput = '';
let onlineMsg = '';
let busy = false;
/** undefined = not checked yet, null = no save, string = room code of a hosted game that can be resumed. */
let hostSaveCode: string | null | undefined;

const onlineExit = () => {
  hostSaveCode = undefined;
  onlineMsg = '';
  renderSetup();
};

async function startOnline(req: Parameters<OnlineModule['enter']>[0]) {
  const name = onlineName.trim();
  if (!name && req.kind !== 'resume') {
    onlineMsg = 'Enter your name first.';
    return renderSetup();
  }
  if (name) store.set(NAME_KEY, name);
  busy = true;
  onlineMsg = 'Loading online play…';
  renderSetup();
  let error: string | null;
  try {
    error = await (await loadOnline()).enter(req, { name, exit: onlineExit });
  } catch {
    error = 'Could not load online play. Check your connection and try again.';
  }
  busy = false;
  if (error) {
    onlineMsg = error;
    renderSetup();
  }
}

/** Page opened with an invite link (#room=CODE). */
function arriveFromLink() {
  const name = (store.get(NAME_KEY) ?? '').trim();
  const join = async () => {
    onlineName = name || onlineName;
    const error = await loadOnline().then((m) => m.enter({ kind: 'join', input: location.hash }, { name: onlineName, exit: onlineExit })).catch(() => 'Could not load online play. Check your connection and try again.');
    if (error) {
      history.replaceState(history.state, '', location.pathname + location.search);
      onlineMsg = error;
      renderSetup();
    }
  };
  if (name) return void join();
  app.innerHTML = `
    <main class="setup">
      <h1>World Monopoly</h1>
      <p>You have been invited to an online game. What should we call you?</p>
      <input data-prompt-name maxlength="16" aria-label="Your name" autocomplete="nickname" />
      <p class="toast" data-prompt-msg hidden></p>
      <div class="row">
        <button class="ghost" data-act="cancel">Cancel</button>
        <button class="primary" data-act="go">Join game</button>
      </div>
    </main>`;
  const input = app.querySelector<HTMLInputElement>('[data-prompt-name]')!;
  input.focus();
  const go = () => {
    if (!input.value.trim()) {
      const msg = app.querySelector<HTMLElement>('[data-prompt-msg]')!;
      msg.hidden = false;
      msg.textContent = 'Enter your name first.';
      return;
    }
    onlineName = input.value.trim();
    store.set(NAME_KEY, onlineName);
    void join();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  app.querySelector('[data-act="go"]')!.addEventListener('click', go);
  app.querySelector('[data-act="cancel"]')!.addEventListener('click', () => {
    history.replaceState(history.state, '', location.pathname + location.search);
    renderSetup();
  });
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
  // A hosted game left by a reload: only a stored key is checked here; the net chunk validates it.
  if (hostSaveCode === undefined && store.get(HOST_SAVE_KEY) !== null) {
    hostSaveCode = null;
    void loadOnline().then((m) => {
      hostSaveCode = m.hostSaveRoom();
      if (hostSaveCode && document.querySelector('.setup')) renderSetup();
    }).catch(() => {
      hostSaveCode = undefined;
    });
  }
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
      <section class="online-card" aria-labelledby="online-h">
        <h2 id="online-h">Play online</h2>
        <p class="muted small">Each player uses their own device. One player hosts, everyone else joins with a link or room code. No account needed.</p>
        ${hostSaveCode ? `<button class="primary wide" data-act="resume-host" ${busy ? 'disabled' : ''}>Resume hosted game (room ${esc(hostSaveCode)})</button>` : ''}
        <label class="field">Your name <input data-online-name value="${esc(onlineName)}" maxlength="16" autocomplete="nickname" /></label>
        <button class="wide" data-act="host-online" ${busy ? 'disabled' : ''}>Host online game</button>
        <div class="join-row">
          <input data-join value="${esc(joinInput)}" placeholder="Room code or invite link" aria-label="Room code or invite link" autocomplete="off" autocapitalize="characters" spellcheck="false" />
          <button data-act="join" ${busy ? 'disabled' : ''}>Join with code</button>
        </div>
        ${onlineMsg ? `<p class="toast" role="status">${esc(onlineMsg)}</p>` : ''}
      </section>
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

  const nameInput = app.querySelector<HTMLInputElement>('[data-online-name]')!;
  const joinField = app.querySelector<HTMLInputElement>('[data-join]')!;
  nameInput.addEventListener('input', () => (onlineName = nameInput.value));
  joinField.addEventListener('input', () => (joinInput = joinField.value));
  const join = () => {
    if (!joinInput.trim()) {
      onlineMsg = 'Paste a room code or an invite link.';
      return renderSetup();
    }
    void startOnline({ kind: 'join', input: joinInput });
  };
  joinField.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  app.querySelector('[data-act="join"]')!.addEventListener('click', join);
  app.querySelector('[data-act="host-online"]')!.addEventListener('click', () => void startOnline({ kind: 'host' }));
  app.querySelector('[data-act="resume-host"]')?.addEventListener('click', () => void startOnline({ kind: 'resume' }));
}

if (/(^|[#&])room=/.test(location.hash)) arriveFromLink();
else renderSetup();
