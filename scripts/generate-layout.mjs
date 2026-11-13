// Builds data/layout.json: where each of the 144 squares sits on the world-map board, plus the backdrop shapes.
// Run: npm run layout (npm run board runs it too).
//
// Units are board cells: a tile is a 1 x 1 square, upright, centred on (x, y); (0, 0) is the map's top-left.
// The route is one closed centripetal Catmull-Rom spline through the hand-placed waypoints below. Each group
// of waypoints is pinned to a square index (`at` for its first waypoint, `to` for its last); squares between
// two pinned waypoints are spaced evenly along the curve, by Chebyshev (max |dx|, |dy|) distance, so upright
// tiles on a diagonal stay as far apart as on a straight run. Fails (exit code 1) if any rule below breaks.
// The map is stylized, not to scale: Europe is enlarged and every region gets room for its 14 tiles.
import { readFileSync, writeFileSync } from 'node:fs';

const board = JSON.parse(readFileSync('data/board.json', 'utf8'));
const N = board.squares.length;

const WIDTH = 42;
const HEIGHT = 25;

// Section start index s = 1 + 16 * k (14 section squares, then 2 gap squares; the last gap is 1 square).
const ROUTE = [
  { at: 0, pts: [[39.3, 15.7]] }, // New Year, in the Pacific by the date line
  // Japan: up the islands, then back down their west side.
  { at: 1, to: 14, pts: [[40.4, 14.6], [40.8, 12.6], [41.0, 10.2], [40.8, 7.8], [40.2, 5.6], [39.0, 4.4], [37.8, 5.2], [37.8, 7.2], [38.4, 9.0], [37.9, 10.2]] },
  // China: west along the south, back east further north.
  { at: 17, to: 30, pts: [[34.6, 12.0], [32.6, 12.4], [30.2, 12.2], [28.4, 11.0], [28.6, 9.4], [30.4, 8.6], [32.6, 8.8], [34.4, 8.2], [35.0, 6.6]] },
  // Russia: a long wavy run west across Siberia to Moscow.
  { at: 33, to: 46, pts: [[35.6, 3.4], [34.2, 1.4], [32.0, 1.4], [30.0, 2.6], [28.0, 3.6], [26.0, 3.0], [24.2, 1.8], [22.0, 2.8]] },
  // Germany: a three-lane serpentine.
  { at: 49, to: 62, pts: [[22.6, 6.0], [23.4, 8.4], [22.8, 10.2], [21.4, 10.4], [20.8, 8.8], [20.6, 6.8], [19.6, 5.4], [18.2, 5.8], [17.8, 7.8], [18.4, 9.6]] },
  // UK: up Britain, round Scotland, down Ireland's side.
  { at: 65, to: 78, pts: [[15.2, 9.8], [15.0, 7.8], [15.2, 5.6], [14.4, 3.8], [13.0, 3.0], [11.8, 4.2], [12.4, 6.2], [12.0, 8.0], [11.0, 9.2]] },
  // USA: west along the north, back east along the south.
  { at: 81, to: 94, pts: [[7.9, 6.0], [6.4, 4.4], [4.2, 4.6], [2.4, 5.8], [2.6, 7.8], [4.4, 8.6], [6.4, 8.4], [8.0, 9.4], [8.6, 11.0]] },
  // South America: down the Andes, round Cape Horn, up the Atlantic coast.
  { at: 97, to: 110, pts: [[10.4, 14.4], [8.8, 15.6], [8.0, 17.6], [8.2, 19.6], [9.0, 21.6], [10.2, 20.6], [11.0, 18.6], [12.2, 17.2], [13.6, 16.4]] },
  // Africa: along the north, down the east, to the Cape.
  { at: 113, to: 126, pts: [[17.0, 14.4], [17.8, 12.8], [19.8, 12.4], [22.0, 12.4], [24.0, 13.0], [24.6, 14.8], [23.4, 16.4], [22.6, 18.4], [22.0, 20.8]] },
  // Australia: along the south coast, up the east coast.
  { at: 129, to: 142, pts: [[25.4, 20.6], [27.0, 21.4], [28.6, 21.6], [30.2, 21.0], [31.8, 21.6], [33.6, 21.2], [34.8, 19.8], [35.6, 17.8], [37.0, 16.6]] },
];

// Open-ocean box for the title and legend (must cover no tile).
const TITLE = { x: 11.4, y: 21.9, w: 13.4, h: 2.8 };

// Simplified continents, hand-drawn in the same cell units; the client draws each as a smooth closed curve.
const CONTINENTS = {
  northAmerica: [[0.6, 2.2], [2.5, 1.2], [5, 1.4], [7.5, 0.9], [9.5, 1.6], [10.2, 2.8], [9.6, 3.6], [10.3, 4.6], [9.8, 5.8], [9.6, 7.2], [9.2, 8.6], [9.6, 9.8], [10.6, 11.6], [11.2, 13.0], [10.6, 13.6], [9.6, 12.8], [8.2, 11.6], [7, 10.6], [5.4, 9.8], [3.4, 9.6], [1.8, 8.8], [1.2, 7.2], [1.4, 5.4], [0.8, 4.2], [0.2, 3.2]],
  greenland: [[9.2, 0.6], [11.6, 0.4], [12.4, 1.2], [11.4, 2.6], [10.2, 2.8], [9.4, 1.8]],
  southAmerica: [[9.4, 13.4], [11.2, 13.2], [12.8, 13.8], [14.0, 14.6], [14.9, 15.8], [14.6, 17.0], [13.2, 18.2], [12.0, 19.4], [10.8, 21.0], [9.6, 22.8], [8.6, 22.8], [7.8, 21.2], [7.4, 19.0], [7.2, 17.0], [7.6, 15.4], [8.4, 14.2]],
  britain: [[14.2, 2.4], [15.6, 3.0], [16.2, 4.6], [16.4, 6.6], [16.4, 8.6], [15.8, 10.4], [14.6, 10.6], [14.4, 8.8], [14.6, 6.6], [14.2, 4.6], [13.6, 3.2]],
  ireland: [[12.2, 3.6], [13.6, 4.4], [13.4, 6.2], [13.0, 8.0], [11.8, 9.6], [10.8, 8.8], [11.4, 7.2], [11.4, 5.0]],
  eurasia: [[16.6, 11.0], [16.4, 9.4], [17.0, 8.4], [16.8, 7.2], [17.6, 6.0], [18.6, 5.0], [18.4, 3.6], [18.0, 2.2], [19.2, 0.8], [21.6, 0.6], [24, 0.9], [27, 0.5], [30, 0.4], [33, 0.5], [36, 0.4], [38.6, 0.8], [39.4, 2.0], [38.2, 2.8], [37.2, 3.6], [36.8, 5.4], [37.0, 7.4], [36.6, 8.4], [36.0, 8.0], [35.8, 9.4], [36.2, 10.8], [35.8, 12.4], [34.0, 13.4], [32.6, 13.6], [32.8, 14.8], [31.8, 15.6], [31.0, 16.4], [30.6, 15.0], [29.6, 13.8], [28.4, 13.4], [27.4, 15.0], [27.2, 15.2], [26.2, 13.6], [25.4, 12.0], [24.6, 11.6], [23.4, 11.2], [22.4, 11.0], [21.0, 11.2], [20.0, 11.2], [18.6, 11.0], [17.6, 11.6]],
  japan: [[39.4, 4.2], [40.8, 4.6], [41.6, 6.6], [41.6, 9.4], [41.4, 12.2], [40.6, 13.4], [39.8, 12.0], [39.0, 10.6], [37.4, 10.8], [37.2, 9.2], [37.4, 6.6], [38.0, 4.8]],
  africa: [[16.4, 13.0], [17.6, 12.0], [20, 11.9], [22.6, 11.9], [23.6, 12.4], [24.4, 13.6], [25.6, 14.2], [25.0, 15.6], [24.4, 17.0], [23.8, 18.6], [23.0, 20.4], [22.2, 21.6], [21.2, 21.4], [20.4, 19.6], [19.8, 17.6], [19.2, 16.4], [17.8, 16.0], [16.4, 15.6], [15.6, 14.4]],
  madagascar: [[25.2, 18.0], [25.8, 18.6], [25.4, 19.6], [24.8, 19.0]],
  australia: [[25.0, 19.6], [26.4, 17.6], [28.4, 17.0], [30.0, 16.2], [31.4, 16.8], [32.4, 15.8], [33.4, 16.0], [34.4, 17.4], [35.8, 17.2], [36.8, 18.6], [36.4, 20.6], [35.0, 22.4], [32.6, 23.0], [30.4, 22.6], [28.6, 23.0], [26.4, 22.8], [25.0, 21.6]],
  newZealand: [[38.8, 19.6], [39.6, 20.6], [39.0, 22.2], [38.2, 21.4]],
};

// ---------- spline ----------

function catmull(p0, p1, p2, p3, t) {
  // Centripetal Catmull-Rom (alpha 0.5): no cusps or self-intersections inside a segment.
  const d = (a, b) => Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** 0.5, 1e-6);
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => ({ x: ((tb - u) * a.x + (u - ta) * b.x) / (tb - ta), y: ((tb - u) * a.y + (u - ta) * b.y) / (tb - ta) });
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Places the squares along the closed spline through `route`. Between two pinned waypoints the squares are
 * equal Chebyshev chords apart (max |dx|, |dy|), the step found by binary search so the walk lands on the next
 * pin. Equal chords, not equal arc length, keep upright tiles on a diagonal or a bend as far apart as on a
 * straight run. Returns the squares and the step used for each span (keyed by the span's first index).
 */
function place(route) {
  const waypoints = [];
  for (const g of route) {
    g.pts.forEach(([x, y], i) => {
      const w = { x, y };
      if (i === 0) w.pin = g.at;
      if (g.to !== undefined && i === g.pts.length - 1) w.pin = g.to;
      waypoints.push(w);
    });
  }
  const W = waypoints.length;
  const STEPS = 300;
  const dense = [];
  const pinAt = new Map(); // square index -> index into dense
  for (let k = 0; k < W; k++) {
    const p = (i) => waypoints[(i + W) % W];
    if (waypoints[k].pin !== undefined) pinAt.set(waypoints[k].pin, dense.length);
    for (let j = 0; j < STEPS; j++) dense.push(catmull(p(k - 1), p(k), p(k + 1), p(k + 2), j / STEPS));
  }
  dense.push(dense[0]); // close the loop back into New Year
  pinAt.set(N, dense.length - 1);

  const pins = [...pinAt.keys()].sort((a, b) => a - b);
  if (pins[0] !== 0) throw new Error('square 0 must be pinned');
  const squares = [];
  const steps = new Map();
  for (let k = 0; k < pins.length - 1; k++) {
    const a = pins[k], b = pins[k + 1];
    const start = pinAt.get(a), end = pinAt.get(b);
    const walk = (step) => {
      const at = [start];
      for (let i = a + 1; i < b; i++) {
        let j = at[at.length - 1];
        const from = dense[j];
        while (j < end && cheb(dense[j], from) < step) j++;
        at.push(j);
      }
      return at;
    };
    let lo = 0.2, hi = 5;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      const at = walk(mid);
      const j = at[at.length - 1];
      if (j >= end || cheb(dense[end], dense[j]) < mid) hi = mid; else lo = mid;
    }
    steps.set(a, lo);
    walk(lo).forEach((j, n) => squares.push({ index: a + n, x: Math.round(dense[j].x * 1000) / 1000, y: Math.round(dense[j].y * 1000) / 1000 }));
  }
  if (squares.length !== N) throw new Error(`placed ${squares.length} of ${N} squares`);
  return { squares, steps };
}

// Each section's waypoints are only a sketch: its inner waypoints are scaled about their centre (the two pinned
// ends stay put) until the section's 14 tiles sit STEP apart, so editing a shape never needs hand-measuring.
const STEP = 1.1;
let route = ROUTE.map((g) => ({ ...g, pts: g.pts.map((p) => [...p]) }));
for (let it = 0; it < 12; it++) {
  const { steps } = place(route);
  route = route.map((g) => {
    if (g.to === undefined) return g;
    const f = (STEP / steps.get(g.at)) ** 0.8;
    const cx = g.pts.reduce((t, p) => t + p[0], 0) / g.pts.length, cy = g.pts.reduce((t, p) => t + p[1], 0) / g.pts.length;
    const last = g.pts.length - 1;
    return { ...g, pts: g.pts.map(([x, y], i) => (i === 0 || i === last ? [x, y] : [cx + (x - cx) * f, cy + (y - cy) * f])) };
  });
}
const { squares, steps } = place(route);
console.log('chord step per span:', [...steps].map(([a, st]) => `${a}: ${st.toFixed(2)}`).join(', '));

// ---------- checks (also asserted in tests/layout.test.ts) ----------

const problems = [];
const gap = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
for (let i = 0; i < N; i++) {
  const a = squares[i];
  if (a.x < 0.5 || a.y < 0.5 || a.x > WIDTH - 0.5 || a.y > HEIGHT - 0.5) problems.push(`square ${i} outside the map`);
  for (let j = i + 1; j < N; j++) if (gap(a, squares[j]) < 1.04) problems.push(`squares ${i} and ${j} overlap (${gap(a, squares[j]).toFixed(2)})`);
  const b = squares[(i + 1) % N];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (d > 1.6) problems.push(`squares ${i} -> ${(i + 1) % N} too far apart (${d.toFixed(2)})`);
  const t = TITLE;
  if (a.x + 0.5 > t.x && a.x - 0.5 < t.x + t.w && a.y + 0.5 > t.y && a.y - 0.5 < t.y + t.h) problems.push(`square ${i} under the title`);
}
const json = (v) => JSON.stringify(v);
writeFileSync('data/layout.json', `{
  "_note": "Generated by scripts/generate-layout.mjs. Do not edit by hand. Units are board cells: each square is an upright 1 x 1 tile centred on (x, y), origin top-left. continents are closed outlines, drawn as smooth curves.",
  "width": ${WIDTH},
  "height": ${HEIGHT},
  "title": ${json(TITLE)},
  "squares": [
${squares.map((q) => `    ${json(q)}`).join(',\n')}
  ],
  "continents": {
${Object.entries(CONTINENTS).map(([k, v]) => `    ${json(k)}: ${json(v)}`).join(',\n')}
  }
}
`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
console.log(`layout.json: ${WIDTH} x ${HEIGHT} cells, ${problems.length} problems`);
