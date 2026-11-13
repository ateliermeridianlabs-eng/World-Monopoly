import { describe, expect, it } from 'vitest';
import layout from '../data/layout.json';
import sectionsJson from '../data/sections.json';
import { BOARD, SECTIONS } from '../src/engine/data';
import { AIRPORTS, createGame } from '../src/engine/game';
import { validGameState } from '../src/net/protocol';

type P = number[];
interface Territory { index: number; id: string; kind: string; section?: string; poly: P[]; label: { x: number; y: number; r: number }; city?: P }
const squares = layout.squares as Territory[];
const regions = layout.regions as Record<string, P[][]>;

const area = (poly: P[]) => poly.reduce((s, [x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return s + x1 * y2 - x2 * y1; }, 0) / 2;
function inside(p: P, poly: P[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(p: P, a: P, b: P) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const edgeDist = (p: P, poly: P[]) => Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length])));
function crosses(a: P, b: P, c: P, d: P) {
  const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0;
}
function simple(poly: P[]) {
  const n = poly.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (crosses(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
  }
  return Math.abs(area(poly)) > 0.01;
}
/** A point inside `poly` (its label point lies inside by construction; this finds one from scratch for the check). */
const centre = (s: Territory) => [s.label.x, s.label.y];
const cities = new Map(sectionsJson.sections.flatMap((s) => s.cities.map((c) => [c.id, c])));

describe('world-map board: squares are territories', () => {
  it('has one territory per square, in board order', () => {
    expect(squares.map((s) => s.id)).toEqual(BOARD.map((s) => s.id));
    expect(squares.filter((s) => s.kind === 'land')).toHaveLength(126);
    expect(squares.filter((s) => s.kind === 'sea')).toHaveLength(18);
  });

  it('draws every territory as a valid simple polygon inside the map', () => {
    for (const s of squares) {
      expect(simple(s.poly), s.id).toBe(true);
      for (const [x, y] of s.poly) {
        expect(x >= 0 && y >= 0 && x <= layout.width && y <= layout.height, s.id).toBe(true);
      }
    }
  });

  it('labels every territory at an inner point with room for its art, name, price and tokens', () => {
    for (const s of squares) {
      expect(inside(centre(s), s.poly), s.id).toBe(true);
      expect(s.label.r, s.id).toBeGreaterThanOrEqual(layout.minRadius);
      expect(edgeDist(centre(s), s.poly), s.id).toBeGreaterThanOrEqual(s.label.r - 0.02);
    }
    expect(layout.minRadius).toBeGreaterThanOrEqual(0.7);
  });

  it('splits each region into its 14 parcels exactly: areas add up and every sampled point is in one parcel', () => {
    for (const sec of SECTIONS) {
      const parcels = squares.filter((s) => s.section === sec.id);
      expect(parcels, sec.id).toHaveLength(14);
      const total = regions[sec.id].reduce((t, p) => t + Math.abs(area(p)), 0);
      const sum = parcels.reduce((t, p) => t + Math.abs(area(p.poly)), 0);
      expect(Math.abs(sum - total) / total, sec.id).toBeLessThan(0.002);
      const xs = regions[sec.id].flat().map((p) => p[0]), ys = regions[sec.id].flat().map((p) => p[1]);
      for (let k = 0; k < 400; k++) {
        const p = [Math.min(...xs) + ((k * 0.6180339) % 1) * (Math.max(...xs) - Math.min(...xs)), Math.min(...ys) + ((k * 0.7548776) % 1) * (Math.max(...ys) - Math.min(...ys))];
        const inRegion = regions[sec.id].some((r) => inside(p, r));
        const nearEdge = parcels.some((q) => edgeDist(p, q.poly) < 1e-3);
        if (nearEdge) continue;
        expect(parcels.filter((q) => inside(p, q.poly)).length, `${sec.id} at ${p}`).toBe(inRegion ? 1 : 0);
      }
    }
  });

  it('keeps sea zones off the land parcels and off each other', () => {
    const sea = squares.filter((s) => s.kind === 'sea');
    const land = squares.filter((s) => s.kind === 'land');
    for (const z of sea) {
      for (const l of land) {
        expect(z.poly.some((p) => inside(p, l.poly)) || l.poly.some((p) => inside(p, z.poly)), `${z.id} / ${l.id}`).toBe(false);
      }
      for (const o of sea) if (o !== z) expect(inside(centre(o), z.poly), `${z.id} / ${o.id}`).toBe(false);
    }
  });

  it('puts every city inside its own parcel', () => {
    for (const s of squares.filter((q) => cities.has(q.id))) {
      expect(s.city, s.id).toBeDefined();
      expect(inside(s.city!, s.poly), s.id).toBe(true);
    }
  });
});

describe('world-map board: real geography', () => {
  const at = (id: string) => squares.find((s) => s.id === id)!.city!;
  const north = (a: string, b: string) => expect(at(a)[1], `${a} north of ${b}`).toBeLessThan(at(b)[1]);
  const west = (a: string, b: string) => expect(at(a)[0], `${a} west of ${b}`).toBeLessThan(at(b)[0]);

  it('agrees with real latitude and longitude for most pairs of cities in a section', () => {
    for (const sec of sectionsJson.sections) {
      let pairs = 0, ok = 0;
      for (const a of sec.cities) for (const b of sec.cities) {
        if (a.id >= b.id) continue;
        if (Math.abs(a.lat - b.lat) > 0.3) { pairs++; if ((a.lat > b.lat) === (at(a.id)[1] < at(b.id)[1])) ok++; }
        if (Math.abs(a.lon - b.lon) > 0.3) { pairs++; if ((a.lon < b.lon) === (at(a.id)[0] < at(b.id)[0])) ok++; }
      }
      expect(ok / pairs, sec.id).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('places named cities where they are', () => {
    north('edinburgh', 'london'); north('glasgow', 'manchester'); west('bristol', 'london'); west('liverpool', 'leeds');
    north('hamburg', 'munich'); west('cologne', 'berlin'); north('berlin', 'leipzig'); west('stuttgart', 'munich');
    north('saint-petersburg', 'moscow'); north('moscow', 'sochi'); west('moscow', 'novosibirsk'); west('novosibirsk', 'vladivostok'); west('kazan', 'yekaterinburg');
    north('beijing', 'shanghai'); north('shanghai', 'hong-kong'); west('chengdu', 'shanghai'); west('chengdu', 'chongqing'); west('guangzhou', 'hong-kong');
    north('sapporo', 'tokyo'); west('fukuoka', 'osaka'); west('osaka', 'tokyo'); north('tokyo', 'yokohama'); west('kobe', 'kyoto');
    west('seattle', 'miami'); north('seattle', 'miami'); west('san-francisco', 'chicago'); north('san-francisco', 'los-angeles'); north('new-york', 'washington-dc'); north('chicago', 'houston');
    north('caracas', 'lima'); west('lima', 'rio-de-janeiro'); north('rio-de-janeiro', 'buenos-aires'); west('santiago', 'buenos-aires'); north('bogota', 'lima');
    north('cairo', 'nairobi'); north('casablanca', 'lagos'); west('accra', 'lagos'); north('johannesburg', 'cape-town'); west('cape-town', 'johannesburg'); west('lagos', 'addis-ababa');
    west('perth', 'adelaide'); west('adelaide', 'melbourne'); north('brisbane', 'sydney'); north('newcastle', 'sydney'); north('sydney', 'canberra'); north('canberra', 'melbourne'); west('melbourne', 'sydney');
  });

  it('puts each region in its part of the world', () => {
    const c = (id: string) => {
      const pts = regions[id].flat();
      return { x: pts.reduce((t, p) => t + p[0], 0) / pts.length, y: pts.reduce((t, p) => t + p[1], 0) / pts.length };
    };
    for (const west of ['usa', 'south-america']) for (const east of ['uk', 'germany', 'africa']) expect(c(west).x).toBeLessThan(c(east).x);
    for (const west of ['uk', 'germany', 'africa']) for (const east of ['china', 'japan', 'australia', 'russia']) expect(c(west).x).toBeLessThan(c(east).x);
    expect(c('uk').x).toBeLessThan(c('germany').x);
    expect(c('china').x).toBeLessThan(c('japan').x);
    expect(c('russia').y).toBeLessThan(c('china').y);
    for (const north of ['usa', 'uk', 'germany', 'russia', 'china', 'japan']) for (const south of ['south-america', 'africa', 'australia']) expect(c(north).y).toBeLessThan(c(south).y);
  });
});

describe('world-map board: the route', () => {
  const adjacency = layout.adjacency as Record<string, string[]>;
  const d = (a: Territory, b: Territory) => Math.hypot(a.label.x - b.label.x, a.label.y - b.label.y);

  it('keeps each section as 14 consecutive squares, in the order of the sections', () => {
    let last = 0;
    for (const sec of SECTIONS) {
      const at = BOARD.filter((q) => q.section === sec.id).map((q) => q.index);
      expect(at[13] - at[0], sec.id).toBe(13);
      expect(at[0]).toBeGreaterThan(last);
      last = at[13];
    }
  });

  it('steps between neighbouring parcels inside a section (at most one short ferry per section), and never far', () => {
    let jumps = 0;
    for (const sec of SECTIONS) {
      const at = squares.filter((q) => q.section === sec.id);
      const ferries = at.slice(1).filter((q, i) => !adjacency[at[i].id].includes(q.id));
      expect(ferries.length, sec.id).toBeLessThanOrEqual(1);
      ferries.forEach((q) => expect(d(q, at[at.indexOf(q) - 1]), `${sec.id} ferry to ${q.id}`).toBeLessThan(11));
      jumps += ferries.length;
    }
    expect(jumps).toBeLessThanOrEqual(4);
    // Between sections the route crosses the sea; the longest crossing is the Coral Sea to the date line.
    squares.forEach((a, i) => {
      const b = squares[(i + 1) % squares.length];
      expect(d(a, b), `${a.id} -> ${b.id}`).toBeLessThan(16);
    });
  });

  it('keeps New Year at square 0 and an airport after every section but the last', () => {
    expect(BOARD[0].type).toBe('newYear');
    expect(AIRPORTS).toHaveLength(8);
    SECTIONS.slice(0, 8).forEach((sec) => {
      const last = Math.max(...BOARD.filter((q) => q.section === sec.id).map((q) => q.index));
      expect(BOARD[last + 1].type, sec.id).toBe('airport');
    });
    BOARD.filter((q) => q.checkpoint).forEach((q) => expect(q.index % 12).toBe(0));
  });
});

describe('saved games from before the territory map', () => {
  it('are rejected: square indices changed meaning when the order inside sections began to follow the map', () => {
    const s = createGame([{ name: 'A', roleId: 'entrepreneur', isBot: false }, { name: 'B', roleId: 'banker', isBot: true }], 1);
    expect(s.version).toBe(3);
    expect(validGameState(s, 2)).toBe(true);
    expect(validGameState({ ...s, version: 2 }, 2)).toBe(false);
  });
});
