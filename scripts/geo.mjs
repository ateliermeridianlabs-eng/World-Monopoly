// Plane geometry for scripts/generate-layout.mjs. Polygons are arrays of [x, y] points, not closed (the last
// point joins the first). Nothing here is specific to the game.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Signed area (positive when the points run clockwise on screen, where y points down). */
export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from p to the polygon's boundary. */
export function edgeDist(p, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

/** Shortest distance between two polygons (0 if they touch or overlap). */
export function polyDist(a, b) {
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return 0;
  let d = Infinity;
  for (const p of a) d = Math.min(d, edgeDist(p, b));
  for (const p of b) d = Math.min(d, edgeDist(p, a));
  return d;
}

/** Keeps the part of `poly` where a*x + b*y <= c (Sutherland-Hodgman against one line). */
export function clipHalf(poly, a, b, c) {
  const out = [];
  const side = (p) => a * p[0] + b * p[1] - c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

/** Splits every edge longer than `max` into equal pieces. */
export function densify(poly, max) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(dist(p, q) / max));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  }
  return out;
}

/** Drops repeated points and points on a straight line between their neighbours. */
export function tidy(poly, eps = 1e-6) {
  let pts = poly.filter((p, i) => dist(p, poly[(i + 1) % poly.length]) > eps);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < eps && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  const z = 1e-12;
  return (Math.abs(d1) < z && on(c, d, a)) || (Math.abs(d2) < z && on(c, d, b)) || (Math.abs(d3) < z && on(a, b, c)) || (Math.abs(d4) < z && on(a, b, d));
}

/** True if no two non-neighbouring edges touch and the polygon has an area. */
export function isSimple(poly) {
  const n = poly.length;
  if (n < 3 || Math.abs(area(poly)) < 1e-9) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  return true;
}

/**
 * Pole of inaccessibility: the point inside the polygon farthest from its edges, and that distance (the radius
 * of the largest inscribed circle). Grid search refined around the best cell (after Mapbox's polylabel).
 */
export function pole(poly, precision = 0.01) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  const sd = (p) => (inside(p, poly) ? 1 : -1) * edgeDist(p, poly);
  const h0 = Math.min(x1 - x0, y1 - y0) / 2;
  const queue = [];
  for (let x = x0; x < x1; x += h0 * 2) for (let y = y0; y < y1; y += h0 * 2) queue.push(cell(x + h0, y + h0, h0));
  function cell(x, y, h) {
    const d = sd([x, y]);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  }
  const c = centroid(poly);
  let best = cell(c[0], c[1], 0);
  while (queue.length) {
    queue.sort((a, b) => a.max - b.max);
    const q = queue.pop();
    if (q.d > best.d) best = q;
    if (q.max - best.d <= precision) continue;
    const h = q.h / 2;
    queue.push(cell(q.x - h, q.y - h, h), cell(q.x + h, q.y - h, h), cell(q.x - h, q.y + h, h), cell(q.x + h, q.y + h, h));
  }
  return { x: best.x, y: best.y, r: best.d };
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** First hit of the ray from `o` along unit vector `u` with any edge of the polygons, or Infinity. */
export function rayHit(o, u, polys) {
  let best = Infinity;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = u[0] * ey - u[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = a[0] - o[0], wy = a[1] - o[1];
      const t = (wx * ey - wy * ex) / den;
      const s = (wx * u[1] - wy * u[0]) / den;
      if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
    }
  return best;
}

/**
 * The parts of a simple polygon where a*x + b*y <= c, as separate simple polygons (a concave outline can fall
 * apart into several pieces when cut by a line). Each crossing of the line is paired with the next one along
 * the line; those chords close the pieces.
 */
export function splitHalf(poly, a, b, c) {
  const side = (p) => {
    const s = a * p[0] + b * p[1] - c;
    return s === 0 ? -1e-15 : s;
  };
  const items = []; // { p, kind: 'v' | 'in' | 'out' }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp < 0) items.push({ p, kind: 'v' });
    if ((sp < 0) !== (sq < 0)) {
      const t = sp / (sp - sq);
      items.push({ p: [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])], kind: sp < 0 ? 'out' : 'in' });
    }
  }
  if (!items.some((x) => x.kind !== 'v')) return items.length >= 3 ? [items.map((x) => x.p)] : [];
  const along = (p) => -b * p[0] + a * p[1];
  const cuts = items.filter((x) => x.kind !== 'v').sort((x, y) => along(x.p) - along(y.p));
  for (let k = 0; k + 1 < cuts.length; k += 2) { cuts[k].pair = cuts[k + 1]; cuts[k + 1].pair = cuts[k]; }
  items.forEach((x, i) => { x.next = items[(i + 1) % items.length]; });
  const pieces = [];
  const seen = new Set();
  for (const start of items) {
    if (seen.has(start) || start.kind === 'out') continue;
    const piece = [];
    let x = start, guard = 0;
    while (!seen.has(x) && guard++ < items.length * 2) {
      seen.add(x);
      piece.push(x.p);
      if (x.kind === 'out') {
        x = x.pair;
        if (!x) break;
        if (seen.has(x)) break;
        seen.add(x);
        piece.push(x.p);
      }
      x = x.next;
    }
    if (piece.length >= 3 && Math.abs(area(piece)) > 1e-9) pieces.push(piece);
  }
  return pieces;
}

/**
 * Union of two clockwise polygons that share part of their boundary (no overlap). Returns null if the result is
 * not one outline (they do not touch, or touch at a point only).
 */
export function unionTouching(A, B, eps = 1e-6) {
  const pts = [];
  const key = (p) => {
    for (let i = 0; i < pts.length; i++) if (dist(pts[i], p) < eps) return i;
    pts.push(p);
    return pts.length - 1;
  };
  const withJoints = (P, Q) => {
    const out = [];
    P.forEach((p, i) => {
      const q = P[(i + 1) % P.length];
      out.push(p);
      const extra = Q.filter((r) => dist(r, p) > eps && dist(r, q) > eps && segDist(r, p, q) < eps).sort((r, s) => dist(p, r) - dist(p, s));
      out.push(...extra);
    });
    return out.map(key);
  };
  const a = withJoints(A, B), b = withJoints(B, A);
  const edges = [];
  for (const P of [a, b]) P.forEach((v, i) => { if (v !== P[(i + 1) % P.length]) edges.push([v, P[(i + 1) % P.length]]); });
  const live = edges.filter(([u, v]) => !edges.some(([x, y]) => x === v && y === u));
  if (live.length === edges.length) return null;
  const next = new Map();
  for (const [u, v] of live) {
    if (next.has(u)) return null;
    next.set(u, v);
  }
  const loop = [];
  let v = live[0][0];
  do {
    loop.push(pts[v]);
    v = next.get(v);
    if (v === undefined) return null;
  } while (v !== live[0][0] && loop.length <= live.length);
  return loop.length === live.length ? loop : null;
}
