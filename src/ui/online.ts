// Online play UI: lobby, connection handling, and the Controller that plugs a Session into the game view.
// Loaded with a dynamic import() from main.ts, so hot-seat-only visitors never download the net code.

import { PLAYER_COLORS, RULES, ROLES, roleById } from '../engine/data';
import {
  createTrysteroTransport, hostSession, joinSession, loadHostSave, newRoomCode, normalizeRoomCode, roomLink, setRoomInUrl, turnFromEnv,
} from '../net';
import type { Seat, Session, Transport } from '../net';
import { NAME_KEY, devParams, store, uiStorage } from './store';
import type { Controller, RoomView } from './view';
import { app, bindInvite, detachGame, esc, hostLostHtml, inviteHtml, notify, showGame, update } from './view';

export type OnlineRequest = { kind: 'host' } | { kind: 'join'; input: string } | { kind: 'resume' };
export interface OnlineEnv {
  name: string;
  /** Back to the setup screen. */
  exit(): void;
}

/** Room code of the unfinished game this browser hosted, if any. */
export function hostSaveRoom(): string | null {
  return loadHostSave(uiStorage)?.roomCode ?? null;
}

/** Accepts a bare code or anything containing `room=CODE` (a pasted link or hash). */
function parseRoomInput(input: string): string | null {
  return normalizeRoomCode(input) ?? normalizeRoomCode(/room=([^&\s]+)/i.exec(input)?.[1] ?? '');
}

const CONNECT_HINT_MS = 15_000;

interface Active {
  session: Session;
  env: OnlineEnv;
  controller: Controller;
  screen: 'connecting' | 'lobby' | 'game' | null;
  unsubscribe: () => void;
  unload: () => void;
  hintTimer?: number;
  toastTimer?: number;
  toast: string;
  name: string;
}
let active: Active | null = null;

/** Drops the current online session completely: listeners, timers, transport, URL. Safe to call twice. */
function teardown() {
  const a = active;
  if (!a) return;
  active = null;
  window.clearTimeout(a.hintTimer);
  window.clearTimeout(a.toastTimer);
  window.removeEventListener('beforeunload', a.unload);
  a.unsubscribe();
  a.session.leave();
  setRoomInUrl(null);
  detachGame();
}

function leaveToSetup() {
  const env = active?.env;
  teardown();
  env?.exit();
}

async function makeTransport(code: string): Promise<Transport> {
  if (import.meta.env.DEV && devParams?.get('memnet')) return (await import('./memnet')).createMemnetTransport(code);
  return createTrysteroTransport(code, { turn: turnFromEnv(import.meta.env) });
}

/** Starts (or resumes, or joins) an online session. Returns an error message to show on the setup screen, else null. */
export async function enter(req: OnlineRequest, env: OnlineEnv): Promise<string | null> {
  teardown();
  let code: string | null;
  let resume: ReturnType<typeof loadHostSave> = null;
  if (req.kind === 'host') {
    code = newRoomCode();
  } else if (req.kind === 'resume') {
    resume = loadHostSave(uiStorage);
    if (!resume) return 'There is no saved hosted game to resume.';
    code = resume.roomCode;
  } else {
    code = parseRoomInput(req.input);
    if (!code) return 'That is not a valid room code or invite link.';
    // A reload of the host's own page lands here with #room=CODE: continue hosting instead of joining yourself.
    const save = loadHostSave(uiStorage);
    if (save?.roomCode === code) resume = save;
  }

  let transport: Transport;
  try {
    transport = await makeTransport(code);
  } catch {
    return 'Online play is not available in this browser.';
  }
  const own = resume?.snapshot.seats.find((s) => s.clientId === resume!.snapshot.hostId)?.name;
  const name = own ?? env.name;
  const opts = { transport, roomCode: code, name, storage: uiStorage };
  let session: Session;
  try {
    session = req.kind === 'host' ? hostSession(opts) : resume ? hostSession({ ...opts, resume: resume.snapshot }) : joinSession(opts);
  } catch {
    transport.leave();
    return 'Could not start the online session.';
  }
  setRoomInUrl(code);

  const a: Active = {
    session,
    env,
    controller: controllerFor(session),
    screen: null,
    unsubscribe: session.subscribe((rejected) => onChange(a, rejected)),
    // A reload must keep the host's save so it can resume; leave() would delete it. Guests just say goodbye.
    unload: () => {
      if (!session.isHost) session.leave();
    },
    toast: '',
    name,
  };
  active = a;
  window.addEventListener('beforeunload', a.unload);
  onChange(a);
  return null;
}

// ---------- controller ----------

function roomView(session: Session): RoomView | null {
  const snap = session.snapshot;
  if (!snap) return null;
  const self = session.selfSeat;
  return {
    code: session.roomCode,
    link: roomLink(session.roomCode, location.href),
    selfSeat: self,
    isHost: session.isHost,
    hostId: snap.hostId,
    seats: snap.seats,
    status: session.status,
    pendingTrade: snap.pendingTrade,
    canFinish: session.isHost && self !== null && snap.seats[self]?.clientId === snap.hostId,
    online: session.peers,
    networkError: session.networkError,
  };
}

function controllerFor(session: Session): Controller {
  const game = () => session.snapshot?.game ?? null;
  return {
    game,
    room: () => roomView(session),
    canAct() {
      const s = game();
      const me = session.selfSeat;
      return !!s && me !== null && s.phase !== 'gameOver' && session.status === 'connected' && s.current === me && !s.players[me]?.isBot;
    },
    perform: (intent) => session.send(intent),
    convertToBot: (seat) => session.convertToBot(seat),
    takeOver: () => session.takeOverAsHost(),
    leave: leaveToSetup,
    newGame: leaveToSetup,
  };
}

// ---------- routing between connecting / lobby / game ----------

function onChange(a: Active, rejected?: string) {
  if (active !== a || a.session.status === 'closed') return;
  const snap = a.session.snapshot;
  const want = !snap ? 'connecting' : snap.phase === 'playing' && snap.game ? 'game' : 'lobby';
  if (want === 'game') {
    if (a.screen !== 'game') {
      a.screen = 'game';
      showGame(a.controller);
      if (rejected) notify(rejected);
    } else if (rejected) notify(rejected);
    else update();
    return;
  }
  a.screen = want;
  if (rejected) {
    a.toast = rejected;
    window.clearTimeout(a.toastTimer);
    a.toastTimer = window.setTimeout(() => {
      a.toast = '';
      if (active === a && a.screen !== 'game') render(a);
    }, 6000);
  }
  render(a);
}

// A re-render between a button's pointer-down and pointer-up (e.g. the name field's blur sends a rename and
// the reply redraws the lobby) would swallow the click, so redraws wait until the pointer is released.
let pressed = false;
let deferred: (() => void) | null = null;
document.addEventListener('pointerdown', () => (pressed = true), true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    pressed = false;
    window.setTimeout(() => {
      const run = deferred;
      deferred = null;
      run?.();
    }, 0);
  }, true);
}

/** Re-render without losing what the user is typing or which field has focus. */
function render(a: Active) {
  if (pressed) {
    deferred = () => active === a && a.screen !== 'game' && render(a);
    return;
  }
  const el = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
  const key = el && app.contains(el) ? el.dataset.key : undefined;
  const typed = el instanceof HTMLInputElement ? { value: el.value, from: el.selectionStart, to: el.selectionEnd } : null;
  if (a.screen === 'connecting') renderConnecting(a);
  else renderLobby(a);
  if (!key) return;
  const next = app.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!next || next.disabled) return;
  if (typed && next instanceof HTMLInputElement) {
    next.value = typed.value;
    next.focus();
    try {
      next.setSelectionRange(typed.from, typed.to);
    } catch {
      /* number inputs have no caret */
    }
  } else next.focus();
}

function statusHtml(a: Active) {
  const err = a.session.networkError;
  return `${err ? `<p class="toast" role="status">${esc(err)}</p>` : ''}${a.toast ? `<p class="toast" role="status">${esc(a.toast)}</p>` : ''}`;
}

function renderConnecting(a: Active) {
  const waited = a.hintTimer === undefined;
  if (waited) {
    a.hintTimer = window.setTimeout(() => {
      a.hintTimer = -1;
      if (active === a && a.screen === 'connecting') render(a);
    }, CONNECT_HINT_MS);
  }
  const slow = a.hintTimer === -1;
  app.innerHTML = `
    <main class="setup lobby">
      <h1>World Monopoly</h1>
      <div class="room-card">
        <span class="muted small">Room</span>
        <div class="room-code" aria-label="Room code">${esc(a.session.roomCode)}</div>
        <p role="status">Connecting…</p>
        ${slow ? '<p class="muted small">Still nothing from the host. The room may not exist (check the code), the host may have closed the page, or this network may be blocking peer-to-peer connections.</p>' : ''}
      </div>
      ${statusHtml(a)}
      <button class="ghost wide" data-act="leave">Leave</button>
    </main>`;
  app.querySelector('[data-act="leave"]')!.addEventListener('click', leaveToSetup);
}

// ---------- lobby ----------

function renderLobby(a: Active) {
  const { session } = a;
  const snap = session.snapshot!;
  const host = session.isHost;
  const self = session.selfSeat;
  const room = roomView(session)!;
  const seats = snap.seats;
  const open = seats.filter((s) => s.kind === 'open').length;
  const present = seats.filter((s) => s.kind === 'human' && s.connected).length;
  const startBlock = !host ? null
    : open ? `Fill or remove the ${open} open seat${open === 1 ? '' : 's'} first.`
      : seats.length < RULES.players.min ? `Need at least ${RULES.players.min} seats.` : null;

  const holder = (seat: Seat, i: number) => {
    if (seat.kind === 'open') return '<span class="chip">open</span>';
    if (seat.kind === 'bot') return '<span class="chip">bot</span>';
    const you = i === self ? '<span class="chip you">you</span> ' : '';
    const hostChip = seat.clientId === snap.hostId ? '<span class="chip">host</span> ' : '';
    return `${you}${hostChip}<span class="presence"><i class="dot ${seat.connected ? 'on' : 'off'}"></i>${seat.connected ? 'connected' : 'away'}</span>`;
  };

  const seatRow = (seat: Seat, i: number) => {
    const mine = i === self;
    const editable = mine || (host && seat.kind === 'bot');
    const role = roleById.get(seat.roleId) ?? ROLES[0];
    const actions: string[] = [];
    if (seat.kind === 'open') {
      actions.push(`<button data-claim="${i}">Sit here</button>`);
      if (host) actions.push(`<button data-seat-bot="${i}">Make bot</button>`);
    } else {
      if (mine) actions.push('<button data-release>Leave seat</button>');
      if (host && !mine) actions.push(`<button data-seat-open="${i}">${seat.kind === 'bot' ? 'Set open' : 'Remove player'}</button>`);
    }
    if (host && seats.length > RULES.players.min) actions.push(`<button class="ghost" data-seat-remove="${i}" aria-label="Remove seat ${i + 1}">✕</button>`);
    return `
      <div class="setup-row lobby-row">
        <span class="swatch" style="background:${esc(PLAYER_COLORS[i] ?? '#888')}"></span>
        ${seat.kind === 'open'
          ? '<span class="seat-name muted">Open seat</span>'
          : editable
            ? `<input data-key="name-${i}" data-seat-name="${i}" value="${esc(seat.name)}" maxlength="16" aria-label="Seat ${i + 1} name" />`
            : `<span class="seat-name">${esc(seat.name)}</span>`}
        <select data-key="role-${i}" data-seat-role="${i}" aria-label="Seat ${i + 1} role" ${editable ? '' : 'disabled'}>
          ${ROLES.map((r) => `<option value="${esc(r.id)}" ${r.id === seat.roleId ? 'selected' : ''} ${seats.some((o, j) => j !== i && o.roleId === r.id) ? 'disabled' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
        ${actions.length ? `<div class="seat-actions">${actions.join('')}</div>` : ''}
      </div>
      <p class="role-summary">${holder(seat, i)} · ${esc(role.summary)}</p>`;
  };

  app.innerHTML = `
    <main class="setup lobby">
      <h1>World Monopoly</h1>
      ${hostLostHtml(room)}
      <div class="room-card">
        <span class="muted small">Room code</span>
        <div class="room-code" aria-label="Room code">${esc(session.roomCode)}</div>
        ${inviteHtml(room.link)}
        <p class="small muted" data-conn role="status">${host ? `Hosting · ${present} player${present === 1 ? '' : 's'} connected` : session.status === 'host-lost' ? 'Host lost' : `Connected · ${present} player${present === 1 ? '' : 's'} in the room`}</p>
      </div>
      ${statusHtml(a)}
      ${self === null ? `
        <div class="toast">You are watching. Sit in an open seat to play.</div>
        <label class="field">Your name <input data-key="myname" data-myname value="${esc(a.name)}" maxlength="16" aria-label="Your name" /></label>` : ''}
      <div class="setup-rows">${seats.map(seatRow).join('')}</div>
      <div class="setup-actions">
        ${host ? `${seats.length < RULES.players.max ? '<button data-act="add-seat">+ Add seat</button>' : '<span></span>'}
        <label>Round limit <input type="number" min="0" max="999" value="${snap.roundLimit}" data-key="limit" data-limit aria-label="Round limit" /></label>`
          : `<span class="muted small">Round limit: ${snap.roundLimit || 'none'} (set by the host)</span>`}
      </div>
      ${host
        ? `<button class="primary wide" data-act="start" ${startBlock ? 'disabled' : ''}>Start game</button>
           ${startBlock ? `<p class="muted small" role="status">${esc(startBlock)}</p>` : ''}`
        : '<p class="muted" role="status">Waiting for the host to start the game…</p>'}
      <button class="ghost wide" data-act="leave">Leave</button>
    </main>`;

  const q = <T extends Element>(sel: string) => app.querySelectorAll<T>(sel);
  bindInvite(app, room.link);
  app.querySelector('[data-act="takeover"]')?.addEventListener('click', () => session.takeOverAsHost());
  app.querySelector('[data-act="leave"]')!.addEventListener('click', leaveToSetup);
  q<HTMLButtonElement>('[data-claim]').forEach((b) => b.addEventListener('click', () => session.claimSeat(Number(b.dataset.claim))));
  app.querySelector('[data-release]')?.addEventListener('click', () => session.releaseSeat());
  q<HTMLButtonElement>('[data-seat-bot]').forEach((b) => b.addEventListener('click', () => session.setSeat(Number(b.dataset.seatBot), { kind: 'bot' })));
  q<HTMLButtonElement>('[data-seat-open]').forEach((b) => b.addEventListener('click', () => session.setSeat(Number(b.dataset.seatOpen), { kind: 'open' })));
  q<HTMLButtonElement>('[data-seat-remove]').forEach((b) => b.addEventListener('click', () => session.removeSeat(Number(b.dataset.seatRemove))));
  app.querySelector('[data-act="add-seat"]')?.addEventListener('click', () => session.addSeat());
  app.querySelector('[data-act="start"]')?.addEventListener('click', () => session.start());

  q<HTMLSelectElement>('[data-seat-role]').forEach((el) =>
    el.addEventListener('change', () => {
      const i = Number(el.dataset.seatRole);
      if (i === self) session.setRole(el.value);
      else session.setSeat(i, { roleId: el.value });
    }));
  // Names are sent when the field is committed (Enter or leaving it), not on every keystroke.
  const rename = (el: HTMLInputElement, i: number) => {
    const name = el.value.trim();
    if (!name || name === session.snapshot?.seats[i]?.name) return;
    if (i === self) {
      store.set(NAME_KEY, name);
      a.name = name;
      session.setName(name);
    } else session.setSeat(i, { name });
  };
  q<HTMLInputElement>('[data-seat-name]').forEach((el) => {
    const commit = () => rename(el, Number(el.dataset.seatName));
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
  });
  const mine = app.querySelector<HTMLInputElement>('[data-myname]');
  const commitMine = () => {
    const name = mine!.value.trim();
    if (!name || name === a.name) return;
    a.name = name;
    store.set(NAME_KEY, name);
    session.setName(name);
  };
  mine?.addEventListener('change', commitMine);
  mine?.addEventListener('blur', commitMine);
  app.querySelector<HTMLInputElement>('[data-limit]')?.addEventListener('change', (e) => {
    const n = Math.floor(Number((e.target as HTMLInputElement).value));
    session.setRoundLimit(Number.isFinite(n) ? n : 0);
  });
}
