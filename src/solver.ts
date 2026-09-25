import { satSolve } from "./sat";

/**
 * Numberlink on a graph: split every vertex into vertex-disjoint paths, one per
 * colour class, each path joining the two terminals of its class.  Edges are
 * used at most once.  With requireFull every vertex must be covered, so a plain
 * vertex ends up with degree 2 and a terminal with degree 1.
 *
 * Strategy: every colour is started at its terminal up front and all paths grow
 * *simultaneously* — each step extends whichever head has the fewest legal
 * moves.  Growing one path all the way to its target before touching the next
 * one blows up on a 100-dot board (60s, 2M nodes); interleaving solves the same
 * board in 535 nodes, because a doomed partial configuration is usually visible
 * while every path is still short.
 *
 * Pruning after every move:
 *   terminals   - a path may never route through another colour's terminal, or
 *                 that terminal would end up with degree 2
 *   degree      - a residual vertex must keep enough edges to be traversable.
 *                 Strict mode only: with requireFull off a vertex may simply
 *                 be left out, so the floor would reject legitimate answers.
 *   reachability- every head must still be able to reach its own target
 *   components  - a residual component with no head and no target is dead, and
 *                 a head may not be cut off from its target
 */
export interface SolveRequest {
  n: number;
  edges: [number, number][];
  pairs: [number, number][];
  requireFull: boolean;
  maxSolutions: number;
  timeLimitMs: number;
  /** Retries with a shuffled colour numbering when the first pass fails. */
  restarts?: number;
  /** Node cap per attempt, so a doomed ordering is abandoned early. */
  nodeBudget?: number;
  /** Record the order in which the winning solution was grown, for playback. */
  trace?: boolean;
  /** Set false to force the DFS search and skip the SAT engine. */
  sat?: boolean;
}

export interface SolveResult {
  solutions: number[][][];
  nodes: number;
  ms: number;
  timedOut: boolean;
  /** (colour, vertex) appended in the order the solver actually grew them. */
  trace?: [number, number][];
  /** How many colour orderings were tried before this one succeeded. */
  attempts?: number;
  /** Which engine produced this result. */
  engine?: "sat" | "dfs";
  /** Lazy cycle cuts, SAT only. */
  cuts?: number;
  /** The trace is a replay of the answer, not a recording of the search. */
  syntheticTrace?: boolean;
}

/** First message to a fresh worker: hand it the SAT engine. */
export interface WorkerInit {
  wasmB64: string;
}

export interface WorkerRequest extends SolveRequest {
  id: number;
}

export interface WorkerResponse extends SolveResult {
  id: number;
  error?: string;
}

/**
 * Try the SAT engine first.  It is complete and finishes real boards in
 * milliseconds, so when it applies there is nothing to gain from the DFS.  It
 * only covers `requireFull` — the degree floor in the encoding *is* the
 * coverage constraint — so relaxed requests fall through.  So does anything
 * else the engine cannot handle (no wasm, encoding refused): the caller still
 * gets an answer from the search below.
 */
function solveSatAttempt(req: SolveRequest): SolveResult | null {
  if (req.sat === false || !req.requireFull) return null;
  const r = satSolve({ n: req.n, edges: req.edges, pairs: req.pairs }, Math.max(1, req.maxSolutions));
  if (r.status === "unavailable") return null;
  const out: SolveResult = {
    solutions: r.solutions,
    nodes: r.conflicts,
    ms: r.ms,
    timedOut: false,
    attempts: 1,
    engine: "sat",
    cuts: r.cuts,
  };
  if (req.trace && r.solutions.length) {
    out.trace = spreadTrace(r.solutions[0]);
    out.syntheticTrace = true;
  }
  return out;
}

/**
 * Cap on the opening search when a trace was asked for.  Small enough that a
 * board the search cannot finish is handed to SAT while still feeling instant,
 * generous enough that the boards it *can* finish — the common case — keep a
 * genuine derivation.
 */
const DEMO_BUDGET_MS = 1200;
const DEMO_RESTARTS = 8;

/**
 * Give the search first go when the caller wants a trace.
 *
 * A SAT answer has no growth order attached to it: the solver decides variables,
 * it does not walk paths.  Since the algorithm demo replays exactly that order,
 * an answer and its trace have to come from the same run — so when a trace is
 * wanted the search gets a bounded shot at it, and only if that fails does SAT
 * take over (with a replayed rather than recorded order; see `syntheticTrace`).
 */
function solveForDemo(req: SolveRequest): SolveResult | null {
  if (!req.trace || !req.requireFull || req.sat === false) return null;
  const budget = Math.min(req.timeLimitMs, DEMO_BUDGET_MS);
  const r = solveRestarting({ ...req, maxSolutions: 1, timeLimitMs: budget }, DEMO_RESTARTS);
  return r.solutions.length ? { ...r, engine: "dfs" } : null;
}

/**
 * Stand-in growth order for a SAT answer: the colours take turns advancing one
 * vertex at a time.  Not how the solver found it — SAT found nothing step by
 * step — but it is how a person would draw the answer, and it is labelled as a
 * replay wherever it is shown.
 */
function spreadTrace(paths: number[][]): [number, number][] {
  const out: [number, number][] = [];
  const longest = paths.reduce((m, p) => Math.max(m, p.length), 0);
  for (let i = 1; i < longest; i++) {
    for (let c = 0; c < paths.length; c++) {
      if (i < paths[c].length) out.push([c, paths[c][i]]);
    }
  }
  return out;
}

export function solve(req: SolveRequest): SolveResult {
  const demo = solveForDemo(req);
  if (demo) return demo;
  const s = solveSatAttempt(req);
  if (s) return s;
  const restarts = req.restarts ?? 0;
  if (restarts > 0) return { ...solveRestarting(req, restarts), engine: "dfs" };
  return { ...solveOnce(req, req.timeLimitMs, 0), engine: "dfs" };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What the search is actually sensitive to is the *colour numbering*, not the
 * move order and not the vertex indices: shuffling adjacency lists or
 * renumbering vertices changes nothing, while permuting the pair list takes a
 * board from "over a million nodes and still stuck" to "11k nodes".  So the
 * retries permute the colours and map the answer back afterwards.
 */
function solveRestarting(req: SolveRequest, restarts: number): SolveResult {
  const end = Date.now() + req.timeLimitMs;
  const attempts = restarts + 1;
  const rnd = mulberry32(12345);
  const total: SolveResult = { solutions: [], nodes: 0, ms: 0, timedOut: false };
  const t0 = Date.now();

  for (let a = 0; a < attempts; a++) {
    const left = end - Date.now();
    if (left <= 0) break;
    const slice = Math.min(left, Math.max(50, req.timeLimitMs / attempts));

    let pairs = req.pairs;
    let perm: number[] | null = null;
    if (a > 0) {
      perm = req.pairs.map((_, i) => i);
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      pairs = perm.map((i) => req.pairs[i]);
    }

    const st = solveOnce({ ...req, pairs }, slice, req.nodeBudget ?? 0);
    total.nodes += st.nodes;
    total.attempts = a + 1;
    if (st.solutions.length) {
      total.solutions = perm
        ? st.solutions.map((paths) => {
            const back: number[][] = paths.map(() => []);
            for (let c = 0; c < paths.length; c++) back[perm![c]] = paths[c];
            return back;
          })
        : st.solutions;
      if (st.trace) {
        total.trace = perm ? st.trace.map(([c, v]) => [perm![c], v] as [number, number]) : st.trace;
      }
      total.timedOut = false;
      total.ms = Date.now() - t0;
      return total;
    }
    if (!st.timedOut) {
      total.timedOut = false;
      total.ms = Date.now() - t0;
      return total; // exhausted: genuinely unsolvable
    }
    total.timedOut = true;
  }
  total.ms = Date.now() - t0;
  return total;
}

function solveOnce(req: SolveRequest, timeLimitMs: number, nodeBudget: number): SolveResult {
  const { n, edges, pairs, requireFull, maxSolutions } = req;
  const k = pairs.length;
  const result: SolveResult = { solutions: [], nodes: 0, ms: 0, timedOut: false };
  if (k === 0) return result;

  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }

  // a terminal must end up with degree 1, so no path may pass through it
  const owner = new Int32Array(n).fill(-1);
  for (let c = 0; c < k; c++) {
    owner[pairs[c][0]] = c;
    owner[pairs[c][1]] = c;
  }

  // Hop count to each colour's target.  Trying the step that lands closest to
  // the target first is a big win where it works (1326 -> 68 nodes on a 62-dot
  // board); it is not a magic bullet, some boards still defeat plain DFS.
  const hop: Int32Array[] = [];
  for (let c = 0; c < k; c++) {
    const d = new Int32Array(n).fill(0x3fff_ffff);
    const t = pairs[c][1];
    d[t] = 0;
    let frontier: number[] = [t];
    while (frontier.length) {
      const next: number[] = [];
      for (const w of frontier) {
        for (const v of adj[w]) {
          if (d[v] === 0x3fff_ffff) {
            d[v] = d[w] + 1;
            next.push(v);
          }
        }
      }
      frontier = next;
    }
    hop.push(d);
  }

  const usedV = new Uint8Array(n);
  const usedE = new Set<number>();
  const paths: number[][] = pairs.map((p) => [p[0]]);
  for (let c = 0; c < k; c++) usedV[pairs[c][0]] = 1;
  const deadline = Date.now() + timeLimitMs;
  const ek = (a: number, b: number) => (a < b ? a * n + b : b * n + a);

  const avail = new Uint8Array(n);
  const isEndpoint = new Uint8Array(n);
  const comp = new Int32Array(n);
  const hasEndpoint = new Uint8Array(n + 1);
  const res: number[][] = Array.from({ length: n }, () => []);
  const open: number[] = [];

  // Every accepted extension, in the order it happened.  At the moment a
  // solution is recorded this stack *is* the winning derivation, so a snapshot
  // of it replays the search exactly.
  const wantTrace = req.trace === true;
  const traceStack: [number, number][] = [];

  /** Colours whose head has not reached its target yet. */
  function heads(): void {
    open.length = 0;
    for (let c = 0; c < k; c++) {
      if (paths[c][paths[c].length - 1] !== pairs[c][1]) open.push(c);
    }
  }

  function residualOk(): boolean {
    for (let w = 0; w < n; w++) avail[w] = usedV[w] ? 0 : 1;
    isEndpoint.fill(0);
    for (const c of open) {
      const h = paths[c][paths[c].length - 1];
      avail[h] = 1;
      isEndpoint[h] = 1;
      isEndpoint[pairs[c][1]] = 1;
    }

    for (let w = 0; w < n; w++) {
      res[w].length = 0;
      if (!avail[w]) continue;
      for (const v of adj[w]) {
        if (avail[v] && !usedE.has(ek(w, v))) res[w].push(v);
      }
    }

    // The degree floor IS the coverage constraint: an unused plain vertex
    // still needing two edges is only a failure when every vertex has to be
    // covered.  Applying it in relaxed mode rejects legitimate partial
    // solutions and silently turns the relaxed mode into the strict one.
    if (requireFull) {
      for (let w = 0; w < n; w++) {
        if (!avail[w]) continue;
        if (res[w].length < (isEndpoint[w] ? 1 : 2)) return false;
      }
    }

    if (!requireFull) {
      for (const c of open) {
        if (!reachable(paths[c][paths[c].length - 1], pairs[c][1])) return false;
      }
      return true;
    }

    const seen = new Uint8Array(n);
    let ncomp = 0;
    const stack: number[] = [];
    for (let s = 0; s < n; s++) {
      if (!avail[s] || seen[s]) continue;
      seen[s] = 1;
      comp[s] = ncomp;
      stack.push(s);
      while (stack.length) {
        const w = stack.pop()!;
        for (const v of res[w]) {
          if (!seen[v]) {
            seen[v] = 1;
            comp[v] = ncomp;
            stack.push(v);
          }
        }
      }
      ncomp++;
    }

    hasEndpoint.fill(0, 0, ncomp);
    for (const c of open) {
      const h = paths[c][paths[c].length - 1];
      if (comp[h] !== comp[pairs[c][1]]) return false;
      hasEndpoint[comp[h]] = 1;
    }
    for (let i = 0; i < ncomp; i++) if (!hasEndpoint[i]) return false;
    return true;
  }

  function reachable(src: number, dst: number): boolean {
    const visited = new Uint8Array(n);
    const stack = [src];
    visited[src] = 1;
    while (stack.length) {
      const w = stack.pop()!;
      if (w === dst) return true;
      for (const v of res[w]) {
        if (!visited[v]) {
          visited[v] = 1;
          stack.push(v);
        }
      }
    }
    return false;
  }

  function grow(): boolean {
    result.nodes++;
    if ((nodeBudget > 0 && result.nodes > nodeBudget) ||
        (result.nodes % 2048 === 0 && Date.now() > deadline)) {
      result.timedOut = true;
      return true;
    }

    heads();
    if (open.length === 0) {
      result.solutions.push(paths.map((p) => p.slice()));
      if (wantTrace && !result.trace) result.trace = traceStack.slice();
      return result.solutions.length >= maxSolutions;
    }

    // most constrained head first: it is the one that fails fastest.
    // These must be locals: recursion re-enters grow() and would clobber them.
    const choices: { count: number; color: number }[] = [];
    for (const c of open) {
      const h = paths[c][paths[c].length - 1];
      let count = 0;
      for (const v of adj[h]) {
        if (usedV[v] || usedE.has(ek(h, v))) continue;
        if (owner[v] >= 0 && owner[v] !== c) continue;
        count++;
      }
      if (count === 0) return false;
      choices.push({ count, color: c });
    }
    choices.sort((a, b) => a.count - b.count || a.color - b.color);
    const c = choices[0].color;
    const path = paths[c];
    const h = path[path.length - 1];

    const moves: number[] = [];
    for (const v of adj[h]) {
      if (usedV[v] || usedE.has(ek(h, v))) continue;
      if (owner[v] >= 0 && owner[v] !== c) continue;
      moves.push(v);
    }

    const target = pairs[c][1];
    moves.sort(
      (a, b) =>
        (a === target ? 0 : 1) - (b === target ? 0 : 1) || hop[c][a] - hop[c][b],
    );

    for (const v of moves) {
      const key = ek(h, v);
      path.push(v);
      if (wantTrace) traceStack.push([c, v]);
      usedV[v] = 1;
      usedE.add(key);

      heads();
      const stop = residualOk() && grow();
      if (stop) return true;

      usedE.delete(key);
      usedV[v] = 0;
      path.pop();
      if (wantTrace) traceStack.pop();
    }
    return false;
  }

  const t0 = Date.now();
  heads();
  if (residualOk()) grow();
  result.ms = Date.now() - t0;
  return result;
}
