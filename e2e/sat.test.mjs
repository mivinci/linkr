/**
 * The SAT engine against the two boards that motivated it: board 2 is the
 * triangle lattice the DFS search cannot finish at all.
 *
 * Run with: node --experimental-strip-types --import ./e2e/ts-register.mjs e2e/sat.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { satSetBinary, satSolve } from "../src/sat.ts";
import { SAT_WASM_BASE64 } from "../src/sat.wasm.ts";

const here = import.meta.dirname;
const fixtures = path.join(here, "fixtures");

// The app seeds this from main.ts / the worker's first message; a test has to
// do it by hand.
satSetBinary(SAT_WASM_BASE64);

/** A solution is k vertex-disjoint paths, each joining its own terminal pair. */
function assertValid(g, paths) {
  const n = g.dots.length;
  assert.equal(paths.length, g.pairs.length, "one path per colour");
  const seen = new Map();
  for (let c = 0; c < g.pairs.length; c++) {
    const p = paths[c];
    assert.deepEqual([p[0], p[p.length - 1]], g.pairs[c], `colour ${c} endpoints`);
    for (let i = 0; i < p.length; i++) {
      assert.equal(seen.has(p[i]), false, `vertex ${p[i]} visited twice`);
      seen.set(p[i], c);
      if (i > 0) {
        const a = Math.min(p[i - 1], p[i]);
        const b = Math.max(p[i - 1], p[i]);
        assert.ok(
          g.edges.some((e) => Math.min(e[0], e[1]) === a && Math.max(e[0], e[1]) === b),
          `edge ${a}-${b} exists`,
        );
      }
    }
  }
  assert.equal(seen.size, n, `coverage ${seen.size}/${n}`);
}

let pass = 0;
for (const file of ["board1-square96.json", "board2-triangle64.json"]) {
  const g = JSON.parse(readFileSync(path.join(fixtures, file), "utf8"));
  const n = g.dots.length;
  const edges = g.edges.map((e) => [e[0], e[1]]);
  const pairs = g.pairs.map((p) => [p[0], p[1]]);

  const r = await satSolve({ n, edges, pairs }, 1);
  assert.equal(r.status, "sat", `${file}: ${r.status} ${r.error ?? ""}`);
  assert.ok(r.solutions.length >= 1, `${file}: got a solution`);
  assertValid(g, r.solutions[0]);
  console.log(
    `ok  ${file.padEnd(26)} ${n} dots / ${edges.length} edges / ${pairs.length} colours ` +
      `-> SAT ${r.ms}ms, ${r.conflicts} conflicts, ${r.cuts} cuts`,
  );
  pass++;
}

// An impossible board must come back UNSAT rather than timing out.
{
  // Two colours whose terminals are the same four vertices in a crossing
  // arrangement on a 2x2 grid: no vertex-disjoint paths exist.
  const g = {
    n: 4,
    edges: [[0, 1], [1, 3], [3, 2], [2, 0]],
    pairs: [[0, 3], [1, 2]],
  };
  const r = await satSolve(g, 1);
  assert.equal(r.status, "unsat", "crossing 4-cycle is unsatisfiable");
  console.log(`ok  ${"unsat-crossing".padEnd(26)} -> UNSAT ${r.ms}ms`);
  pass++;
}

// Board 1 is claimed unique; asking for two must come back with exactly one.
{
  const g = JSON.parse(readFileSync(path.join(fixtures, "board1-square96.json"), "utf8"));
  const r = await satSolve(
    { n: g.dots.length, edges: g.edges.map((e) => [e[0], e[1]]), pairs: g.pairs.map((p) => [p[0], p[1]]) },
    2,
  );
  assert.equal(r.status, "sat");
  assert.equal(r.solutions.length, 1, "board 1 has exactly one solution");
  console.log(`ok  ${"unique-board1".padEnd(26)} -> 1 solution, ${r.ms}ms`);
  pass++;
}

// The DFS fallback path still works: `sat: false` must not touch the engine.
{
  const { solve } = await import("../src/solver.ts");
  const g = JSON.parse(readFileSync(path.join(fixtures, "board2-triangle64.json"), "utf8"));
  const req = {
    n: g.dots.length,
    edges: g.edges.map((e) => [e[0], e[1]]),
    pairs: g.pairs.map((p) => [p[0], p[1]]),
    requireFull: true,
    maxSolutions: 1,
    timeLimitMs: 2000,
    sat: false,
  };
  const r = await solve(req);
  assert.equal(r.engine, "dfs", "sat:false uses the search");
  // This board is why the SAT engine exists: the search needs ~2.5M nodes
  // (~26s here) to crack it, against ~170k reachable in 2s, and the solver
  // answers it in 9 conflicts.  The margin is wide, but it is wall-clock, so
  // a failure here means "re-measure", not necessarily "broken".
  assert.equal(r.timedOut, true, "board 2 outruns the search budget");
  assert.equal(r.solutions.length, 0, "and yields nothing within it");
  console.log(`ok  ${"dfs-fallback".padEnd(26)} -> ${r.engine}, ${r.nodes} nodes, timed out`);
  pass++;
}

// Scheduling.  A request that wants a trace lets the search try first, so the
// boards it can finish keep a genuine derivation; the ones it cannot still end
// up on SAT — but then the trace is only a replay, and has to say so.
{
  const { solve } = await import("../src/solver.ts");
  const load = (f) => {
    const g = JSON.parse(readFileSync(path.join(fixtures, f), "utf8"));
    return {
      n: g.dots.length,
      edges: g.edges.map((e) => [e[0], e[1]]),
      pairs: g.pairs.map((p) => [p[0], p[1]]),
    };
  };
  const demo = (g) => ({
    ...g,
    requireFull: true,
    maxSolutions: 1,
    timeLimitMs: 20000,
    restarts: 64,
    nodeBudget: 12000,
    trace: true,
  });

  const easy = await solve(demo(load("board1-square96.json")));
  assert.equal(easy.engine, "dfs", "board 1: the search is fast enough to keep a real trace");
  assert.ok(easy.trace && easy.trace.length > 0, "board 1: trace recorded");
  assert.equal(easy.syntheticTrace, undefined, "board 1: trace is not a replay");
  console.log(`ok  ${"schedule-easy".padEnd(26)} -> dfs, ${easy.nodes} nodes, ${easy.ms}ms, real trace`);
  pass++;

  const hard = await solve(demo(load("board2-triangle64.json")));
  assert.equal(hard.engine, "sat", "board 2: search gives up, SAT takes over");
  assert.equal(hard.syntheticTrace, true, "board 2: trace is flagged as a replay");
  console.log(`ok  ${"schedule-hard".padEnd(26)} -> sat, ${hard.nodes} conflicts, ${hard.ms}ms, replay`);
  pass++;

  // Uniqueness carries no trace, so it goes straight to SAT even on an easy
  // board — that is the part that turns into a proof instead of a timeout.
  const uniq = await solve({
    ...load("board1-square96.json"),
    requireFull: true,
    maxSolutions: 2,
    timeLimitMs: 10000,
    restarts: 8,
    nodeBudget: 12000,
  });
  assert.equal(uniq.engine, "sat", "uniqueness always runs on SAT");
  assert.equal(uniq.solutions.length, 1, "board 1 is unique");
  console.log(`ok  ${"schedule-uniqueness".padEnd(26)} -> sat, 1 solution, ${uniq.ms}ms`);
  pass++;
}

// ------------------------------------------------- interruption
// A board nothing can decide is the reason the engine needs limits at all:
// without them this call never returns, and on a file:// page the solver runs
// on the main thread, so the whole page dies with it.
{
  const hard = JSON.parse(readFileSync(path.join(fixtures, "hard-square400.json"), "utf8"));
  const g = { n: hard.n, edges: hard.edges, pairs: hard.pairs };

  const t = Date.now();
  const r = await satSolve(g, 1, 64, { deadlineMs: 800 });
  const wall = Date.now() - t;
  assert.equal(r.status, "unknown", "a board neither engine can decide must come back unknown");
  assert.ok(r.conflicts > 0, "and report how far it got");
  assert.ok(wall < 800 + 1200, `gave up within the budget: ${wall}ms`);
  console.log(`ok  ${"deadline".padEnd(26)} -> unknown, ${r.conflicts} conflicts, ${wall}ms wall`);
  pass++;

  // A cancel has to land between chunks, not at the end of the search.
  const stopAt = Date.now() + 300;
  const seen = [];
  const t2 = Date.now();
  const c = await satSolve(g, 1, 64, {
    deadlineMs: 60000,
    shouldStop: () => Date.now() >= stopAt,
    onProgress: (n) => seen.push(n),
  });
  const wall2 = Date.now() - t2;
  assert.equal(c.status, "unknown", "shouldStop interrupts the search");
  assert.ok(wall2 < 2000, `cancelled promptly: ${wall2}ms`);
  assert.ok(seen.length >= 1, "progress was reported between chunks");
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] >= seen[i - 1], "conflict count does not go backwards");
  console.log(`ok  ${"cancel".padEnd(26)} -> unknown, ${seen.length} chunks, ${wall2}ms wall`);
  pass++;

  // Chunking must not change an answer: force a chunk every ~1 ms.
  for (const f of ["board1-square96.json", "board2-triangle64.json"]) {
    const b = JSON.parse(readFileSync(path.join(fixtures, f), "utf8"));
    const whole = await satSolve(
      { n: b.dots.length, edges: b.edges.map((e) => [e[0], e[1]]), pairs: b.pairs.map((p) => [p[0], p[1]]) },
      1,
    );
    const sliced = await satSolve(
      { n: b.dots.length, edges: b.edges.map((e) => [e[0], e[1]]), pairs: b.pairs.map((p) => [p[0], p[1]]) },
      1,
      64,
      { chunkMs: 1 },
    );
    assert.equal(sliced.status, whole.status, `${f}: chunking changed the verdict`);
    assert.deepEqual(sliced.solutions, whole.solutions, `${f}: chunking changed the answer`);
    console.log(`ok  ${`chunked-${f.split("-")[0]}`.padEnd(26)} -> ${sliced.status}, ${sliced.conflicts} conflicts`);
    pass++;
  }

  // `solve` must not hand an undecided board to the DFS: if SAT could not
  // decide it in ten seconds the search will not decide it in twenty either.
  const { solve } = await import("../src/solver.ts");
  const r2 = await solve({
    ...g,
    requireFull: true,
    maxSolutions: 1,
    timeLimitMs: 5000,
    restarts: 4,
    nodeBudget: 12000,
    satTimeLimitMs: 700,
  });
  assert.equal(r2.engine, "sat", "an undecided board stays with the engine that tried");
  assert.equal(r2.timedOut, true, "and is reported as undecided, not as unsolvable");
  assert.equal(r2.solutions.length, 0, "with no answer attached");
  console.log(`ok  ${"no-dfs-fallback".padEnd(26)} -> ${r2.engine}, timedOut, ${r2.nodes} conflicts`);
  pass++;
}

console.log(`\n${pass} passed`);
