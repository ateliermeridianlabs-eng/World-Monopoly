import { describe, expect, it } from 'vitest';
import layout from '../data/layout.json';
import { BOARD, SECTIONS } from '../src/engine/data';
import { createGame } from '../src/engine/game';
import { validGameState } from '../src/net/protocol';

const squares = layout.squares;
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe('world-map board layout', () => {
  it('places every square once, in order', () => {
    expect(squares.map((s) => s.index)).toEqual(BOARD.map((s) => s.index));
  });

  it('keeps every 1 x 1 tile inside the map', () => {
    for (const s of squares) {
      expect(s.x - 0.5).toBeGreaterThanOrEqual(0);
      expect(s.y - 0.5).toBeGreaterThanOrEqual(0);
      expect(s.x + 0.5).toBeLessThanOrEqual(layout.width);
      expect(s.y + 0.5).toBeLessThanOrEqual(layout.height);
    }
  });

  it('never overlaps two tiles (centres at least 1.04 cells apart in x or in y)', () => {
    for (let i = 0; i < squares.length; i++)
      for (let j = i + 1; j < squares.length; j++)
        expect(cheb(squares[i], squares[j]), `squares ${i} and ${j}`).toBeGreaterThanOrEqual(1.04);
  });

  it('chains consecutive squares closely, including the step from the last square back to New Year', () => {
    squares.forEach((a, i) => {
      const b = squares[(i + 1) % squares.length];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      expect(d, `squares ${i} -> ${b.index}`).toBeGreaterThanOrEqual(1.04);
      expect(d, `squares ${i} -> ${b.index}`).toBeLessThanOrEqual(1.6);
    });
  });

  it('keeps the title box clear of tiles', () => {
    const t = layout.title;
    for (const s of squares) {
      const clear = s.x + 0.5 <= t.x || s.x - 0.5 >= t.x + t.w || s.y + 0.5 <= t.y || s.y - 0.5 >= t.y + t.h;
      expect(clear, `square ${s.index}`).toBe(true);
    }
  });

  it('keeps each section together, over its part of the world', () => {
    const box = new Map(SECTIONS.map((sec) => {
      const pts = BOARD.filter((q) => q.section === sec.id).map((q) => squares[q.index]);
      expect(pts).toHaveLength(14);
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      // A section is a compact patch, not strung across the map.
      expect(b.x1 - b.x0, sec.id).toBeLessThan(16);
      expect(b.y1 - b.y0, sec.id).toBeLessThan(11);
      return [sec.id, { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 }];
    }));
    const c = (id: string) => box.get(id)!;
    // Americas on the left, Europe and Africa in the middle, Asia and Australia on the right.
    for (const west of ['usa', 'south-america']) for (const east of ['uk', 'germany', 'africa']) expect(c(west).cx).toBeLessThan(c(east).cx);
    for (const west of ['uk', 'germany', 'africa']) for (const east of ['china', 'japan', 'australia']) expect(c(west).cx).toBeLessThan(c(east).cx);
    expect(c('uk').cx).toBeLessThan(c('germany').cx);
    expect(c('china').cx).toBeLessThan(c('japan').cx);
    // Northern sections above the southern ones.
    for (const north of ['usa', 'uk', 'germany', 'russia', 'china']) for (const south of ['south-america', 'africa', 'australia']) expect(c(north).cy).toBeLessThan(c(south).cy);
  });
});

describe('saved games from before the world-map board', () => {
  it('are rejected: square indices changed meaning when the sections were reordered', () => {
    const s = createGame([{ name: 'A', roleId: 'entrepreneur', isBot: false }, { name: 'B', roleId: 'banker', isBot: true }], 1);
    expect(s.version).toBe(2);
    expect(validGameState(s, 2)).toBe(true);
    expect(validGameState({ ...s, version: 1 }, 2)).toBe(false);
  });
});
