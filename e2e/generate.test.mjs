/**
 * The generator, checked against the solver rather than against itself.
 *
 * `repair()` declares a board unique because *it* could not find a second
 * solution — which is only worth as much as the solver doing the asking.  So
 * these assertions re-derive everything from the emitted board.
 *
 * Run with: node --experimental-strip-types --import ./scripts/ts-register.mjs e2e/generate.test.mjs
 */
import assert from "node:assert/strict";
import { generateBoard } from "../scripts/generate.mjs";
import { solve } from "../src/solver.ts";

let pass = 0;

const check = (b, wantUnique) => {
  const n = b.dots.length;
  const pairOf = new Map();
  b.pairs.forEach(([a, c], i) => {
    pairOf.set(a, i);
    pairOf.set(c, i);
  });
  assert.equal(pairOf.size, b.pairs.length * 2, "every colour has exactly two terminals");
  const adjacent = (x, y) => b.edges.some(([p, q]) => (p === x && q === y) || (p === y && q === x));

  // the answer key must be a real answer: vertex-disjoint paths covering the
  // whole board, each one a walk along lattice edges, ending on its terminals
  const seen = new Set();
  b.pairs.forEach(([a, c], i) => {
    const p = b.solution[i];
    assert.ok(p, `colour ${i} has no path`);
    assert.ok(
      (p[0] === a && p[p.length - 1] === c) || (p[0] === c && p[p.length - 1] === a),
      `colour ${i} does not join its terminals ${a}..${c}`,
    );
    for (let j = 0; j < p.length; j++) {
      assert.ok(!seen.has(p[j]), `vertex ${p[j]} used twice`);
      seen.add(p[j]);
      if (j) assert.ok(adjacent(p[j - 1], p[j]), `colour ${i}: ${p[j - 1]}->${p[j]} is not an edge`);
    }
  });
  assert.equal(seen.size, n, `answer key covers ${seen.size}/${n} cells`);

  // and the solver, asked cold, must agree
  const r = solve({
    n,
    edges: b.edges,
    pairs: b.pairs,
    requireFull: true,
    maxSolutions: 2,
    timeLimitMs: 20000,
    satTimeLimitMs: 20000,
  });
  return r;
};

{
  const b = await generateBoard({ width: 7, height: 7, colours: 5, seed: 1 });
  assert.ok(b.ok, `generation failed: ${b.why}`);
  const r = await check(b, true);
  assert.equal(r.solutions.length, 1, `expected a unique solution, got ${r.solutions.length}`);
  console.log(
    `ok  ${"unique-7x7".padEnd(26)} -> ${b.colours} colours after ${b.splits} splits, ` +
      `cold solve agrees (${r.nodes} conflicts)`,
  );
  pass++;
}

{
  // the same seed must give the same board: a generator you cannot reproduce is
  // a generator you cannot debug
  const a = await generateBoard({ width: 6, height: 6, colours: 4, seed: 777 });
  const b = await generateBoard({ width: 6, height: 6, colours: 4, seed: 777 });
  assert.equal(JSON.stringify(a.pairs), JSON.stringify(b.pairs), "same seed, same board");
  assert.equal(JSON.stringify(a.solution), JSON.stringify(b.solution), "and the same answer key");
  console.log(`ok  ${"reproducible".padEnd(26)} -> seed 777 twice, identical`);
  pass++;
}

{
  // --no-unique skips the repair loop: still solvable, not claimed unique
  const b = await generateBoard({ width: 7, height: 7, colours: 6, seed: 3, unique: false });
  assert.ok(b.ok, `generation failed: ${b.why}`);
  assert.equal(b.splits, 0, "no splits when uniqueness is not asked for");
  const r = await check(b, false);
  assert.ok(r.solutions.length >= 1, "solvable by construction, so at least one answer");
  console.log(
    `ok  ${"solvable-only".padEnd(26)} -> ${b.colours} colours, ${r.solutions.length} solution(s)`,
  );
  pass++;
}

console.log(`\n${pass} passed`);
