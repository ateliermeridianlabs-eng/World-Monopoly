// Runs bot-only games to check economy pacing. Usage: npm run simulate -- [games] [players] [turnCap]
import { ROLES } from '../src/engine/data';
import { botStep } from '../src/engine/bot';
import { shuffle } from '../src/engine/rng';
import { activePlayers, createGame, endGameByNetWorth, money } from '../src/engine/game';

const games = Number(process.argv[2] ?? 200);
const playerCount = Number(process.argv[3] ?? 4);
const turnCap = Number(process.argv[4] ?? 300);

const lengths: number[] = [];
const firstBankrupt: number[] = [];
let capped = 0;
const wins = new Map<string, number>();
const dealt = new Map<string, number>();
const cashAt = new Map<number, number[]>();
const CHECK_TURNS = [10, 25, 50, 100];

for (let g = 0; g < games; g++) {
  const roles = shuffle({ rng: g * 7919 }, ROLES.map((r) => r.id)).slice(0, playerCount);
  const s = createGame(roles.map((roleId, i) => ({ name: `Bot ${i + 1}`, isBot: true, roleId })), 1000 + g, 0);
  for (const r of roles) dealt.set(r, (dealt.get(r) ?? 0) + 1);
  let firstOut: number | null = null;
  let lastTurn = 0;
  while (s.phase !== 'gameOver') {
    if (s.turn > turnCap) {
      capped++;
      endGameByNetWorth(s);
      break;
    }
    if (s.turn !== lastTurn) {
      lastTurn = s.turn;
      if (CHECK_TURNS.includes(s.turn)) {
        const live = activePlayers(s);
        const avg = live.reduce((a, p) => a + p.cash, 0) / live.length;
        cashAt.set(s.turn, [...(cashAt.get(s.turn) ?? []), avg]);
      }
    }
    botStep(s);
    if (firstOut === null && s.players.some((p) => p.bankrupt)) firstOut = s.turn;
  }
  lengths.push(s.turn);
  if (firstOut !== null) firstBankrupt.push(firstOut);
  const w = s.players[s.winner!];
  wins.set(w.roleId, (wins.get(w.roleId) ?? 0) + 1);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`${games} games, ${playerCount} bots, turn cap ${turnCap}`);
console.log(`Game length (rounds): avg ${avg(lengths).toFixed(0)}, median ${median(lengths)}`);
console.log(`Hit turn cap: ${capped} (${((capped / games) * 100).toFixed(0)}%)`);
console.log(`First bankruptcy round: avg ${avg(firstBankrupt).toFixed(0)} (${firstBankrupt.length} games had one)`);
for (const t of CHECK_TURNS) if (cashAt.has(t)) console.log(`Avg cash at round ${t}: ${money(avg(cashAt.get(t)!))}`);
console.log(`Win rate by role (fair share is ${((1 / playerCount) * 100).toFixed(0)}%):`);
for (const [role, n] of [...dealt].map(([r, d]) => [r, (wins.get(r) ?? 0) / d] as const).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role}: ${(n * 100).toFixed(0)}% of ${dealt.get(role)} games`);
}
