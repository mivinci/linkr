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

  const r = satSolve({ n, edges, pairs }, 1);
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
  const r = satSolve(g, 1);
  assert.equal(r.status, "unsat", "crossing 4-cycle is unsatisfiable");
  console.log(`ok  ${"unsat-crossing".padEnd(26)} -> UNSAT ${r.ms}ms`);
  pass++;
}

// Board 1 is claimed unique; asking for two must come back with exactly one.
{
  const g = JSON.parse(readFileSync(path.join(fixtures, "board1-square96.json"), "utf8"));
  const r = satSolve(
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
    timeLimitMs: 3000,
    sat: false,
  };
  const r = solve(req);
  assert.equal(r.engine, "dfs", "sat:false uses the search");
  console.log(`ok  ${"dfs-fallback".padEnd(26)} -> ${r.engine}, ${r.nodes} nodes, ${r.ms}ms`);
  pass++;
}

console.log(`\n${pass} passed`);
