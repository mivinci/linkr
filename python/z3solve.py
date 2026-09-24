"""Independent solvability check with z3.

The DFS in solve.py is fast on the boards it likes and hopeless on the ones it
does not, which makes it useless for telling "my extraction is wrong" apart from
"this board is just hard".  This module encodes the same problem as SAT and is
run *before* the search:

    unsat    - no solution exists at all.  Every screenshot we care about comes
               from a real level, so this almost always means the extracted
               graph is wrong (a missing edge, a mismatched colour pair).
    sat      - a solution exists, and the model hands back the actual paths.
    unknown  - z3 timed out; fall back to the DFS and report honestly.

Encoding: one unit of flow per colour from its terminal to its partner, edges
shared by at most one colour, every vertex used at most (or exactly) once, plus
a "distance along the path" counter per colour that makes cycles impossible.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from z3 import And, Bool, If, Implies, Int, Not, Solver, Sum, is_true, sat, unknown

from extract import Graph

# z3 returns one of sat / unsat / unknown
SAT, UNSAT, UNKNOWN = "sat", "unsat", "unknown"


@dataclass
class Z3Result:
    status: str = ""
    paths: list[list[int]] = field(default_factory=list)
    seconds: float = 0.0


def solve_z3(graph: Graph, require_full: bool = True,
             timeout_ms: int = 60000) -> Z3Result:
    n = len(graph.dots)
    pairs = [tuple(p) for p in graph.pairs]
    k = len(pairs)
    out = Z3Result()
    if k == 0:
        out.status = UNSAT
        return out

    adj: list[list[int]] = [[] for _ in range(n)]
    dirs: list[tuple[int, int]] = []
    for a, b in graph.edges:
        adj[a].append(b)
        adj[b].append(a)
        dirs.append((a, b))
        dirs.append((b, a))

    owner = [-1] * n
    for c, (a, b) in enumerate(pairs):
        owner[a] = c
        owner[b] = c

    t0 = time.monotonic()
    s = Solver()
    s.set("timeout", timeout_ms)

    x = {(c, u, v): Bool(f"x_{c}_{u}_{v}") for c in range(k) for (u, v) in dirs}
    r = {(c, w): Int(f"r_{c}_{w}") for c in range(k) for w in range(n)}

    # a colour may not traverse an edge both ways
    for c in range(k):
        for (u, v) in graph.edges:
            s.add(Not(And(x[(c, u, v)], x[(c, v, u)])))

    # an edge carries at most one colour
    for (u, v) in graph.edges:
        s.add(Sum([If(x[(c, u, v)], 1, 0) for c in range(k)]
                  + [If(x[(c, v, u)], 1, 0) for c in range(k)]) <= 1)

    for c in range(k):
        sc, tc = pairs[c]
        s.add(r[(c, sc)] == 0)
        for w in range(n):
            s.add(r[(c, w)] >= 0, r[(c, w)] <= n)
        for w in range(n):
            out_c = Sum([If(x[(c, w, v)], 1, 0) for v in adj[w]])
            in_c = Sum([If(x[(c, v, w)], 1, 0) for v in adj[w]])

            if w == sc:
                s.add(out_c == 1, in_c == 0)
            elif w == tc:
                s.add(in_c == 1, out_c == 0)
            else:
                s.add(out_c == in_c)

            # the path may not wander through another colour's terminal,
            # and no other colour may touch this one's terminal
            if owner[w] >= 0:
                for d in range(k):
                    if d == c or d == owner[w]:
                        continue
                    s.add(Sum([If(x[(d, w, v)], 1, 0) for v in adj[w]]) == 0)

            # no cycles: distance along the path has to strictly increase
            for v in adj[w]:
                s.add(Implies(x[(c, w, v)], r[(c, v)] == r[(c, w)] + 1))

        # every vertex is entered by exactly one colour (or at most one)
        for w in range(n):
            if owner[w] >= 0:
                continue
            used = Sum([If(x[(c, w, v)], 1, 0) for c in range(k) for v in adj[w]])
            s.add(used == 1 if require_full else used <= 1)

    res = s.check()
    out.seconds = time.monotonic() - t0

    if res == unknown or res is None:
        out.status = UNKNOWN
        return out
    if res != sat:
        out.status = UNSAT
        return out

    model = s.model()
    used = set()
    for c in range(k):
        for (u, v) in dirs:
            if is_true(model.eval(x[(c, u, v)], model_completion=True)):
                used.add((c, u, v))
    out.status = SAT
    out.paths = [_walk(c, pairs[c], used, adj) for c in range(k)]
    return out


def _walk(c: int, terminals: tuple[int, int], used: set,
          adj: list[list[int]]) -> list[int]:
    s, t = terminals
    path = [s]
    guard = 0
    while path[-1] != t and guard <= len(adj) + 2:
        guard += 1
        nxt = [v for v in adj[path[-1]] if (c, path[-1], v) in used]
        if not nxt:
            break
        path.append(nxt[0])
    return path
