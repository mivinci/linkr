/**
 * Edge-extraction unit test — no browser.  Exercises `completeEdges`, the
 * structural fallback that adds back edges the pixel test dropped.
 *
 *   node --experimental-strip-types e2e/vision.test.mjs
 */
import { completeEdges } from "../src/vision.ts";

let failed = 0;

function check(name, cond, detail = "") {
  if (!cond) failed++;
  console.log(`${name}: ${cond ? "ok" : "FAIL"}${detail ? ` — ${detail}` : ""}`);
}

/** 2x2 lattice, spacing 100, dot radius 30, on a `w` x `h` mask. */
function lattice() {
  return [
    { x: 100, y: 100, r: 30, pair: null, rgb: null },
    { x: 200, y: 100, r: 30, pair: null, rgb: null },
    { x: 100, y: 200, r: 30, pair: null, rgb: null },
    { x: 200, y: 200, r: 30, pair: null, rgb: null },
  ];
}

function maskFilled(w, h) {
  return new Uint8Array(w * h).fill(1);
}

function poke(mask, w, x0, x1, y0, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 0;
}

const W = 300;
const H = 300;

// 1. A single dropped edge next to an under-connected corner comes back.
{
  const nodes = lattice();
  const edges = [
    { a: 0, b: 2 },
    { a: 1, b: 3 },
    { a: 2, b: 3 },
  ];
  const mask = maskFilled(W, H);
  // a narrow notch across 0-1: enough to fail the pixel test, not enough to
  // read as "there is no line here at all"
  poke(mask, W, 148, 152, 90, 110);
  const added = completeEdges(mask, nodes, edges, 100, W, H);
  const has = edges.some((e) => e.a === 0 && e.b === 1);
  check("dropped edge is restored", added === 1 && has, `added=${added}`);
  check("restored edge is flagged", edges.find((e) => e.a === 0 && e.b === 1)?.inferred === true);
}

// 2. A blank mask has nothing to restore from — no invented edges.
{
  const nodes = lattice();
  const edges = [
    { a: 0, b: 2 },
    { a: 2, b: 3 },
  ];
  const mask = new Uint8Array(W * H);
  const added = completeEdges(mask, nodes, edges, 100, W, H);
  check("blank mask invents nothing", added === 0, `added=${added}`);
}

// 3. Every vertex already meets its degree floor — nothing to do.
{
  const nodes = lattice();
  const edges = [
    { a: 0, b: 1 },
    { a: 0, b: 2 },
    { a: 1, b: 3 },
    { a: 2, b: 3 },
  ];
  const mask = maskFilled(W, H);
  const added = completeEdges(mask, nodes, edges, 100, W, H);
  check("satisfied board is untouched", added === 0, `added=${added}`);
}

// 4. A terminal needs only one edge.  With every plain vertex already satisfied
//    the lone terminal gets exactly one back — not two.
{
  const nodes = lattice();
  nodes[0].pair = 0; // terminal
  const edges = [
    { a: 1, b: 2 },
    { a: 1, b: 3 },
    { a: 2, b: 3 },
  ];
  const mask = maskFilled(W, H);
  const added = completeEdges(mask, nodes, edges, 100, W, H);
  const deg = [0, 0, 0, 0];
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  check("terminal stops at one edge", added === 1 && deg[0] === 1, `added=${added} deg0=${deg[0]}`);
}

// 5. A plain vertex needs two, and will take them from whoever scores best —
//    which may give a terminal a second edge along the way.
{
  const nodes = lattice();
  nodes[0].pair = 0; // terminal
  const edges = [
    { a: 1, b: 3 },
    { a: 2, b: 3 },
  ];
  const mask = maskFilled(W, H);
  const added = completeEdges(mask, nodes, edges, 100, W, H);
  const deg = [0, 0, 0, 0];
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  check("plain vertices reach two", deg[1] >= 2 && deg[2] >= 2 && deg[3] >= 2,
    `deg=${deg.join(",")} added=${added}`);
}

console.log(failed ? `RESULT: FAILED (${failed})` : "RESULT: PASSED");
process.exit(failed ? 1 : 0);
