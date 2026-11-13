// Builds data/layout.json: the world-map board. Every square is a territory on the map: 126 land parcels that
// split the 9 playable regions, and 18 sea zones (airports, highways, tax offices and New Year) on the crossings
// between them. Also decides the order of the 14 squares inside each section, which scripts/generate-board.mjs
// copies into data/board.json. Run: npm run board (runs this, then generate-board). Deterministic.
//
// Units are map cells, origin top-left, y down. Steps:
//  1. Project each region's outline and its cities (real lat/lon from data/sections.json) with the region's own
//     cartogram projection (scripts/world.mjs).
//  2. Split each region into 14 parcels: a Voronoi diagram of 14 seeds clipped to the outline. 8 seeds are the
//     cities; the other 6 (utilities, World Event, Disaster) start at hand-picked spots. A few rounds of
//     constrained Lloyd relaxation even out the sizes: the 6 free seeds move to their parcel's centroid, a city
//     seed moves at most CITY_SLACK cells from its city and never so far that the city leaves its parcel.
//  3. Grow each sea crossing as an organic blob of open water, cut back where it would touch land, and split it
//     into its two squares.
//  4. Order each section's 14 parcels: start at the parcel nearest the crossing before it, end at the parcel
//     nearest the crossing after it, and visit every parcel once, stepping between neighbours (shared border, or
//     a short strait between islands) wherever possible, shortest walk first (exact search over all orders).
// Fails (exit code 1) if a rule checked in tests/layout.test.ts breaks.
import { readFileSync, writeFileSync } from 'node:fs';
import { area, centroid, clipHalf, dist, edgeDist, inside, isSimple, pole, polyDist, rayHit, rng, splitHalf, tidy, unionTouching } from './geo.mjs';
import { AMUR, BACKDROP, CROSSINGS, DATE_LINE, HEIGHT, OCEANS, PROJ, REGIONS, TITLE, WIDTH } from './world.mjs';

const sections = JSON.parse(readFileSync('data/sections.json', 'utf8')).sections;
const rules = JSON.parse(readFileSync('data/rules.json', 'utf8'));

/** Smallest inscribed-circle radius (cells) of any square: room for its art, name, price and tokens. */
export const MIN_RADIUS = 0.72;
const CITY_SLACK = 1.4;
const SPECIALS = [...rules.utilities.kinds.map((k) => k.id), 'event', 'disaster'];
// Squares on each crossing (after section k). The last crossing runs back into New Year.
const GAPS = [
  ['airport', 'highway'], ['airport', 'tax'], ['airport', 'highway'], ['airport', 'tax'],
  ['airport', 'highway'], ['airport', 'tax'], ['airport', 'highway'], ['airport', 'tax'],
  ['highway', 'newYear'],
];
const problems = [];

// ---------- projection ----------

function knots(k, v) {
  let i = 0;
  while (i < k.length - 2 && (k[0][0] < k[1][0] ? v > k[i + 1][0] : v < k[i + 1][0])) i++;
  const [a, b] = [k[i], k[i + 1]];
  return a[1] + ((v - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
}

function makeProj(def) {
  const base = ([lon, lat]) => {
    let y = knots(def.lat, lat);
    for (const alt of def.latAlt ?? []) {
      const w = Math.max(0, Math.min(1, (lon - alt.from) / (alt.to - alt.from)));
      y = y * (1 - w) + knots(alt.lat, lat) * w;
    }
    return [knots(def.lon, lon), y];
  };
  const lenses = [];
  const lens = (p) => {
    for (const { c, r, d } of lenses) {
      const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy);
      if (l === 0 || l >= r) continue;
      const t = l / r, f = (r * ((d + 1) * t) / (d * t + 1)) / l;
      p = [c[0] + dx * f, c[1] + dy * f];
    }
    return p;
  };
  for (const L of def.lenses ?? []) lenses.push({ c: lens(base(L.at)), r: L.r, d: L.d });
  return (ll) => lens(base(ll));
}
const proj = Object.fromEntries(Object.entries(PROJ).map(([k, v]) => [k, makeProj(v)]));
const projOf = (p) => (p === 'map' ? (q) => q : typeof p === 'string' ? proj[p] : makeProj(p));

/** Projects a closed [lon, lat] outline, adding points along long edges so lenses bend them smoothly. */
function projectOutline(runs) {
  const pts = [];
  for (const { pts: ll, p } of runs) for (const q of ll) pts.push({ ll: q, p });
  const out = [];
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const pa = a.p(a.ll), pb = (a.p === b.p ? a.p : b.p)(b.ll);
    const n = a.p === b.p ? Math.max(1, Math.ceil(dist(pa, pb) / 0.3)) : 1;
    for (let k = 0; k < n; k++) out.push(a.p([a.ll[0] + ((b.ll[0] - a.ll[0]) * k) / n, a.ll[1] + ((b.ll[1] - a.ll[1]) * k) / n]));
  });
  return simplify(out, 0.02);
}

/** Douglas-Peucker on a closed polygon. */
function simplify(poly, tol) {
  const keep = new Array(poly.length).fill(false);
  const rec = (i, j) => {
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = segDistOpen(poly[k], poly[i], poly[j % poly.length]);
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = true; rec(i, best); rec(best, j); }
  };
  const far = poly.reduce((b, p, k) => (dist(p, poly[0]) > dist(poly[b], poly[0]) ? k : b), 0);
  keep[0] = keep[far] = true;
  rec(0, far);
  rec(far, poly.length);
  return poly.filter((_, k) => keep[k]);
}
function segDistOpen(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const clockwise = (poly) => (area(poly) < 0 ? [...poly].reverse() : poly);
const round = (v) => Math.round(v * 100) / 100;
const roundPoly = (poly) => tidy(poly.map(([x, y]) => [round(x), round(y)]), 1e-9);

// ---------- regions and parcels ----------

/**
 * Power diagram (Voronoi with weights) of `seeds` clipped to `piece`: for each seed, the pieces of the outline
 * where |x - seed|^2 - weight is smallest. A larger weight pushes that cell's borders outward.
 */
function voronoiParts(piece, seeds, w = seeds.map(() => 0)) {
  return seeds.map((s, i) => {
    let parts = [piece];
    seeds.forEach((t, j) => {
      if (j === i) return;
      parts = parts.flatMap((poly) => splitHalf(poly, t[0] - s[0], t[1] - s[1], (t[0] ** 2 + t[1] ** 2 - s[0] ** 2 - s[1] ** 2 - w[j] + w[i]) / 2));
    });
    return parts;
  });
}
const mainPart = (parts, s) => parts.find((q) => inside(s, q)) ?? parts.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a), parts[0] ?? []);
const voronoi = (piece, seeds, w) => voronoiParts(piece, seeds, w).map((parts, i) => mainPart(parts, seeds[i]));

/**
 * Where a coast curves back, a Voronoi cell can fall apart into a main part (round its seed) and a stray piece
 * across a bay. Each stray piece is split among the other seeds and merged into the parcels it touches.
 */
function partition(piece, seeds, w) {
  const parts = voronoiParts(piece, seeds, w);
  const cells = parts.map((p, i) => mainPart(p, seeds[i]));
  let strays = parts.flatMap((p, i) => p.filter((q) => q !== cells[i]).map((q) => ({ poly: q, not: i })));
  for (let round = 0; round < 6 && strays.length; round++) {
    const left = [];
    for (const st of strays) {
      const others = seeds.map((s, k) => k).filter((k) => k !== st.not);
      const sub = voronoiParts(st.poly, others.map((k) => seeds[k]), others.map((k) => w[k]));
      sub.forEach((ps, m) => ps.forEach((q) => {
        const k = others[m];
        const u = unionTouching(clockwise(cells[k]), clockwise(q));
        if (u) cells[k] = u;
        else left.push({ poly: q, not: st.not });
      }));
    }
    strays = left;
  }
  if (strays.length) problems.push(`${strays.length} stray piece(s) could not be merged`);
  return cells;
}

/**
 * Pulls city seeds back toward their cities until every
 * city lies inside its own parcel, at least 0.12 cells from any border with another parcel. Returns false if it gave up.
 */
function keepCities(piece, mine, tries) {
  for (let t = 0; t < tries; t++) {
    const trial = mine.map((s) => s.next ?? s.at);
    const cells = voronoi(piece, trial, mine.map((s) => s.w));
    const bad = mine.filter((s, k) => s.city && !(inside(s.city, cells[k]) && (edgeDist(s.city, cells[k]) > 0.12 || edgeDist(s.city, piece) < 0.13)));
    if (!bad.length) return true;
    for (const s of bad) {
      s.next = [((s.next ?? s.at)[0] + s.city[0]) / 2, ((s.next ?? s.at)[1] + s.city[1]) / 2];
    }
  }
  return false;
}

const regionOutlines = {};
const parcels = new Map(); // square id -> { id, section, poly, city?: [x, y] }

for (const sec of sections) {
  const R = REGIONS[sec.id];
  const p = proj[sec.id];
  const pieces = R.pieces.map((piece) => {
    const runs = [];
    let cur = null;
    for (const v of piece) {
      if (typeof v === 'string') {
        runs.push({ pts: v === 'AMUR' ? AMUR : [...AMUR].reverse(), p: proj.russia });
        cur = null;
      } else {
        if (!cur) runs.push((cur = { pts: [], p }));
        cur.pts.push(v);
      }
    }
    return clockwise(projectOutline(runs));
  });
  regionOutlines[sec.id] = pieces.map(roundPoly);
  regionOutlines[sec.id].forEach((pc, i) => { if (!isSimple(pc)) problems.push(`${sec.id} outline ${i} crosses itself`); });

  const seeds = [
    ...sec.cities.map((c) => ({ id: c.id, city: p([c.lon, c.lat]) })),
    ...SPECIALS.map((k) => ({ id: `${k}-${sec.id}`, start: p(R.seeds[k]), pinned: (R.pinned ?? []).includes(k) })),
  ];
  if (seeds.length !== 14) throw new Error(`${sec.id}: ${seeds.length} seeds`);
  for (const s of seeds) {
    s.at = [...(s.city ?? s.start)];
    s.w = 0;
    s.piece = regionOutlines[sec.id].findIndex((pc) => inside(s.at, pc));
    if (s.piece < 0) problems.push(`${s.id}: start point outside ${sec.id}`), (s.piece = 0);
  }
  regionOutlines[sec.id].forEach((piece, pi) => {
    const mine = seeds.filter((s) => s.piece === pi);
    if (!mine.length) return problems.push(`${sec.id} piece ${pi} has no seed`);
    for (let it = 0; it < 80; it++) {
      const cells = voronoi(piece, mine.map((s) => s.at), mine.map((s) => s.w));
      mine.forEach((s, k) => {
        if (cells[k].length < 3) return;
        const c = centroid(cells[k]);
        if (!s.city) { if (!s.pinned) s.at = c; return; }
        const off = [c[0] - s.city[0], c[1] - s.city[1]];
        const l = Math.hypot(off[0], off[1]);
        const f = l > CITY_SLACK ? CITY_SLACK / l : 1;
        s.next = [s.city[0] + off[0] * f, s.city[1] + off[1] * f];
      });
      // A city seed may only move while its city stays inside its own parcel.
      keepCities(piece, mine, 12);
      mine.forEach((s) => { if (s.next) s.at = s.next; delete s.next; });
    }
    if (!keepCities(piece, mine, 60)) problems.push(`${sec.id}: a city fell outside its parcel`);
    mine.forEach((s) => { if (s.next) s.at = s.next; delete s.next; });
    const cells = partition(piece, mine.map((s) => s.at), mine.map((s) => s.w));
    mine.forEach((s, k) => parcels.set(s.id, { id: s.id, section: sec.id, piece: pi, poly: roundPoly(cells[k]), city: s.city && s.city.map(round) }));
  });
}

// ---------- backdrop ----------

const backdrop = BACKDROP.map((b) => ({
  name: b.name,
  poly: roundPoly(clockwise(projectOutline((b.runs ?? [{ pts: b.pts, proj: b.proj }]).map((r) => ({ pts: r.pts, p: projOf(r.proj) }))))),
}));

// ---------- sea crossings ----------

const titleBox = [[TITLE.x, TITLE.y], [TITLE.x + TITLE.w, TITLE.y], [TITLE.x + TITLE.w, TITLE.y + TITLE.h], [TITLE.x, TITLE.y + TITLE.h]];
const border = [[0.25, 0.25], [WIDTH - 0.25, 0.25], [WIDTH - 0.25, HEIGHT - 0.25], [0.25, HEIGHT - 0.25]];
const land = [...Object.values(regionOutlines).flat(), ...backdrop.map((b) => b.poly)];
const zones = []; // { poly } per crossing half, in board order
const RAYS = 90;
CROSSINGS.forEach((cr, k) => {
  const obstacles = [...land, titleBox, border, ...zones.map((z) => z.poly)];
  if (obstacles.slice(0, land.length).some((poly) => inside(cr.at, poly))) problems.push(`${cr.name}: centre on land`);
  const rand = rng(cr.seed * 7919);
  const waves = [1, 2, 3].map((f) => ({ f: f + 1, a: (0.16 / f) * (0.6 + rand()), ph: rand() * Math.PI * 2 }));
  const rot = (cr.rot * Math.PI) / 180;
  const r = [];
  for (let i = 0; i < RAYS; i++) {
    const th = (i / RAYS) * Math.PI * 2;
    const u = [Math.cos(th), Math.sin(th)];
    const lx = Math.cos(th - rot), ly = Math.sin(th - rot);
    const ell = 1 / Math.hypot(lx / cr.rx, ly / cr.ry);
    const wob = 1 + waves.reduce((t, w) => t + w.a * Math.sin(w.f * th + w.ph), 0);
    r.push(Math.min(ell * wob, rayHit(cr.at, u, obstacles) - 0.14));
  }
  // Erode then average: never larger than the clearance, and no spikes where a ray slips past a cape.
  const W = 3;
  const eroded = r.map((_, i) => Math.min(...Array.from({ length: 2 * W + 1 }, (_, j) => r[(i + j - W + RAYS) % RAYS])));
  const smooth = eroded.map((_, i) => (eroded[(i - 1 + RAYS) % RAYS] + eroded[i] + eroded[(i + 1) % RAYS]) / 3);
  const blob = smooth.map((l, i) => [cr.at[0] + l * Math.cos((i / RAYS) * Math.PI * 2), cr.at[1] + l * Math.sin((i / RAYS) * Math.PI * 2)]);
  if (cr.squares === 1) return void zones.push({ poly: roundPoly(clockwise(blob)), crossing: cr.name });
  // Split across the long axis into two halves of equal area.
  const u = [Math.cos(rot), Math.sin(rot)];
  const c0 = u[0] * cr.at[0] + u[1] * cr.at[1];
  let lo = -cr.rx, hi = cr.rx;
  for (let it = 0; it < 40; it++) {
    const t = (lo + hi) / 2;
    if (Math.abs(area(clipHalf(blob, u[0], u[1], c0 + t))) < Math.abs(area(blob)) / 2) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  let halves = [clipHalf(blob, u[0], u[1], c0 + t), clipHalf(blob, -u[0], -u[1], -(c0 + t))];
  const prev = regionOutlines[sections[Math.min(k, sections.length - 1)].id];
  const dPrev = (poly) => Math.min(...prev.map((pc) => edgeDist(centroid(poly), pc)));
  if (dPrev(halves[1]) < dPrev(halves[0])) halves = [halves[1], halves[0]];
  for (const h of halves) zones.push({ poly: roundPoly(clockwise(h)), crossing: cr.name });
});

// ---------- order ----------

const near = (a, b) => polyDist(a, b);
function sharesBorder(a, b) {
  const on = a.filter((p) => edgeDist(p, b) < 1e-3);
  return on.length >= 2 && Math.max(...on.flatMap((p) => on.map((q) => dist(p, q)))) > 0.05;
}

const order = [];
let airportNo = 0, highwayNo = 0, taxNo = 0;
const zoneIds = [];
GAPS.forEach((g) => g.forEach((kind) => {
  if (kind === 'airport') zoneIds.push(`airport-${++airportNo}`);
  if (kind === 'highway') zoneIds.push(`highway-${++highwayNo}`);
  if (kind === 'tax') zoneIds.push(`tax-${++taxNo}`);
  if (kind === 'newYear') zoneIds.push('new-year');
}));
const zoneById = new Map(zoneIds.map((id, i) => [id, zones[i]]));
const adjacency = new Map();

sections.forEach((sec, k) => {
  const ids = [...parcels.values()].filter((q) => q.section === sec.id).map((q) => q.id);
  const P = ids.map((id) => parcels.get(id));
  for (const q of P) q.label = pole(q.poly);
  const before = k === 0 ? zones[zones.length - 1] : zones[2 * k - 1];
  const after = zones[2 * k];
  const pick = (zone, not) => {
    const zc = pole(zone.poly);
    return P.map((q, i) => ({ i, d: near(q.poly, zone.poly) + 0.01 * Math.hypot(q.label.x - zc.x, q.label.y - zc.y) })).filter((x) => x.i !== not).sort((a, b) => a.d - b.d)[0].i;
  };
  const entry = pick(before, -1);
  const exit = pick(after, entry);
  const adj = P.map((a, i) => P.map((b, j) => i !== j && (a.piece === b.piece ? sharesBorder(a.poly, b.poly) || sharesBorder(b.poly, a.poly) : near(a.poly, b.poly) < 1.0)));
  P.forEach((a, i) => adjacency.set(a.id, P.filter((_, j) => adj[i][j]).map((b) => b.id)));
  const cd = (i, j) => Math.hypot(P[i].label.x - P[j].label.x, P[i].label.y - P[j].label.y);
  const cost = (i, j) => (adj[i][j] ? cd(i, j) : 100 + cd(i, j));
  // Exact shortest Hamiltonian path entry -> exit over 14 parcels (bitmask DP).
  const n = P.length, FULL = (1 << n) - 1;
  const dp = Array.from({ length: 1 << n }, () => new Float64Array(n).fill(Infinity));
  const from = Array.from({ length: 1 << n }, () => new Int8Array(n).fill(-1));
  dp[1 << entry][entry] = 0;
  for (let m = 0; m <= FULL; m++) {
    if (!(m & (1 << entry))) continue;
    for (let v = 0; v < n; v++) {
      const cur = dp[m][v];
      if (cur === Infinity || v === exit && m !== FULL) continue;
      for (let w = 0; w < n; w++) {
        if (m & (1 << w)) continue;
        const nm = m | (1 << w), c = cur + cost(v, w);
        if (c < dp[nm][w]) { dp[nm][w] = c; from[nm][w] = v; }
      }
    }
  }
  const path = [];
  for (let m = FULL, v = exit; v >= 0; ) {
    path.unshift(v);
    const u = from[m][v];
    m &= ~(1 << v);
    v = u;
  }
  if (path.length !== n || path[0] !== entry) throw new Error(`${sec.id}: no path`);
  const jumps = path.slice(1).filter((v, i) => !adj[path[i]][v]).length;
  if (jumps) console.log(`${sec.id}: ${jumps} step(s) between parcels that do not touch`);
  order.push(...path.map((i) => P[i].id));
  order.push(...zoneIds.slice(2 * k, 2 * k + 2));
});
order.unshift(order.pop()); // New Year is square 0

// ---------- checks ----------

const squares = order.map((id, index) => {
  const q = parcels.get(id);
  if (q) return { index, id, kind: 'land', section: q.section, poly: q.poly, label: q.label, ...(q.city ? { city: q.city } : {}) };
  const z = zoneById.get(id);
  return { index, id, kind: 'sea', sea: z.crossing, poly: z.poly, label: pole(z.poly) };
});
for (const s of squares) {
  s.label = { x: round(s.label.x), y: round(s.label.y), r: round(s.label.r) };
  if (!isSimple(s.poly)) problems.push(`${s.id}: parcel is not a simple polygon`);
  if (s.label.r < MIN_RADIUS) problems.push(`${s.id}: too small (inscribed radius ${s.label.r})`);
  if (s.city && !inside(s.city, s.poly)) problems.push(`${s.id}: city outside its parcel`);
  if (s.poly.some(([x, y]) => x < 0 || y < 0 || x > WIDTH || y > HEIGHT)) problems.push(`${s.id}: outside the map`);
}
for (const z of squares.filter((s) => s.kind === 'sea'))
  for (const l of squares.filter((s) => s.kind === 'land')) if (polyDist(z.poly, l.poly) < 0.02) problems.push(`${z.id} touches ${l.id}`);

const json = (v) => JSON.stringify(v);
writeFileSync('data/layout.json', `{
  "_note": "Generated by scripts/generate-layout.mjs from scripts/world.mjs and the city lat/lon in data/sections.json. Do not edit by hand. Units are map cells, origin top-left, y down. Every square is a territory: poly is its outline (a simple polygon); label is its pole of inaccessibility (x, y) and the radius r of the largest circle that fits inside; city is the projected real location of a city. kind land = a parcel of a playable region, sea = a sea zone on a crossing. regions are the playable coastlines (one outline per island), backdrop is the non-playable land. Square order here is the board order (data/board.json copies it).",
  "width": ${WIDTH},
  "height": ${HEIGHT},
  "minRadius": ${MIN_RADIUS},
  "title": ${json(TITLE)},
  "squares": [
${squares.map((q) => `    ${json(q)}`).join(',\n')}
  ],
  "adjacency": ${json(Object.fromEntries(adjacency))},
  "regions": {
${Object.entries(regionOutlines).map(([k, v]) => `    ${json(k)}: ${json(v)}`).join(',\n')}
  },
  "backdrop": [
${backdrop.map((b) => `    ${json(b)}`).join(',\n')}
  ],
  "oceans": ${json(OCEANS)},
  "dateLine": ${json(DATE_LINE)}
}
`);
const radii = squares.map((s) => s.label.r);
console.log(`layout.json: ${WIDTH} x ${HEIGHT} cells, inscribed radius ${Math.min(...radii).toFixed(2)}-${Math.max(...radii).toFixed(2)}, ${problems.length} problems`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
