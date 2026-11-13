// End-to-end check of online play without relays: drives two pages through the dev-only BroadcastChannel
// transport (`?memnet=1&as=NAME`). Not part of `npm test`; needs a Chrome and playwright-core:
//   npm i --no-save playwright-core && CHROME=/usr/bin/google-chrome npm run e2e
// Starts its own `vite` dev server. Screenshots go to $SHOTS (default /tmp/e2e-shots).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm i --no-save playwright-core');
  process.exit(2);
}

const PORT = 5188;
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOTS ?? '/tmp/e2e-shots';
mkdirSync(SHOTS, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
// One context so both pages share a BroadcastChannel; `as=` keeps their localStorage keys apart.
const [W, H] = (process.env.VIEWPORT ?? '1280x800').split('x').map(Number);
const context = await browser.newContext({ viewport: { width: W, height: H } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.slice(0, -1) });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
async function open(as, hash = '', { noClipboard = false } = {}) {
  const page = await context.newPage();
  if (noClipboard) await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  page.on('pageerror', (e) => errors.push(`${as}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push(`${as}: ${m.text()}`));
  await page.goto(`${BASE}?memnet=1&as=${as}${hash}`);
  return page;
}
async function shot(page, name) {
  await page.bringToFront(); // background tabs throttle the board's smooth scroll
  await sleep(700);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: W < 700 });
}
const turnName = (page) => page.locator('.turn strong').first().innerText();
const has = async (page, sel) => (await page.locator(sel).count()) > 0;

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(50);
  }
  check(false, `timeout: ${what}`);
  throw new Error(`timeout: ${what}`);
}

try {
  await sleep(1500);
  // ---- hot-seat still works: bots move, autosave, resume
  const solo = await open('solo');
  check(!(await solo.evaluate(() => performance.getEntriesByType('resource').some((r) => /\/src\/net\/|\/src\/ui\/(online|memnet)|trystero/i.test(r.name)))), 'setup screen did not load the online/net code (dev server modules)');
  await solo.click('[data-act="start"]');
  await solo.waitForSelector('[data-act="roll"]');
  check(!(await has(solo, '.room-bar')), 'hot-seat panel has no room bar');
  await solo.click('[data-act="trade"]'); // also available before the roll, with a From picker
  await solo.waitForSelector('.modal [data-from]');
  check((await solo.locator('.modal [data-from] option').count()) === 1 && (await solo.locator('.modal [data-partner] option').count()) === 3, 'hot-seat trade modal has From (humans only) and With pickers before the roll');
  await solo.click('[data-close]');
  await solo.click('[data-act="roll"]');
  await solo.waitForSelector('[data-act="end"]');
  await solo.click('[data-act="end"]');
  await until(async () => /thinking/.test(await solo.locator('.actions').innerText()), 'a bot is thinking');
  await until(async () => (await has(solo, '[data-act="roll"]')) && /You/.test(await turnName(solo)), 'bots finish and it is the human turn again', 20000);
  check(true, 'hot-seat: bots played their turns and control returned');
  await solo.reload();
  await solo.waitForSelector('[data-act="resume"]');
  await solo.click('[data-act="resume"]');
  await solo.waitForSelector('.panel');
  check(true, 'hot-seat: autosave resumes after reload');
  await solo.close();

  // ---- names are attacker-controlled: HTML in a name must show as text everywhere
  {
    const evilHost = await open('evil1');
    await evilHost.fill('[data-online-name]', '<b id=_x>');
    await evilHost.click('[data-act="host-online"]');
    await evilHost.waitForSelector('.room-code');
    const evilCode = (await evilHost.locator('.room-code').innerText()).trim().replaceAll('-', '');
    const evilGuest = await open('evil2', `#room=${evilCode}`);
    await evilGuest.waitForSelector('[data-prompt-name]');
    await evilGuest.fill('[data-prompt-name]', '<i id=_y>');
    await evilGuest.click('[data-act="go"]');
    await evilGuest.waitForSelector('[data-claim="1"]');
    await evilGuest.click('[data-claim="1"]');
    await evilHost.waitForSelector('.seat-name:has-text("<i id=_y>")');
    check((await evilHost.locator('.seat-name').first().innerText()).includes('<i id=_y>'), 'lobby shows a hostile name as plain text');
    check((await evilHost.locator('#_y').count()) === 0 && (await evilGuest.locator('#_x').count()) === 0, 'no HTML was injected in the lobby');
    await evilHost.click('[data-act="start"]');
    await evilHost.waitForSelector('.panel');
    await evilGuest.waitForSelector('.panel');
    check((await evilHost.locator('#_x, #_y').count()) === 0 && (await evilGuest.locator('#_x, #_y').count()) === 0, 'no HTML was injected on the game screen');
    check((await evilGuest.locator('.players').innerText()).includes('<b id=_x>'), 'game screen shows the hostile name as text');
    await evilHost.close();
    await evilGuest.close();
  }

  // ---- joining a room nobody hosts: hint after ~15 s, Leave works
  {
    const lost = await open('lost', '#room=ABCDEFGHJKM2');
    await lost.waitForSelector('[data-prompt-name]');
    await lost.fill('[data-prompt-name]', 'Lee');
    await lost.click('[data-act="go"]');
    await lost.waitForSelector('text=Connecting');
    check(!/may not exist/.test(await lost.locator('main').innerText()), 'no hint right away');
    await until(async () => /may not exist/.test(await lost.locator('main').innerText()), 'connection hint', 20000);
    check(true, 'after ~15 s the connecting screen hints the room may not exist');
    await lost.click('[data-act="leave"]');
    await lost.waitForSelector('.online-card');
    check(!/room=/.test(lost.url()), 'Leave from the connecting screen returns to setup');
    await lost.close();
  }

  // ---- host creates a room
  const host = await open('host');
  await host.fill('[data-online-name]', 'Hana');
  await host.click('[data-act="host-online"]');
  await host.waitForSelector('.room-code');
  const shown = (await host.locator('.room-code').innerText()).trim();
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(shown), `host lobby shows grouped room code ${shown}`);
  const code = shown.replaceAll('-', '');
  await host.click('[data-act="copy-link"]');
  await until(async () => (await host.evaluate(() => navigator.clipboard.readText())).includes(`#room=${code}`), 'invite link copied');
  check(true, 'Copy invite link puts the #room= link on the clipboard');
  await shot(host, '1-lobby-host');

  // ---- guest joins by link (name prompt first, no stored name)
  const guest = await open('guest', `#room=${code}`, { noClipboard: true });
  await guest.waitForSelector('[data-prompt-name]');
  await guest.fill('[data-prompt-name]', 'Gus');
  await guest.click('[data-act="go"]');
  await guest.waitForSelector('.room-code');
  check((await guest.locator('.room-code').innerText()).trim() === shown, 'guest joined by link and sees the same room code');
  await until(async () => /Connected/.test(await guest.locator('[data-conn]').innerText()), 'guest connected');
  check(await has(guest, '.toast:has-text("watching")'), 'guest is a spectator before claiming');
  await guest.click('[data-act="copy-link"]');
  await guest.waitForSelector('[data-invite-link]');
  check((await guest.locator('[data-invite-link]').inputValue()).includes(`#room=${code}`) && (await guest.evaluate(() => document.activeElement?.matches('[data-invite-link]'))), 'without a clipboard API the link shows in a selected read-only field');
  check(!(await has(guest, '[data-act="start"]')), 'guest has no Start button');
  check(await host.locator('[data-act="start"]').isDisabled(), 'host Start is disabled with an open seat');
  check(/open seat/.test(await host.locator('.setup-actions ~ .muted[role=status]').innerText()), 'host sees the reason Start is disabled');

  // ---- guest claims seat 1 and picks a role
  await guest.click('[data-claim="1"]');
  await guest.waitForSelector('[data-seat-name="1"]');
  const taken = await guest.locator('[data-seat-role="1"] option:disabled').count();
  check(taken === 1, `guest role select disables the host's role (${taken} disabled)`);
  await guest.selectOption('[data-seat-role="1"]', 'banker');
  await until(async () => (await host.locator('[data-seat-role="1"]').inputValue()) === 'banker', 'host sees guest role');
  check(true, 'role change reaches the host');
  check(await host.locator('[data-seat-role="1"]').isDisabled(), 'host cannot edit a human guest seat role');
  await shot(guest, '2-lobby-guest');

  // ---- host adds a bot and starts
  await host.click('[data-act="add-seat"]');
  await host.waitForSelector('[data-seat-bot="2"]');
  await host.click('[data-seat-bot="2"]');
  await host.waitForSelector('[data-seat-name="2"]');
  await host.fill('[data-seat-name="2"]', 'Botty');
  await host.press('[data-seat-name="2"]', 'Enter');
  await until(async () => (await guest.locator('.seat-name').allInnerTexts()).includes('Botty'), 'guest sees bot rename');
  await host.fill('[data-limit]', '30');
  await host.press('[data-limit]', 'Enter');
  await until(async () => /30/.test(await guest.locator('.setup-actions').innerText()), 'guest sees round limit 30');
  check(await host.locator('[data-act="start"]').isEnabled(), 'host Start enabled with all seats filled');
  await host.click('[data-act="start"]');
  await host.waitForSelector('.panel');
  await guest.waitForSelector('.panel');
  check(true, 'both screens switched to the game');

  // ---- play turns; check controls on both sides
  const pages = { Hana: host, Gus: guest };
  const props = async (page, who) => {
    const t = await page.locator('.players li', { hasText: who }).first().innerText();
    return Number(/(\d+) props/.exec(t)?.[1] ?? 0);
  };
  let sawWaiting = false;
  let inspected = false;
  async function step() {
    const who = await turnName(host);
    const page = pages[who];
    if (!page) return sleep(150); // bot
    const other = who === 'Hana' ? guest : host;
    await until(async () => (await turnName(other)) === who, 'other side sees same turn');
    const hasRoll = await has(page, '[data-act="roll"]');
    const otherHasControls = (await has(other, '[data-act="roll"]')) || (await has(other, '[data-act="end"]'));
    if (otherHasControls) check(false, `non-current player (${who} to move) sees controls`);
    if (!sawWaiting && /Waiting for/.test(await other.locator('.actions').innerText())) sawWaiting = true;
    if (hasRoll && !inspected) {
      // a remote action must not move this player's selected tile or scroll position
      inspected = true;
      await other.click('[data-tile="50"]');
      const before = await other.evaluate(() => document.querySelector('.board-scroll').scrollTop);
      await page.click('[data-act="roll"]');
      await sleep(600);
      const after = await other.evaluate(() => [document.querySelector('.board-scroll').scrollTop, document.querySelector('.tile.selected')?.dataset.tile]);
      check(after[1] === '50' && after[0] === before, `remote roll left the other player's selected tile and scroll alone (tile ${after[1]}, scroll ${before} -> ${after[0]})`);
    } else if (hasRoll) await page.click('[data-act="roll"]');
    await page.waitForSelector('[data-act="end"]');
    if (await has(page, '[data-act="buy"]:not([disabled])')) await page.click('[data-act="buy"]:not([disabled])');
    return who;
  }
  async function endTurn(page) {
    await page.click('[data-act="end"]');
  }
  let guard = 0;
  let shotsTaken = false;
  let traded = false;
  while (guard++ < 60 && !traded) {
    const who = await step();
    if (!who) continue;
    const page = pages[who];
    const other = pages[who === 'Hana' ? 'Gus' : 'Hana'];
    const otherName = who === 'Hana' ? 'Gus' : 'Hana';
    if (!shotsTaken) {
      shotsTaken = true;
      await shot(page, '3-game-current');
      await shot(other, '3-game-waiting');
    }
    // trade as soon as the mover owns something
    if ((await props(page, who)) > 0) {
      await page.click('[data-act="trade"]');
      await page.waitForSelector('.modal [data-partner]');
      await page.selectOption('[data-partner]', { label: otherName });
      await page.locator('.modal input[name="give"]').first().check();
      await page.click('[data-propose]');
      await until(async () => (await other.locator('.modal:has-text("Trade offer")').count()) > 0, 'target sees trade prompt');
      check(true, `${otherName} sees a trade prompt even though it is not their turn`);
      check(/Waiting for/.test(await page.locator('.trade-bar').innerText()) && (await has(page, '[data-act="cancel-trade"]')), 'proposer sees waiting + Cancel');
      check(await has(page, '[data-act="end"]'), 'proposer keeps the normal turn buttons while the offer is open');
      check(!(await has(page, '.modal.open, .modal-root.open')), 'proposer has no modal open');
      await shot(other, '4-trade-prompt');
      // cancel once: prompt must close by itself
      await page.click('[data-act="cancel-trade"]');
      await until(async () => (await other.locator('.modal-root.open').count()) === 0, 'prompt closes after cancel');
      check(true, 'prompt closed on target after the proposer cancelled');
      // the player whose turn it is not offers, buying one of the mover's properties for cash; the mover answers
      check(await has(other, '[data-act="trade"]'), 'a player who is not on turn has a Trade button');
      await other.click('[data-act="trade"]');
      await other.waitForSelector('.modal [data-partner]');
      await other.selectOption('[data-partner]', { label: who });
      await other.locator('.modal input[name="get"]').first().check();
      await other.fill('.modal [data-cash]', '10');
      await other.click('[data-propose]');
      await until(async () => (await page.locator('.modal:has-text("Trade offer")').count()) > 0, 'mover sees the off-turn offer');
      check(true, `${who} sees an offer from ${otherName} on their own turn`);
      await page.click('.modal [data-accept]');
      await until(async () => /traded/.test(await page.locator('.log').innerText()), 'trade appears in the log');
      check(true, 'off-turn trade accepted and executed');
      check((await other.locator('.modal-root.open').count()) === 0 && (await page.locator('.modal-root.open').count()) === 0, 'no modals left open');
      traded = true;
      await endTurn(page);
      break;
    }
    await endTurn(page);
  }
  check(sawWaiting, 'a waiting player saw "Waiting for NAME"');
  check(traded, 'a human-to-human trade happened');

  // ---- host hands the guest's seat to a bot (with a confirm); the guest gets it back by reconnecting
  await host.click('[data-botseat="1"]');
  check(/Hand Gus/.test(await host.locator('.confirm').innerText()), 'hand-to-bot asks for confirmation');
  await host.click('[data-act="confirm-no"]');
  check(!(await has(host, '.confirm')), 'cancelling the confirm changes nothing');
  await host.click('[data-botseat="1"]');
  await host.click('[data-act="confirm-yes"]');
  await until(async () => /now played by a bot/.test(await host.locator('.log').innerText()), 'bot takeover in log');
  await until(async () => /bot/.test(await guest.locator('.players li', { hasText: 'Gus' }).first().innerText()), 'guest sees its seat is a bot');
  check(!(await has(guest, '[data-act="roll"]')) && !(await has(guest, '[data-act="end"]')), 'handed-over player has no controls');

  // ---- guest reload reclaims its seat
  await guest.reload();
  await guest.waitForSelector('.panel');
  await until(async () => /you/.test(await guest.locator('.players li', { hasText: 'Gus' }).first().innerText()), 'guest has "you" tag after reload');
  check(true, 'guest reload reclaimed its seat (marked you)');
  await until(async () => !/away/.test(await host.locator('.players li', { hasText: 'Gus' }).first().innerText()), 'Gus not away on host');
  check(true, 'host sees Gus connected again');
  await shot(host, '5-game-host-desktop');

  // ---- host reload resumes
  await host.reload();
  await host.waitForSelector('.panel');
  const hostText = await host.locator('.room-bar').innerText();
  check(hostText.includes(shown), 'host reload resumed the same room');
  await until(async () => !(await has(guest, '.banner')) && !/away/.test(await guest.locator('.players li', { hasText: 'Hana' }).first().innerText()), 'guest follows resumed host');
  check(true, 'guest follows the resumed host (no host-lost banner, host not away)');
  check(await has(host, '[data-act="finish"]'), 'host sees "End game now"');
  check(!(await has(guest, '[data-act="finish"]')), 'guest does not see "End game now"');
  check(await has(host, '[data-botseat]'), 'host sees "Hand to bot" for the guest seat');
  check(!(await has(guest, '[data-botseat]')), 'guest has no "Hand to bot"');

  // ---- host closes the page: guest sees banner and takes over
  await host.close();
  await guest.waitForSelector('.banner');
  check(/Host disconnected/.test(await guest.locator('.banner').innerText()), 'guest sees the host-lost banner');
  check(await has(guest, '.board'), 'board stays visible under the banner');
  await shot(guest, '6-host-lost');
  await guest.click('[data-act="takeover"]');
  await until(async () => !(await has(guest, '.banner')), 'banner gone after takeover');
  check(true, 'takeover removed the banner');
  check(await has(guest, '[data-act="finish"]'), 'new host sees "End game now"');
  await until(async () => (await has(guest, '[data-act="roll"]')) || (await has(guest, '[data-act="end"]')) || /Waiting|thinking/.test(await guest.locator('.actions').innerText()), 'game continues');
  check(true, 'game continues on the new host');

  // ---- the new host's page, opened without the #room hash, offers to resume the hosted game
  await guest.goto(`${BASE}?memnet=1&as=guest`);
  await guest.waitForSelector('[data-act="resume-host"]');
  check((await guest.locator('[data-act="resume-host"]').innerText()).includes(shown), 'setup offers "Resume hosted game (room CODE)"');
  await guest.click('[data-act="resume-host"]');
  await guest.waitForSelector('.panel');
  check((await guest.locator('.room-bar').innerText()).includes(shown), 'resuming brings the hosted room back');

  // ---- game over, then a reload of #room=CODE keeps hosting the finished room (not "Connecting…" as a guest of itself)
  await guest.click('[data-act="finish"]');
  await guest.click('[data-act="confirm-yes"]');
  await guest.waitForSelector('[data-act="new"]');
  check(/wins with/.test(await guest.locator('.winner').innerText()), 'ending the game online shows the winner');
  await guest.reload();
  await until(async () => (await has(guest, '[data-act="new"]')) || (await has(guest, '.room-code')), 'page back after reload');
  check(await has(guest, '[data-act="new"]'), 'host reload after game over still shows the final board');

  // ---- leave goes back to setup
  await guest.click('[data-act="quit"]');
  check(/pauses for everyone/.test(await guest.locator('.confirm').innerText()), "host's leave confirm says the game pauses for everyone");
  await guest.click('[data-act="confirm-yes"]');
  await guest.waitForSelector('.online-card');
  check(!/room=/.test(guest.url()), 'leaving clears the room from the URL');
} catch (e) {
  console.log('ERROR', e.message);
  failures++;
}
check(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`);
await browser.close();
server.kill();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
