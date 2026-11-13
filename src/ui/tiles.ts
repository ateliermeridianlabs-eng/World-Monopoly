import { RULES } from '../engine/data';
import type { Square } from '../engine/types';
import layoutJson from '../../data/layout.json';

const ICONS: Record<string, string> = {
  newYear: '🎆',
  event: '❓',
  disaster: '⚠️',
  airport: '✈️',
  highway: '🛣️',
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

/** The world-map board: map size in cells and the centre of every square (see scripts/generate-layout.mjs). */
export const MAP = { width: layoutJson.width, height: layoutJson.height, title: layoutJson.title };

/** Centre of a square on the map, in cells from the top-left. Tiles are 1 x 1 cells, upright. */
export function boardPosition(index: number) {
  const { x, y } = layoutJson.squares[index];
  return { x, y };
}

type Pt = readonly number[];
const f = (n: number) => Math.round(n * 100) / 100;

/** SVG path through `pts` as a smooth curve (uniform Catmull-Rom converted to cubic Beziers). */
export function smoothPath(pts: Pt[], closed: boolean) {
  const n = pts.length;
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}

/**
 * The map behind the tiles: ocean, a few curved latitude and longitude lines, simplified continents and the
 * route through every tile centre. Drawn in cell units, scaled to the board box; colours come from CSS.
 */
export function mapBackdropSvg() {
  const { width: w, height: h } = MAP;
  const cx = w / 2;
  const grid: string[] = [];
  // Latitudes: gentle arcs (the equator runs through the middle of South America and Africa).
  for (const y of [4.5, 9.3, 14.1, 18.9]) grid.push(`M0 ${y + 0.5}Q${cx} ${y - 0.5} ${w} ${y + 0.5}`);
  // Longitudes: bowed outward from the central meridian, like a world-map projection.
  for (const k of [-3, -2, -1, 0, 1, 2, 3]) {
    const x = cx + k * 6.4;
    grid.push(`M${f(x - k * 0.5)} 0Q${f(x + k * 1.2)} ${h / 2} ${f(x - k * 0.5)} ${h}`);
  }
  const land = Object.values(layoutJson.continents).map((pts) => `<path d="${smoothPath(pts, true)}"/>`).join('');
  const route = smoothPath(layoutJson.squares.map((s) => [s.x, s.y]), true);
  return `<svg class="map-backdrop" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <rect class="map-ocean" width="${w}" height="${h}" rx="0.3"/>
      <path class="map-grid" d="${grid.join('')}"/>
      <g class="map-land">${land}</g>
      <path class="map-route" d="${route}"/>
    </svg>`;
}

/** Small arrowheads between consecutive tiles, drawn above them, pointing the way play moves. */
export function routeArrowsSvg() {
  const sq = layoutJson.squares;
  const heads = sq.map((a, i) => {
    const b = sq[(i + 1) % sq.length];
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return `<path transform="translate(${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}) rotate(${Math.round(deg)})" d="M-0.07 -0.11L0.07 0L-0.07 0.11"/>`;
  });
  return `<svg class="map-arrows" viewBox="0 0 ${MAP.width} ${MAP.height}" preserveAspectRatio="none" aria-hidden="true">${heads.join('')}</svg>`;
}
