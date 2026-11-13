// Shipping lanes for scripts/generate-layout.mjs: the cheapest way by sea between two points on the map, as a
// smooth curve. A grid (STEP cells) over the map, plus a strip of open water past the right edge, gets a cost per
// grid cell: open water 1, more close to a coast, a lot more on land (so a lane only cuts land at a strait), more
// inside sea zones that are not the lane's own ports, and more next to lanes already drawn (so lanes keep apart).
// Dijkstra finds the path through the via points; Douglas-Peucker and Chaikin smoothing turn it into a curve.

const STEP = 0.2;
const OFF_MAP = 1.6; // open water past the right edge, in cells
const CLEARANCE = 0.7; // cells from a coast before a lane pays no coast penalty

export function makeLaneGrid({ width, height, regions, backdrop, blocked, zones }) {
  const nx = Math.ceil((width + OFF_MAP) / STEP) + 1, ny = Math.ceil(height / STEP) + 1;
  const N = nx * ny;
  const land = new Uint8Array(N); // 0 water, 1 backdrop, 2 playable region, 3 blocked
  const zone = new Int16Array(N).fill(-1);
  const fill = (poly, apply) => {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let j = Math.max(0, Math.floor(y0 / STEP)); j <= Math.min(ny - 1, Math.ceil(y1 / STEP)); j++) {
      const y = j * STEP, xs = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = Math.max(0, Math.ceil(xs[k] / STEP)); i <= Math.min(nx - 1, Math.floor(xs[k + 1] / STEP)); i++) apply(j * nx + i);
    }
  };
  for (const poly of backdrop) fill(poly, (k) => (land[k] = Math.max(land[k], 1)));
  for (const poly of regions) fill(poly, (k) => (land[k] = Math.max(land[k], 2)));
  for (const poly of blocked) fill(poly, (k) => (land[k] = 3));
  zones.forEach((poly, z) => fill(poly, (k) => (zone[k] = z)));
  // Distance to the nearest land (chamfer transform, in grid steps).
  const d = new Float32Array(N).fill(1e9);
  for (let k = 0; k < N; k++) if (land[k]) d[k] = 0;
  const D2 = Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i > 0) d[k] = Math.min(d[k], d[k - 1] + 1);
    if (j > 0) d[k] = Math.min(d[k], d[k - nx] + 1, i > 0 ? d[k - nx - 1] + D2 : 1e9, i < nx - 1 ? d[k - nx + 1] + D2 : 1e9);
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (i < nx - 1) d[k] = Math.min(d[k], d[k + 1] + 1);
    if (j < ny - 1) d[k] = Math.min(d[k], d[k + nx] + 1, i < nx - 1 ? d[k + nx + 1] + D2 : 1e9, i > 0 ? d[k + nx - 1] + D2 : 1e9);
  }
  const base = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = land[k];
    if (t === 3) base[k] = Infinity;
    else if (t === 2) base[k] = 60;
    else if (t === 1) base[k] = 14;
    else base[k] = 1 + 4 * Math.max(0, 1 - (d[k] * STEP) / CLEARANCE) ** 2;
  }
  const used = new Float32Array(N);
  return { nx, ny, N, base, zone, used, width, height };
}

/** Lane from `a` to `b` through `via` (map cells). `own`: zone indexes the lane may cross freely (its ports). */
export function seaLane(g, a, b, via, own) {
  const pts = [a, ...via, b];
  let path = [];
  for (let s = 0; s + 1 < pts.length; s++) {
    const seg = dijkstra(g, pts[s], pts[s + 1], own);
    path = path.concat(s ? seg.slice(1) : seg);
  }
  path[0] = a;
  path[path.length - 1] = b;
  // Lanes drawn later keep some distance from this one.
  for (const p of path) {
    const ci = Math.round(p[0] / STEP), cj = Math.round(p[1] / STEP);
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      g.used[j * g.nx + i] = Math.max(g.used[j * g.nx + i], 1.5 * (1 - Math.hypot(di, dj) / 4.3));
    }
  }
  const simple = dp(path, 0.18);
  return chaikin(simple, 3).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
}

function dijkstra(g, a, b, own) {
  const { nx, ny, N, base, zone, used } = g;
  const idx = (p) => Math.min(ny - 1, Math.max(0, Math.round(p[1] / STEP))) * nx + Math.min(nx - 1, Math.max(0, Math.round(p[0] / STEP)));
  const cost = (k) => {
    const z = zone[k];
    return base[k] + used[k] + (z >= 0 && !own.includes(z) ? 5 : 0);
  };
  const src = idx(a), dst = idx(b);
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = [[0, src]];
  dist[src] = 0;
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const [dk, k] = pop();
    if (dk > dist[k]) continue;
    if (k === dst) break;
    const i = k % nx, j = (k - i) / nx;
    const ck = cost(k);
    for (const [di, dj, len] of nb) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const kk = jj * nx + ii;
      const c = ck + cost(kk);
      if (!Number.isFinite(c)) continue;
      const nd = dk + (len * c) / 2;
      if (nd < dist[kk]) { dist[kk] = nd; prev[kk] = k; push([nd, kk]); }
    }
  }
  if (!Number.isFinite(dist[dst])) throw new Error(`no sea lane from ${a} to ${b}`);
  const out = [];
  for (let k = dst; k >= 0; k = prev[k]) out.unshift([(k % nx) * STEP, Math.floor(k / nx) * STEP]);
  return out;
}

/** Douglas-Peucker on an open polyline. */
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let best = -1, bd = tol;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], a, b);
    if (d > bd) { bd = d; best = i; }
  }
  if (best < 0) return [a, b];
  return [...dp(pts.slice(0, best + 1), tol).slice(0, -1), ...dp(pts.slice(best), tol)];
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Chaikin corner cutting on an open polyline (keeps both ends). */
function chaikin(pts, rounds) {
  for (let r = 0; r < rounds; r++) {
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i], pts[i + 1]];
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
