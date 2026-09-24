/**
 * Solver unit test — no browser.  Feeds the solver graphs extracted by the
 * Python reference implementation and checks the solutions are legal.
 *
 *   node --experimental-strip-types e2e/solver.test.mjs
 */
import { readFileSync } from "node:fs";
import { solve } from "../src/solver.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));
let failed = 0;

for (const [name, g] of Object.entries(fixtures)) {
  // `requireFull: false` opts a fixture into relaxed mode, where a vertex with
  // too few edges may simply stay uncovered instead of failing the board.
  const requireFull = g.requireFull !== false;
  const t0 = Date.now();
  const res = solve({
    n: g.n,
    edges: g.edges,
    pairs: g.pairs,
    requireFull,
    maxSolutions: 1,
    timeLimitMs: 30000,
  });
  const ms = Date.now() - t0;
  if (!res.solutions.length) {
    console.log(
      `${name} [${requireFull ? "full" : "relaxed"}]: NO SOLUTION  ` +
        `nodes=${res.nodes} ${ms}ms timedOut=${res.timedOut}`,
    );
    failed++;
    continue;
  }
  const paths = res.solutions[0];
  const flat = paths.flat();
  const problems = [];
  if (new Set(flat).size !== flat.length) problems.push("a vertex is used twice");
  // Coverage is only a requirement in strict mode; relaxed mode is allowed to
  // leave vertices out, and that is precisely what the relaxed-leaf board tests.
  if (requireFull && new Set(flat).size !== g.n)
    problems.push(`coverage ${new Set(flat).size}/${g.n}`);
  for (let c = 0; c < g.pairs.length; c++) {
    const p = paths[c];
    const [a, b] = g.pairs[c];
    if (!p) problems.push(`pair ${c} missing`);
    else if (!((p[0] === a && p[p.length - 1] === b) || (p[0] === b && p[p.length - 1] === a)))
      problems.push(`pair ${c} not joined`);
  }
  const used = new Set();
  for (const p of paths) {
    for (let i = 0; i + 1 < p.length; i++) {
      const k = p[i] < p[i + 1] ? `${p[i]}-${p[i + 1]}` : `${p[i + 1]}-${p[i]}`;
      if (used.has(k)) problems.push(`edge ${k} reused`);
      used.add(k);
    }
  }
  if (problems.length) failed++;
  console.log(
    `${name} [${requireFull ? "full" : "relaxed"}]: nodes=${res.nodes} ${ms}ms ` +
      `paths=${paths.length} covered=${new Set(flat).size}/${g.n} ` +
      (problems.length ? `FAIL ${problems.join("; ")}` : "ok"),
  );
}

console.log(failed ? `RESULT: FAILED (${failed})` : "RESULT: PASSED");
process.exit(failed ? 1 : 0);
