import { RULES } from '../engine/data';
import type { Square } from '../engine/types';
import layoutJson from '../../data/layout.json';

const ICONS: Record<string, string> = {
  newYear: '🎆',
  event: '❓',
  disaster: '⚠️',
  airport: '✈️',
  seaport: '⚓',
  tax: '💰',
  city: '🏙️',
};

export function tileIcon(sq: Square) {
  if (sq.type === 'utility') return RULES.utilities.kinds.find((k) => k.id === sq.utility)!.icon;
  return ICONS[sq.type];
}

/** Initials for cities without art: "Cape Town" -> "CT", "Lagos" -> "LAG". */
function initials(name: string) {
  const words = name.split(/\s+/);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 3)).toUpperCase();
}

export function tileArt(sq: Square) {
  if (sq.type === 'city') {
    return sq.image
      ? `<img src="${import.meta.env.BASE_URL}${sq.image}" alt="" loading="lazy" decoding="async" />`
      : `<span class="placeholder" aria-hidden="true">${initials(sq.name)}</span>`;
  }
  return `<span class="icon" aria-hidden="true">${tileIcon(sq)}</span>`;
}

type Pt = readonly number[];
interface Territory {
  index: number;
  id: string;
  kind: string;
  sea?: string;
  poly: Pt[];
  label: { x: number; y: number; r: number };
  city?: Pt;
}
const TERRITORIES = layoutJson.squares as Territory[];

/** The world-map board (see scripts/generate-layout.mjs): size in cells, title box, and every square's territory. */
export const MAP = { width: layoutJson.width, height: layoutJson.height, title: layoutJson.title };

/** Where a square's label sits: its pole of inaccessibility (x, y) and the radius r of the circle that fits there. */
export function boardPosition(index: number) {
  return TERRITORIES[index].label;
}

export function territoryKind(index: number) {
  return TERRITORIES[index].kind as 'land' | 'sea';
}

const f = (n: number) => Math.round(n * 100) / 100;
const pathOf = (poly: Pt[]) => `M${poly.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`;

/** The sea a sea-zone square lies in ("Baltic Sea"), or ''. */
export function seaName(index: number) {
  return TERRITORIES[index].sea ?? '';
}

/** Shipping lanes between seaports (data/layout.json), with square indices for their ends. */
export const LANES = layoutJson.seaRoutes.map((r) => ({
  id: r.id,
  name: r.name,
  a: TERRITORIES.find((t) => t.id === r.from)!.index,
  b: TERRITORIES.find((t) => t.id === r.to)!.index,
  pts: r.path as Pt[],
  d: `M${(r.path as Pt[]).map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}`,
}));

/** SVG path data of a square's territory, in cells. */
export function territoryPath(index: number) {
  return pathOf(TERRITORIES[index].poly);
}

/**
 * The map under and around the territories: ocean, a faint curved graticule, the non-playable land (all coast
 * strokes first, then all fills, so overlapping pieces show one outline), ocean names and the date line.
 */
export function mapUnderSvg() {
  const { width: w, height: h } = MAP;
  const cx = w / 2;
  const grid: string[] = [];
  for (const y of [5.5, 12.5, 20.2, 27.5, 34.5]) grid.push(`M0 ${y + 0.6}Q${cx} ${y - 0.6} ${w} ${y + 0.6}`);
  for (const k of [-4, -3, -2, -1, 0, 1, 2, 3, 4]) {
    const x = cx + k * 8.6;
    grid.push(`M${f(x - k * 0.5)} 0Q${f(x + k * 1.2)} ${h / 2} ${f(x - k * 0.5)} ${h}`);
  }
  const back = layoutJson.backdrop.map((b) => pathOf(b.poly)).join('');
  const regions = Object.values(layoutJson.regions).flat().map((p) => pathOf(p)).join('');
  const oceans = layoutJson.oceans
    .map((o) => `<text x="${o.at[0]}" y="${o.at[1]}" font-size="${o.size}">${o.name}</text>`)
    .join('');
  return `<rect class="map-ocean" width="${w}" height="${h}" rx="0.3"/>
      <path class="map-grid" d="${grid.join('')}"/>
      <g class="map-ocean-names">${oceans}</g>
      <path class="map-backdrop-coast" d="${back}"/>
      <path class="map-region-coast" d="${regions}"/>
      <path class="map-backdrop" d="${back}"/>
      <path class="map-date-line" d="M${layoutJson.dateLine.map((p) => p.join(' ')).join('L')}"/>
      ${lanesSvg()}`;
}

/**
 * Shipping lanes: a halo and a dotted navy line each (drawn over the backdrop land, under the territories), with
 * the route's name along it (shown when zoomed in). `data-lane` lets the view highlight the lanes open to a player.
 */
function lanesSvg() {
  return `<g class="map-lanes">${LANES.map((l) => {
    const label = laneLabel(l.pts);
    return `
      <g class="lane" data-lane="${l.id}">
        <path class="lane-halo" d="${l.d}"/>
        <path class="lane-line" d="${l.d}"/>
        <path id="lane-${l.id}" d="${label.d}" fill="none"/>
        <text class="lane-name"><textPath href="#lane-${l.id}" startOffset="50%">${l.name}</textPath></text>
      </g>`;
  }).join('')}</g>`;
}

/**
 * Where a lane's name goes: a stretch of about 5 cells of the lane, on the map (not past its edge), as level as
 * possible and away from the ends, drawn left to right so the text is never upside down.
 */
const SEA_ZONES = TERRITORIES.filter((t) => t.kind === 'sea').map((t) => t.poly);
function insidePoly(p: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function laneLabel(pts: Pt[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const span = Math.min(5, total * 0.5);
  let best = { score: Infinity, i: 0, j: pts.length - 1 };
  for (let i = 0; i < pts.length; i++) {
    let j = i;
    while (j < pts.length - 1 && cum[j] - cum[i] < span) j++;
    if (cum[j] - cum[i] < span) break;
    const seg = pts.slice(i, j + 1);
    if (seg.some((p) => p[0] < 1 || p[0] > MAP.width - 1 || p[1] < 0.6 || p[1] > MAP.height - 0.4)) continue;
    if (seg.some((p) => SEA_ZONES.some((z) => insidePoly(p, z)))) continue; // a sea zone would cover the name
    // Prefer level (small |dy| over the stretch, little turning) and the middle of the lane.
    const dy = Math.abs(pts[j][1] - pts[i][1]);
    const chord = Math.hypot(pts[j][0] - pts[i][0], dy);
    const mid = Math.abs((cum[i] + cum[j]) / 2 - total / 2) / total;
    const score = dy / span + (span - chord) / span * 3 + mid;
    if (score < best.score) best = { score, i, j };
  }
  let seg = pts.slice(best.i, best.j + 1);
  if (seg[seg.length - 1][0] < seg[0][0]) seg = [...seg].reverse();
  return { d: `M${seg.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}` };
}

/** A flight arc between two squares' label points: a quadratic curve bowed to the left of the direction of travel (cells). */
export function arcPath(from: number, to: number) {
  const a = TERRITORIES[from].label, b = TERRITORIES[to].label;
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const bow = Math.min(6, 0.22 * d);
  // Bow northward (up the screen) whichever way the flight goes, like a great circle on this map.
  const sign = dx >= 0 ? 1 : -1;
  const c = [(a.x + b.x) / 2 + (dy / d) * bow * sign, (a.y + b.y) / 2 - (Math.abs(dx) / d) * bow];
  return `M${f(a.x)} ${f(a.y)}Q${f(c[0])} ${f(c[1])} ${f(b.x)} ${f(b.y)}`;
}

/** Where an arc or lane meets a destination: its label point (cells). */
export function labelPoint(index: number) {
  return TERRITORIES[index].label;
}

/** Drawn over the territories: coastlines, city dots and the route (a thin line with arrowheads between squares). */
export function mapOverSvg() {
  const regions = Object.values(layoutJson.regions).flat().map((p) => pathOf(p)).join('');
  const dots = TERRITORIES.filter((t) => t.city).map((t) => `<circle cx="${t.city![0]}" cy="${t.city![1]}" r="0.075"/>`).join('');
  const n = TERRITORIES.length;
  const route = TERRITORIES.map((t, i) => {
    const a = t.label, b = TERRITORIES[(i + 1) % n].label;
    // From the edge of one label to the edge of the next, so the line never runs under text.
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ua = Math.min(a.r * 0.8, d * 0.35), ub = Math.min(b.r * 0.8, d * 0.35);
    const p = [a.x + (dx / d) * ua, a.y + (dy / d) * ua], q = [b.x - (dx / d) * ub, b.y - (dy / d) * ub];
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return `<path d="M${f(p[0])} ${f(p[1])}L${f(q[0])} ${f(q[1])}"/><path class="head" transform="translate(${f(m[0])} ${f(m[1])}) rotate(${Math.round(deg)})" d="M-0.09 -0.13L0.07 0L-0.09 0.13"/>`;
  }).join('');
  return `<path class="map-coast" d="${regions}"/>
      <g class="map-route">${route}</g>
      <g class="map-cities">${dots}</g>`;
}
