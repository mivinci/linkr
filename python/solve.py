"""Linkr on a graph.

Partition every vertex into vertex-disjoint paths, one path per colour class,
each path joining the two terminals of that class.  Every edge is used at most
once.  With require_full=True every vertex must be covered, so a plain vertex
has degree 2 in the solution and a terminal has degree 1.

Strategy: every colour is started at its terminal up front and all paths grow
*simultaneously* — each step extends whichever head has the fewest legal moves.
Growing one path all the way to its target before touching the next one blows up
on a 100-dot board; interleaving fails fast instead, because a doomed partial
configuration is usually visible while every path is still short.

Pruning after every move:
  * terminals   - a path may never route through another colour's terminal, or
                  that terminal would end up with degree 2
  * degree      - a residual vertex must keep enough edges to be traversable
  * reachability- every head must still be able to reach its own target
  * components  - a residual component that contains no head and no target is
                  dead, and a head may not be cut off from its target
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

from extract import Graph


@dataclass
class Solution:
    paths: list[list[int]]  # one vertex list per colour class
    full: bool


@dataclass
class Stats:
    nodes: int = 0
    seconds: float = 0.0
    solutions: list[Solution] = field(default_factory=list)
    timed_out: bool = False


class _Reordered:
    """Same board, same colours, different colour numbering.

    `perm[c]` is the original colour id now sitting at index c, so a solution
    produced here has to be permuted back before it is handed to the caller —
    otherwise path c silently describes the wrong colour.
    """

    def __init__(self, dots, edges, pairs, perm):
        self.dots = dots
        self.edges = edges
        self.pairs = pairs
        self.perm = perm


def _unshuffle(st: Stats, perm: list[int]) -> Stats:
    fixed: list[Solution] = []
    for sol in st.solutions:
        back: list[list[int]] = [[] for _ in perm]
        for c, path in enumerate(sol.paths):
            back[perm[c]] = path
        fixed.append(Solution(paths=back, full=sol.full))
    st.solutions = fixed
    return st


def _solve_restarting(graph: Graph, require_full: bool, time_limit: float,
                      max_solutions: int, node_budget: int | None,
                      restarts: int, order: str = "greedy") -> Stats:
    """Try the plain order first, then reshuffles, sharing one time budget.

    What matters is the *colour numbering*, not the move order or the vertex
    indexing: shuffling adjacency lists or renumbering vertices changes nothing,
    while permuting the pair list takes a board from "over a million nodes and
    still stuck" to "11k nodes" on the fourth try.
    """
    end = time.monotonic() + time_limit
    acc = Stats()
    rng = random.Random(12345)
    for attempt in range(restarts + 1):
        left = end - time.monotonic()
        if left <= 0:
            break
        slice_s = min(left, max(0.05, time_limit / (restarts + 1)))
        g = graph
        perm: list[int] | None = None
        if attempt:
            perm = list(range(len(graph.pairs)))
            rng.shuffle(perm)
            g = _Reordered(graph.dots, graph.edges,
                           [graph.pairs[i] for i in perm], perm)
        st = solve(
            g,
            require_full,
            slice_s,
            max_solutions,
            seed=None,
            node_budget=node_budget,
            order=order,
        )
        acc.nodes += st.nodes
        acc.seconds += st.seconds
        if st.solutions:
            if perm is not None:
                st = _unshuffle(st, perm)
            acc.solutions = st.solutions
            acc.timed_out = False
            return acc
        if not st.timed_out:
            return st  # search space exhausted: genuinely unsolvable
    acc.timed_out = True
    return acc


def solve(graph: Graph, require_full: bool = True, time_limit: float = 30.0,
          max_solutions: int = 1, seed: int | None = None,
          node_budget: int | None = None, restarts: int = 0,
          order: str = "greedy") -> Stats:
    # Some boards are extremely sensitive to the order the moves are tried in:
    # the same 100-dot lattice took 433 nodes with one set of terminals and over
    # a million with another.  "greedy" steps onto the target when it can and
    # otherwise prefers the smallest hop count; it is what the web solver does
    # and it costs 20x fewer nodes than "adj" on the 62-dot boards (68 vs
    # 1326).  "adj" is kept as the plain baseline.  The default matches
    # _solve_restarting -- the two must not disagree, or adding restarts
    # silently changes the search order.
    if restarts:
        return _solve_restarting(graph, require_full, time_limit, max_solutions,
                                 node_budget, restarts, order)
    n = len(graph.dots)
    pairs = [tuple(p) for p in graph.pairs]
    k = len(pairs)
    st = Stats()
    if k == 0:
        return st

    adj: list[list[int]] = [[] for _ in range(n)]
    for a, b in graph.edges:
        adj[a].append(b)
        adj[b].append(a)
    if seed is not None or order == "random":
        rng = random.Random(seed if seed is not None else 0)
        for v in range(n):
            rng.shuffle(adj[v])

    # a terminal must end up with degree 1, so no path may pass through it
    owner = [-1] * n
    for c, (a, b) in enumerate(pairs):
        owner[a] = c
        owner[b] = c

    used_v = [False] * n
    used_e: set[tuple[int, int]] = set()
    paths: list[list[int]] = [[p[0]] for p in pairs]
    for c in range(k):
        used_v[pairs[c][0]] = True
    deadline = time.monotonic() + time_limit

    # "greedy" tries the step that lands closest to the target first
    hop: list[dict[int, int]] | None = None
    if order == "greedy":
        hop = []
        for sc, tc in pairs:
            dist = {tc: 0}
            frontier = [tc]
            while frontier:
                nxt = []
                for w in frontier:
                    for v in adj[w]:
                        if v not in dist:
                            dist[v] = dist[w] + 1
                            nxt.append(v)
                frontier = nxt
            hop.append(dist)

    def edge_key(a: int, b: int) -> tuple[int, int]:
        return (a, b) if a < b else (b, a)

    def heads() -> list[int]:
        return [c for c in range(k) if paths[c][-1] != pairs[c][1]]

    def residual_ok(open_cols: list[int]) -> bool:
        avail = [not u for u in used_v]
        endpoints = set()
        for c in open_cols:
            h = paths[c][-1]
            avail[h] = True
            endpoints.add(h)
            endpoints.add(pairs[c][1])

        res: list[list[int]] = [[] for _ in range(n)]
        for w in range(n):
            if not avail[w]:
                continue
            for v in adj[w]:
                if avail[v] and edge_key(w, v) not in used_e:
                    res[w].append(v)

        # The degree floor IS the coverage constraint: an unused plain vertex
        # still needing two edges is only a failure when every vertex has to be
        # covered.  Applying it without require_full rejects legitimate partial
        # solutions and silently turns the relaxed mode into the strict one.
        if require_full:
            for w in range(n):
                if not avail[w]:
                    continue
                if len(res[w]) < (1 if w in endpoints else 2):
                    return False

        if not require_full:
            return _all_reachable(res, open_cols)

        comp = [-1] * n
        ncomp = 0
        for s in range(n):
            if not avail[s] or comp[s] >= 0:
                continue
            stack = [s]
            comp[s] = ncomp
            while stack:
                w = stack.pop()
                for v in res[w]:
                    if comp[v] < 0:
                        comp[v] = ncomp
                        stack.append(v)
            ncomp += 1

        has_endpoint = [False] * ncomp
        for c in open_cols:
            if comp[paths[c][-1]] != comp[pairs[c][1]]:
                return False
            has_endpoint[comp[paths[c][-1]]] = True
        return all(has_endpoint)

    def _all_reachable(res: list[list[int]], open_cols: list[int]) -> bool:
        for c in open_cols:
            src, dst = paths[c][-1], pairs[c][1]
            seen = {src}
            stack = [src]
            while stack:
                w = stack.pop()
                for v in res[w]:
                    if v not in seen:
                        seen.add(v)
                        stack.append(v)
            if dst not in seen:
                return False
        return True

    def record() -> None:
        st.solutions.append(Solution(paths=[list(p) for p in paths],
                                     full=all(used_v)))

    def grow() -> bool:
        """Return True when the search should unwind (enough solutions found)."""
        st.nodes += 1
        if node_budget is not None and st.nodes > node_budget:
            st.timed_out = True
            return True
        if st.nodes % 2048 == 0 and time.monotonic() > deadline:
            st.timed_out = True
            return True

        open_cols = heads()
        if not open_cols:
            record()
            return len(st.solutions) >= max_solutions

        # most constrained head first: it is the one that fails fastest
        choices = []
        for c in open_cols:
            h = paths[c][-1]
            moves = [v for v in adj[h]
                     if not used_v[v] and edge_key(h, v) not in used_e
                     and (owner[v] < 0 or owner[v] == c)]
            if not moves:
                return False
            choices.append((len(moves), c, moves))
        # MRV picks the most constrained head.  When a seed is set we pick a
        # random head instead — without that, restarts all explore nearly the
        # same tree, because the move counts (and therefore the winner) do not
        # change just because the adjacency lists were shuffled.
        if seed is None and order != "random":
            choices.sort(key=lambda x: (x[0], x[1]))
        else:
            rng.shuffle(choices)

        _, c, moves = choices[0]
        h = paths[c][-1]
        t = pairs[c][1]
        if order == "greedy" and hop is not None:
            moves.sort(key=lambda v: (0 if v == t else 1, hop[c].get(v, 99)))
        elif order == "random":
            rng.shuffle(moves)

        for v in moves:
            paths[c].append(v)
            used_v[v] = True
            used_e.add(edge_key(h, v))
            if residual_ok(heads()) and grow():
                return True
            used_e.discard(edge_key(h, v))
            used_v[v] = False
            paths[c].pop()
        return False

    t0 = time.monotonic()
    if residual_ok(heads()):
        grow()
    st.seconds = time.monotonic() - t0
    return st
