/**
 * Generate a Linkr board that is solvable — and, by default, uniquely so.
 *
 *   node --experimental-strip-types --import ./scripts/ts-register.mjs \
 *        scripts/generate.mjs -w 9 -h 9 -k 5 -o board.json
 *
 * Building the board is the easy half: cover the lattice with one Hamiltonian
 * path, cut it into k pieces, keep the endpoints.  The pieces *are* a solution,
 * so the board is solvable by construction and cannot come out broken.
 *
 * Uniqueness is the hard half, and it is not a property of the construction —
 * a random cut is almost never unique (measured: 6/30 at 5x5, 0/30 from 6x6
 * up).  Rather than re-rolling and hoping, `repair()` uses the *second*
 * solution as a counterexample: find a colour whose path differs between the
 * two answers and split it there, adding one colour pair exactly where the
 * alternative routing slipped through.  That converges where blind retry does
 * not (7x7: 8/8 in ~8 splits, versus ~24 rolls to hit one by chance).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { solve } from "../src/solver.ts";

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Square lattice.  `nb` is only used to randomise the Hamiltonian path. */
function lattice(w, h) {
  const edges = [];
  const nb = Array.from({ length: w * h }, () => []);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = y * w + x;
      if (x + 1 < w) {
        edges.push([v, v + 1]);
        nb[v].push(v + 1);
        nb[v + 1].push(v);
      }
      if (y + 1 < h) {
        edges.push([v, v + w]);
        nb[v].push(v + w);
        nb[v + w].push(v);
      }
    }
  return { n: w * h, edges, nb };
}

/** Boustrophedon walk: visits every cell exactly once. */
function snake(w, h) {
  const p = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(y * w + x);
    p.push(...(y % 2 ? row.reverse() : row));
  }
  return p;
}

/**
 * Backbite: pick a neighbour u of the tail, add edge (tail, u), and drop the
 * edge that used to follow u.  The result is still Hamiltonian — it is just the
 * old suffix, reversed — so repeated backbiting randomises the walk without
 * ever breaking it.
 */
function backbite(p, nb, rnd, rounds) {
  const pos = new Map(p.map((v, i) => [v, i]));
  for (let r = 0; r < rounds; r++) {
    const tail = p[p.length - 1];
    const cand = nb[tail].filter((u) => u !== p[p.length - 2]);
    if (!cand.length) continue;
    const u = cand[Math.floor(rnd() * cand.length)];
    const i = pos.get(u);
    const cut = p.splice(i + 1);
    cut.reverse();
    p.push(...cut);
    // after the reverse, cut[k] lands at i+1+k — the pre-reverse index mirrors
    cut.forEach((v, k) => pos.set(v, i + 1 + k));
    pos.set(p[i], i);
  }
  return p;
}

/** Cut a path into k pieces of at least 2 cells.  Null if the cut points collide. */
function cut(p, k, rnd) {
  const L = p.length;
  if (k * 2 > L) return null;
  // a split after index c; c in [2, L-2] keeps first and last pieces >= 2
  const cand = [];
  for (let c = 2; c <= L - 2; c++) cand.push(c);
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  const cuts = [];
  for (const c of cand) {
    if (cuts.length === k - 1) break;
    if (cuts.some((x) => Math.abs(x - c) <= 1)) continue;
    cuts.push(c);
  }
  if (cuts.length !== k - 1) return null;
  cuts.sort((a, b) => a - b);
  const at = [0, ...cuts, L];
  const segs = at.slice(0, -1).map((s, i) => p.slice(s, at[i + 1]));
  return { segs, pairs: segs.map((s) => [s[0], s[s.length - 1]]) };
}

/**
 * Force uniqueness by splitting wherever two answers disagree.
 *
 * Returns `{ ok, pairs, splits, nodes, why }`.  Each split adds one colour, so
 * this always makes progress; the only ways out are a unique board, a board
 * that stopped being satisfiable (should not happen — splitting a path of an
 * existing solution keeps that solution valid), or running out of budget.
 */
async function repair(g, pairs, rnd, maxSplits, timeoutMs) {
  let cur = pairs.map((p) => [...p]);
  for (let splits = 0; splits <= maxSplits; splits++) {
    const r = await solve({
      n: g.n,
      edges: g.edges,
      pairs: cur,
      requireFull: true,
      maxSolutions: 2,
      timeLimitMs: timeoutMs,
      satTimeLimitMs: timeoutMs,
    });
    if (!r.solutions.length) return { ok: false, why: "unsatisfiable", pairs: cur, splits };
    if (r.solutions.length === 1)
      return { ok: true, pairs: cur, splits, nodes: r.nodes, solution: r.solutions[0] };
    const [a, b] = r.solutions;
    const differs = [];
    for (let c = 0; c < a.length; c++) if (String(a[c]) !== String(b[c])) differs.push(c);
    // a piece of 2 or 3 cells cannot be split into two pieces of 2
    const room = differs.filter((c) => a[c].length >= 4);
    if (!room.length) return { ok: false, why: "nowhere left to split", pairs: cur, splits };
    const c = room[Math.floor(rnd() * room.length)];
    const p = a[c];
    const m = 2 + Math.floor(rnd() * (p.length - 3));
    cur.splice(c, 1, [p[0], p[m - 1]], [p[m], p[p.length - 1]]);
  }
  return { ok: false, why: `still not unique after ${maxSplits} splits`, pairs: cur, splits: maxSplits };
}

/** Visually distinct ring colours: golden-angle hue walk. */
function ringColour(i) {
  const h = (i * 137.508) % 360;
  const s = 0.72;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r0, g0, b0] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r0 + m, g0 + m, b0 + m].map((v) => Math.round(v * 255));
}

/** Terminals as letters, plain cells as a middot — enough to eyeball a board. */
function ascii(w, h, pairs) {
  const cell = Array.from({ length: w * h }, () => "·");
  pairs.forEach(([a, b], i) => {
    const ch = String.fromCharCode(65 + (i % 26));
    cell[a] = ch;
    cell[b] = ch;
  });
  const out = [];
  for (let y = 0; y < h; y++) out.push(cell.slice(y * w, y * w + w).join(" "));
  return out.join("\n");
}

export async function generateBoard(opts = {}) {
  const w = opts.width ?? 9;
  const h = opts.height ?? 9;
  const k = opts.colours ?? 5;
  const wantUnique = opts.unique !== false;
  const maxSplits = opts.maxSplits ?? 40;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const seed = opts.seed ?? (Date.now() >>> 0);
  const rnd = mulberry32(seed);

  if (w * h < 2 * k) throw new Error(`${w}x${h} cannot hold ${k} pairs`);
  const g = lattice(w, h);
  const path = backbite(snake(w, h), g.nb, rnd, 40 * g.n);
  const c = cut(path, k, rnd);
  if (!c) throw new Error("could not cut the path into pieces (try fewer colours)");

  const fixed = wantUnique
    ? await repair(g, c.pairs, rnd, maxSplits, timeoutMs)
    : { ok: true, pairs: c.pairs, splits: 0, nodes: 0, solution: c.segs };
  if (!fixed.ok) return { ok: false, why: fixed.why, seed, width: w, height: h };

  const spacing = 100;
  const margin = spacing / 2;
  const pairOf = new Map();
  fixed.pairs.forEach(([a, b], i) => {
    pairOf.set(a, i);
    pairOf.set(b, i);
  });
  return {
    ok: true,
    seed,
    width: w,
    height: h,
    colours: fixed.pairs.length,
    splits: fixed.splits,
    nodes: fixed.nodes,
    label:
      `${w}x${h} square lattice, ${fixed.pairs.length} colours, ` +
      `${wantUnique ? "unique solution" : "solvable"} — generated by scripts/generate.mjs ` +
      `with seed ${seed}`,
    dots: Array.from({ length: g.n }, (_, v) => ({
      x: margin + (v % w) * spacing,
      y: margin + Math.floor(v / w) * spacing,
      r: spacing * 0.3,
      pair: pairOf.get(v) ?? null,
      rgb: pairOf.has(v) ? ringColour(pairOf.get(v)) : null,
    })),
    edges: g.edges,
    pairs: fixed.pairs,
    solution: fixed.solution,
  };
}

// `-w 9` and `--width 9` both work; normalise the short forms once up front.
const ALIAS = { w: "width", h: "height", k: "colours", n: "count", s: "seed", o: "out", q: "quiet" };
const args = process.argv.slice(2).map((a) => {
  const m = /^-([a-z])$/.exec(a);
  return m && ALIAS[m[1]] ? `--${ALIAS[m[1]]}` : a;
});
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

async function main() {
  if (flag("help")) {
    console.error(`Usage: npm run generate -- [options]

  -w, --width N     board width            (default 9)
  -h, --height N    board height           (default 9)
  -k, --colours N   starting colour pairs  (default 5; more are added as needed)
  -n, --count N     how many boards        (default 1)
  -s, --seed N      RNG seed, for a reproducible board
  -o, --out FILE    write JSON here        (default stdout)
      --max-splits  cap on uniqueness splits (default 40)
      --no-unique   skip the repair loop: solvable, probably not unique
  -q, --quiet       no ASCII board or stats on stderr`);
    process.exit(0);
  }
  const quiet = flag("quiet") || flag("q");
  const count = Number(opt("count", opt("n", "1")));
  const out = opt("out", opt("o", null));
  const base = {
    width: Number(opt("width", opt("w", "9"))),
    height: Number(opt("height", opt("h", "9"))),
    colours: Number(opt("colours", opt("k", "5"))),
    unique: !flag("no-unique"),
    maxSplits: Number(opt("max-splits", "40")),
    seed: opt("seed", opt("s", null)) ? Number(opt("seed", opt("s", null))) : undefined,
  };

  // one root seed, so `-n 5` gives five different-but-reproducible boards
  const root = base.seed ?? (Date.now() >>> 0);
  const boards = [];
  let failed = 0;
  for (let i = 0; i < count; i++) {
    const b = await generateBoard({ ...base, seed: root + i });
    if (!b.ok) {
      failed++;
      console.error(`board ${i + 1}: FAILED — ${b.why} (seed ${b.seed})`);
      continue;
    }
    boards.push(b);
    if (!quiet) {
      console.error(
        `#${i + 1} ${b.width}x${b.height} ${b.colours} colours ` +
          `(seed ${b.seed}${b.splits ? `, ${b.splits} splits` : ""}, ${b.nodes} conflicts)`,
      );
      console.error(ascii(b.width, b.height, b.pairs) + "\n");
    }
  }
  const json = JSON.stringify(count === 1 ? boards[0] : boards, null, 1) + "\n";
  if (out) {
    writeFileSync(out, json);
    if (!quiet) console.error(`wrote ${out}`);
  } else {
    process.stdout.write(json);
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
