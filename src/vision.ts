/**
 * Screenshot -> puzzle graph.
 *
 *   1. dot mask       dark pixels UNION saturated pixels (dark catches the dots
 *                     and the connecting lines, saturated catches the coloured
 *                     rings).  White digits inside a coloured dot are holes and
 *                     get filled, but only if they are small — board faces must
 *                     stay background.
 *   2. distance xform dot interiors survive, thin lines do not
 *   3. components     one per dot -> centre + radius
 *   4. ring colour    saturated outer annulus => endpoint; median ring RGB is
 *                     the colour class.  No OCR: a colour class is one pair.
 *   5. segment test   two dots are joined iff the segment between them is
 *                     unbroken, minus segments that run through a third dot.
 *
 * The two thresholds that cannot be expressed as ratios of image content —
 * "how big is a dot" and "how big may a hole be" — are derived from the image
 * itself, never hard-coded in pixels.  Otherwise the same puzzle at a different
 * export size silently stops working.
 */
import { edtSquared } from "./edt";
import type { PEdge, PNode, Puzzle } from "./types";

export interface VisionParams {
  thresh: number;
  satMin: number;
  /** 0 = derive from the image. */
  minDist: number;
  ratio: number;
  /** 0 = derive from the image. */
  maxHole: number;
  rgbTol: number;
}

/**
 * `ratio` caps how far apart two dots may be, in units of the median
 * nearest-neighbour distance.  It only bounds the candidate set for speed — the
 * pixel test decides.  It must clear the longest real edge (a 45 degree
 * diagonal is 1.41x the grid step, so 1.4 is *not* enough) and can safely stay
 * below 2.0x, where two-step collinear pairs live; those are rejected as
 * pass-throughs anyway.
 */
export const DEFAULT_VISION: VisionParams = {
  thresh: 100,
  satMin: 60,
  minDist: 0,
  ratio: 1.9,
  maxHole: 0,
  rgbTol: 70,
};

/**
 * min_dist as a fraction of the dot radius.  Line pixels never reach much past
 * their half-width (~0.1-0.2 of the dot radius), so anything above ~0.3 keeps
 * only dot cores; 0.45 leaves margin on both sides, and the core still contains
 * the true centre so the reported radius stays exact.  Lower rungs are fallbacks
 * for oddly drawn boards, not the default.
 */
const DOT_SCALES = [0.6, 0.5, 0.45, 0.4, 0.32, 0.25, 0.72];

// Every dot in one of these puzzles is drawn the same size, so anything much
// smaller than the median is page furniture that slipped past the size gate.
const OUTLIER_RATIO = 0.65;

interface Labeling {
  lab: Int32Array;
  count: number;
  size: Int32Array;
  border: Uint8Array;
}

interface RawDot {
  x: number;
  y: number;
  r: number;
}

function labelComponents(mask: Uint8Array, w: number, h: number): Labeling {
  const n = w * h;
  const lab = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  const borders: number[] = [];
  let count = 0;

  for (let start = 0; start < n; start++) {
    if (!mask[start] || lab[start] >= 0) continue;
    const id = count++;
    let sp = 0;
    stack[sp++] = start;
    lab[start] = id;
    let size = 0;
    let border = 0;
    while (sp > 0) {
      const q = stack[--sp];
      size++;
      const x = q % w;
      const y = (q - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = 1;
      if (x > 0 && mask[q - 1] && lab[q - 1] < 0) {
        lab[q - 1] = id;
        stack[sp++] = q - 1;
      }
      if (x < w - 1 && mask[q + 1] && lab[q + 1] < 0) {
        lab[q + 1] = id;
        stack[sp++] = q + 1;
      }
      if (y > 0 && mask[q - w] && lab[q - w] < 0) {
        lab[q - w] = id;
        stack[sp++] = q - w;
      }
      if (y < h - 1 && mask[q + w] && lab[q + w] < 0) {
        lab[q + w] = id;
        stack[sp++] = q + w;
      }
    }
    sizes.push(size);
    borders.push(border);
  }
  return {
    lab,
    count,
    size: Int32Array.from(sizes),
    border: Uint8Array.from(borders),
  };
}

function fillSmallHoles(mask: Uint8Array, w: number, h: number, maxArea: number): void {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
  const lb = labelComponents(inv, w, h);
  for (let i = 0; i < w * h; i++) {
    const id = lb.lab[i];
    if (id >= 0 && !lb.border[id] && lb.size[id] <= maxArea) mask[i] = 1;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

/**
 * Robust radius of the largest solid disk, i.e. the dot radius in pixels.
 * `dt2` holds SQUARED distances.
 */
function radiusQuantile(dt2: Float64Array, q = 0.999): number {
  const hist = new Int32Array(1024);
  let total = 0;
  for (let i = 0; i < dt2.length; i++) {
    const v = dt2[i];
    if (v <= 0) continue;
    let r = Math.floor(Math.sqrt(v));
    if (r > 1023) r = 1023;
    hist[r]++;
    total++;
  }
  if (total === 0) return 0;
  const want = Math.ceil(total * q);
  let acc = 0;
  for (let r = 0; r < 1024; r++) {
    acc += hist[r];
    if (acc >= want) return r;
  }
  return 1023;
}

function dotsFromDt(dt2: Float64Array, minDist: number, w: number, h: number): RawDot[] {
  const n = w * h;
  const md2 = minDist * minDist;
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = dt2[i] >= md2 ? 1 : 0;
  const lb = labelComponents(core, w, h);

  const best = new Float64Array(lb.count);
  const bx = new Float64Array(lb.count);
  const by = new Float64Array(lb.count);
  for (let i = 0; i < n; i++) {
    const id = lb.lab[i];
    if (id < 0) continue;
    if (dt2[i] > best[id]) {
      best[id] = dt2[i];
      bx[id] = i % w;
      by[id] = (i - (i % w)) / w;
    }
  }

  const out: RawDot[] = [];
  for (let id = 0; id < lb.count; id++) {
    if (best[id] === 0 || lb.size[id] < 200) continue;
    out.push({ x: bx[id], y: by[id], r: Math.sqrt(best[id]) });
  }
  return out;
}

function radiusSpread(dots: RawDot[]): number {
  if (dots.length < 3) return 1;
  const rs = dots.map((d) => d.r).sort((a, b) => a - b);
  const q = (p: number) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  const mid = q(0.5);
  return mid > 0 ? (q(0.9) - q(0.1)) / mid : 1;
}

function chooseDots(
  dt2: Float64Array,
  w: number,
  h: number,
  minDist: number,
): { dots: RawDot[]; minDist: number; spread: number } {
  if (minDist > 0) {
    const dots = dotsFromDt(dt2, minDist, w, h);
    return { dots, minDist, spread: radiusSpread(dots) };
  }
  const dmax = radiusQuantile(dt2);
  let best: { dots: RawDot[]; minDist: number; spread: number } | null = null;
  for (const f of DOT_SCALES) {
    const md = dmax * f;
    const dots = dotsFromDt(dt2, md, w, h);
    if (dots.length < 3) continue;
    const spread = radiusSpread(dots);
    if (!best || spread < best.spread) best = { dots, minDist: md, spread };
    if (spread <= 0.12) return best;
  }
  return best ?? { dots: [], minDist: dmax * DOT_SCALES[0], spread: 1 };
}

export function extractPuzzle(img: ImageData, p: VisionParams = DEFAULT_VISION): Puzzle {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const data = img.data;

  const lum = new Float32Array(n);
  const sat = new Int16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const base = new Uint8Array(n);
  for (let i = 0; i < n; i++) base[i] = lum[i] < p.thresh || sat[i] > p.satMin ? 1 : 0;

  // Size the hole cap from the dot radius: a digit hole is a small fraction of
  // a board face, and both scale with the dot.  An absolute cap fills every
  // board face on a small export and turns the whole board into one blob.
  let maxHole = p.maxHole;
  if (maxHole <= 0) {
    const r0 = radiusQuantile(edtSquared(base, w, h));
    maxHole = Math.round(2.5 * r0 * r0);
  }
  const mask = base.slice();
  fillSmallHoles(mask, w, h, maxHole);

  const dt2 = edtSquared(mask, w, h);
  const chosen = chooseDots(dt2, w, h, p.minDist);

  // page furniture (UI text, icons) that made it past the size gate
  let dropped = 0;
  let kept = chosen.dots;
  if (kept.length >= 3) {
    const mid = [...kept.map((d) => d.r)].sort((a, b) => a - b)[kept.length >> 1];
    const filtered = kept.filter((d) => d.r >= OUTLIER_RATIO * mid);
    dropped = kept.length - filtered.length;
    kept = filtered;
  }

  const nodes: PNode[] = kept.map((d) => ({
    x: d.x,
    y: d.y,
    r: d.r,
    pair: null,
    rgb: null,
  }));

  classifyColors(img, sat, nodes, p);
  assignPairs(nodes, p.rgbTol);
  const { edges, spacing } = findEdges(mask, nodes, w, h, p.ratio);

  return {
    nodes,
    edges,
    width: w,
    height: h,
    meta: {
      radius: Math.round(radiusQuantile(dt2) * 10) / 10,
      minDist: Math.round(chosen.minDist * 10) / 10,
      maxHole,
      spacing: Math.round(spacing),
      spread: Math.round(chosen.spread * 1000) / 1000,
      dropped,
    },
  };
}

function classifyColors(
  img: ImageData,
  sat: Int16Array,
  nodes: PNode[],
  p: VisionParams,
): void {
  const w = img.width;
  const h = img.height;
  const data = img.data;

  for (const node of nodes) {
    const x0 = Math.max(0, Math.floor(node.x - node.r - 4));
    const x1 = Math.min(w - 1, Math.ceil(node.x + node.r + 4));
    const y0 = Math.max(0, Math.floor(node.y - node.r - 4));
    const y1 = Math.min(h - 1, Math.ceil(node.y + node.r + 4));
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    let annulus = 0;
    let on = 0;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - node.x;
        const dy = y - node.y;
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr <= node.r * 0.72 || rr > node.r) continue;
        annulus++;
        const i = y * w + x;
        if (sat[i] <= p.satMin) continue;
        on++;
        const j = i * 4;
        rs.push(data[j]);
        gs.push(data[j + 1]);
        bs.push(data[j + 2]);
      }
    }
    if (annulus === 0 || on / annulus < 0.55) continue;
    node.rgb = [Math.round(median(rs)), Math.round(median(gs)), Math.round(median(bs))];
  }
}

/**
 * Cluster coloured dots by ring colour; each class of exactly two becomes one
 * pair.  Pair ids are just sequential identities — the colour lives in `rgb`,
 * so the number of pairs is not limited by the palette.
 */
function assignPairs(nodes: PNode[], tol: number): number {
  const classes: number[][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const c = nodes[i].rgb;
    if (!c) continue;
    let placed = false;
    for (const cl of classes) {
      const ref = nodes[cl[0]].rgb!;
      const d = Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]);
      if (d < tol) {
        cl.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) classes.push([i]);
  }

  let next = 0;
  for (const cl of classes) {
    if (cl.length !== 2) continue;
    for (const i of cl) nodes[i].pair = next;
    next++;
  }
  return next;
}

function findEdges(
  mask: Uint8Array,
  nodes: PNode[],
  w: number,
  h: number,
  ratio: number,
): { edges: PEdge[]; spacing: number } {
  const n = nodes.length;
  if (n < 2) return { edges: [], spacing: 0 };
  const nn: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < best) best = d;
    }
    nn.push(best);
  }
  const spacing = median(nn);
  const limit = spacing * ratio;

  const edges: PEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const L = Math.hypot(dx, dy);
      if (L > limit) continue;
      if (!segmentIsLine(mask, nodes[i], nodes[j], L, w, h)) continue;
      if (passesThroughThird(nodes, i, j)) continue;
      edges.push({ a: i, b: j });
    }
  }
  return { edges, spacing };
}

function segmentIsLine(
  mask: Uint8Array,
  a: PNode,
  b: PNode,
  L: number,
  w: number,
  h: number,
): boolean {
  const ra = a.r;
  const rb = b.r;
  if (L <= ra + rb) return true;
  const t0 = (ra * 0.92) / L;
  const t1 = 1 - (rb * 0.92) / L;
  if (t1 <= t0) return true;
  const steps = Math.max(16, Math.round(L / 2));
  let hits = 0;
  let hole = 0;
  let run = 0;
  for (let s = 0; s <= steps; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    const x = Math.round(a.x + t * (b.x - a.x));
    const y = Math.round(a.y + t * (b.y - a.y));
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (mask[y * w + x]) {
      hits++;
      run = 0;
    } else {
      run++;
      if (run > hole) hole = run;
    }
  }
  const total = steps + 1;
  return hits / total >= 0.97 && hole <= 2;
}

function passesThroughThird(nodes: PNode[], i: number, j: number): boolean {
  const a = nodes[i];
  const b = nodes[j];
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const L2 = sx * sx + sy * sy;
  if (L2 === 0) return false;
  for (let k = 0; k < nodes.length; k++) {
    if (k === i || k === j) continue;
    const t = ((nodes[k].x - a.x) * sx + (nodes[k].y - a.y) * sy) / L2;
    if (t <= 0.08 || t >= 0.92) continue;
    const px = a.x + t * sx;
    const py = a.y + t * sy;
    if (Math.hypot(nodes[k].x - px, nodes[k].y - py) < nodes[k].r * 0.8) return true;
  }
  return false;
}
