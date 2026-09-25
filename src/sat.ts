/**
 * Numberlink as SAT, solved by `sat/` (batsat compiled to wasm).
 *
 * Encoding B — two families of variables instead of one per (edge, colour):
 *
 *   x[w][c]  vertex w carries colour c          (n·k vars)
 *   y[j]     edge j is used                     (m vars)
 *
 * The naive encoding gives every (edge, colour) pair its own variable, so a
 * degree-2 cap over a vertex of degree d explodes into C(k·d, 3) clauses.  Here
 * the degree cap sits on the `y` variables alone, which is only C(d, 3), and
 * colour agreement is two ternary clauses per (edge, colour).  On the real
 * boards that is ~1.1k vars / 8.3k clauses instead of ~1.2M clauses, and it is
 * the difference between "solves in 8 ms" and "runs until the heap dies".
 *
 * Degree + colour agreement already force every colour subgraph to be a
 * disjoint union of paths-with-terminals and *pure cycles*, so the only thing
 * left to rule out is a cycle.  Those are cut lazily: solve, find a component
 * that contains no terminal of its colour, forbid it, re-solve.  Real boards
 * need zero cuts — the constraint graph leaves no room for a cycle — but the
 * loop keeps the encoding complete for hand-built boards that do.
 *
 * Requires `requireFull`: the degree floor *is* the coverage constraint, so the
 * relaxed mode needs a different encoding.  Callers fall back to DFS there.
 */

export interface SatGraph {
  n: number;
  edges: [number, number][];
  pairs: [number, number][];
}

export const SAT_SAT = 10;
export const SAT_UNSAT = 20;
export const SAT_UNKNOWN = 0;

/** One solution: `solutions[i]` is the vertex path of colour i, endpoint first. */
export interface SatResult {
  status: "sat" | "unsat" | "unavailable";
  solutions: number[][][];
  conflicts: number;
  ms: number;
  /** Lazy cycle cuts the solver actually needed. */
  cuts: number;
  error?: string;
}

interface Exports {
  memory: WebAssembly.Memory;
  sat_reset(nvars: number): void;
  sat_buf(len: number): number;
  sat_add(len: number): number;
  sat_solve(): number;
  sat_model_ptr(): number;
  sat_model_len(): number;
  sat_conflicts(): number;
}

let instance: Exports | null = null;
let unavailable: string | null = null;
let binary: Uint8Array<ArrayBuffer> | null = null;

/**
 * Hand the module its bytes.  The wasm lives in the *main* chunk as a base64
 * string and is passed to the worker by message; importing it from `sat.ts`
 * instead would put a copy inside the inlined worker bundle as well, and 79 kB
 * of base64 is not worth having twice.
 */
export function satSetBinary(b64: string): void {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    binary = bytes;
    unavailable = null;
  } catch (err) {
    unavailable = String(err);
  }
}

/**
 * The wasm keeps one solver in a mutable static, so it is *not* reentrant:
 * never overlap two `satSolve` calls.  The UI awaits them one at a time.
 */
function load(): Exports | null {
  if (instance) return instance;
  if (unavailable) return null;
  if (!binary) {
    unavailable = "sat: no wasm binary handed to satSetBinary()";
    return null;
  }
  try {
    const bytes = binary;
    // No imports: the module needs nothing from the host, which is what lets it
    // be inlined into a `file://` page.  Compiled synchronously so `satSolve`
    // can stay a plain function — 60 kB takes about a millisecond.
    const module = new WebAssembly.Module(bytes);
    instance = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    return instance;
  } catch (err) {
    unavailable = String(err);
    return null;
  }
}

export function satAvailable(): boolean {
  return load() !== null;
}

export function satUnavailableReason(): string | null {
  return unavailable;
}

/**
 * Solve for up to `maxSolutions` distinct solutions.  Distinctness is exact
 * here, not a heuristic: the `y` variables *are* the edge set, so forbidding a
 * previous assignment leaves only genuinely different answers — no need to
 * compare paths modulo reversal.
 */
export function satSolve(g: SatGraph, maxSolutions = 1, maxCuts = 64): SatResult {
  const e = load();
  const empty: SatResult = {
    status: "unavailable",
    solutions: [],
    conflicts: 0,
    ms: 0,
    cuts: 0,
    error: unavailable ?? "wasm not loaded",
  };
  if (!e) return empty;

  const t0 = Date.now();
  const { n, edges, pairs } = g;
  const m = edges.length;
  const k = pairs.length;
  if (k === 0 || m === 0) return { ...empty, status: "unsat" };

  const X = (w: number, c: number) => w * k + c + 1;
  const Y = (j: number) => n * k + j + 1;
  const nvars = n * k + m;

  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let j = 0; j < m; j++) {
    adj[edges[j][0]].push(j);
    adj[edges[j][1]].push(j);
  }
  const owner = new Int32Array(n).fill(-1);
  for (let c = 0; c < k; c++) {
    owner[pairs[c][0]] = c;
    owner[pairs[c][1]] = c;
  }

  // ---- static constraints -------------------------------------------------
  const clauses: number[][] = [];
  // every vertex carries exactly one colour
  for (let w = 0; w < n; w++) {
    const one: number[] = [];
    for (let c = 0; c < k; c++) {
      one.push(X(w, c));
      for (let d = c + 1; d < k; d++) clauses.push([-X(w, c), -X(w, d)]);
    }
    clauses.push(one);
  }
  // terminals are pinned
  for (let c = 0; c < k; c++) {
    clauses.push([X(pairs[c][0], c)]);
    clauses.push([X(pairs[c][1], c)]);
  }
  // a used edge joins two vertices of the same colour
  for (let j = 0; j < m; j++) {
    for (let c = 0; c < k; c++) {
      clauses.push([-Y(j), -X(edges[j][0], c), X(edges[j][1], c)]);
      clauses.push([-Y(j), -X(edges[j][1], c), X(edges[j][0], c)]);
    }
  }
  // degree: exactly 1 at a terminal, exactly 2 elsewhere
  for (let w = 0; w < n; w++) {
    const inc = adj[w];
    if (owner[w] >= 0) {
      clauses.push(inc.map(Y));
      for (let a = 0; a < inc.length; a++) {
        for (let b = a + 1; b < inc.length; b++) clauses.push([-Y(inc[a]), -Y(inc[b])]);
      }
    } else {
      // at least one, plus "if j is used then something else is too" — together
      // "at least two", in d+1 clauses instead of the C(d,2) naive version.
      clauses.push(inc.map(Y));
      for (const j of inc) clauses.push([-Y(j), ...inc.filter((o) => o !== j).map(Y)]);
      for (let a = 0; a < inc.length; a++) {
        for (let b = a + 1; b < inc.length; b++) {
          for (let c = b + 1; c < inc.length; c++) {
            clauses.push([-Y(inc[a]), -Y(inc[b]), -Y(inc[c])]);
          }
        }
      }
    }
  }

  const push = (cl: number[]): void => {
    const p = e.sat_buf(cl.length);
    // Re-create the view after the (allocating) call above: wasm memory may
    // have grown and stale views do not follow it.
    new Int32Array(e.memory.buffer, p, cl.length).set(cl);
    e.sat_add(cl.length);
  };

  const solutions: number[][][] = [];
  let status: SatResult["status"] = "unsat";
  let cuts = 0;

  for (let round = 0; round < maxSolutions + maxCuts; round++) {
    e.sat_reset(nvars);
    for (const cl of clauses) push(cl);

    const r = e.sat_solve();
    const conflicts = Number(e.sat_conflicts());
    if (r !== SAT_SAT) {
      // Reaching UNSAT here is only a failure if nothing was found yet; after
      // the first solution it is the proof that there is no second one.
      status = solutions.length ? "sat" : r === SAT_UNSAT ? "unsat" : "unavailable";
      return { status, solutions, conflicts, ms: Date.now() - t0, cuts };
    }

    const len = e.sat_model_len();
    const model = new Int32Array(e.memory.buffer, e.sat_model_ptr(), len);
    const isTrue = (v: number) => model[v - 1] > 0;

    // ---- components of each colour's used subgraph ------------------------
    const blocked: number[][] = [];
    for (let c = 0; c < k; c++) {
      const parent = new Int32Array(n);
      for (let w = 0; w < n; w++) parent[w] = w;
      const find = (a: number): number => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]];
          a = parent[a];
        }
        return a;
      };
      const used: number[] = [];
      for (let j = 0; j < m; j++) {
        if (!isTrue(Y(j))) continue;
        if (!isTrue(X(edges[j][0], c)) || !isTrue(X(edges[j][1], c))) continue;
        used.push(j);
        const ra = find(edges[j][0]);
        const rb = find(edges[j][1]);
        if (ra !== rb) parent[ra] = rb;
      }
      const groups = new Map<number, number[]>();
      for (const j of used) {
        const root = find(edges[j][0]);
        const g = groups.get(root);
        if (g) g.push(j);
        else groups.set(root, [j]);
      }
      const [ta, tb] = pairs[c];
      for (const js of groups.values()) {
        const verts = new Set<number>();
        for (const j of js) {
          verts.add(edges[j][0]);
          verts.add(edges[j][1]);
        }
        if (verts.has(ta) || verts.has(tb)) continue;
        // A cycle saturates the degree of every vertex on it, so no other edge
        // can attach — forbidding all of these edges together only ever rules
        // out the cycle itself, never a legal path through the same vertices.
        blocked.push(js.map((j) => -Y(j)));
      }
    }

    if (blocked.length) {
      for (const cl of blocked) clauses.push(cl);
      cuts += blocked.length;
      continue;
    }

    const paths = extract(g, isTrue, X, Y);
    if (!paths) {
      // Should not happen: degree + agreement + no cycle leaves no other shape.
      status = "unsat";
      return { status, solutions, conflicts, ms: Date.now() - t0, cuts };
    }
    solutions.push(paths);
    if (solutions.length >= maxSolutions) {
      status = "sat";
      return { status, solutions, conflicts, ms: Date.now() - t0, cuts };
    }
    // forbid exactly this edge set and look for another
    const forbid: number[] = [];
    for (let j = 0; j < m; j++) forbid.push(isTrue(Y(j)) ? -Y(j) : Y(j));
    clauses.push(forbid);
  }

  return {
    status: solutions.length ? "sat" : "unsat",
    solutions,
    conflicts: Number(e.sat_conflicts()),
    ms: Date.now() - t0,
    cuts,
  };
}

/** Walk each colour's used subgraph from one terminal to the other. */
function extract(
  g: SatGraph,
  isTrue: (v: number) => boolean,
  X: (w: number, c: number) => number,
  Y: (j: number) => number,
): number[][] | null {
  const { n, edges, pairs } = g;
  const k = pairs.length;
  const out: number[][] = [];
  for (let c = 0; c < k; c++) {
    const nbr = new Map<number, number[]>();
    for (let j = 0; j < edges.length; j++) {
      if (!isTrue(Y(j))) continue;
      const [a, b] = edges[j];
      if (!isTrue(X(a, c)) || !isTrue(X(b, c))) continue;
      if (!nbr.has(a)) nbr.set(a, []);
      if (!nbr.has(b)) nbr.set(b, []);
      nbr.get(a)!.push(b);
      nbr.get(b)!.push(a);
    }
    const [ta, tb] = pairs[c];
    if ((nbr.get(ta)?.length ?? 0) !== 1) return null;
    const path = [ta];
    let prev = -1;
    let cur = ta;
    while (cur !== tb) {
      const next = (nbr.get(cur) ?? []).filter((v) => v !== prev);
      if (next.length !== 1) return null;
      prev = cur;
      cur = next[0];
      path.push(cur);
    }
    out.push(path);
  }
  const flat = out.flat();
  if (flat.length !== n || new Set(flat).size !== n) return null;
  return out;
}
