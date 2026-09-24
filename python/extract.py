"""Extract a Numberlink puzzle graph from a screenshot.

Pipeline:
  1. dot mask              dark pixels UNION saturated pixels.  The dark part
                           catches plain dots and the connecting lines; the
                           saturated part catches the coloured rings.  The white
                           digit inside a coloured dot is a hole -> filled.
  2. distance transform    dot interiors survive, thin lines do not
  3. connected components  one component per dot -> centre + radius
  4. ring colour           saturated pixels in the outer annulus => the dot is a
                           coloured endpoint; hue => which colour class.  No OCR
                           needed, a colour class is exactly one pair.
  5. segment sampling      two dots are joined iff the straight segment between
                           them is unbroken, minus false positives that pass
                           through a third dot.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage


@dataclass
class Dot:
    x: float
    y: float
    r: float
    color: str | None = None  # None => plain black dot
    hue: float | None = None
    rgb: tuple[int, int, int] | None = None  # median ring colour
    pair: int | None = None  # colour-class id, set by group_pairs()


@dataclass
class Graph:
    dots: list[Dot] = field(default_factory=list)
    edges: list[tuple[int, int]] = field(default_factory=list)
    pairs: list[tuple[int, int]] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "meta": self.meta,
            "dots": [
                {
                    "x": round(d.x, 2),
                    "y": round(d.y, 2),
                    "r": round(d.r, 2),
                    "color": d.color,
                    "rgb": list(d.rgb) if d.rgb else None,
                    "pair": d.pair,
                }
                for d in self.dots
            ],
            "edges": [[a, b] for a, b in self.edges],
            "pairs": [[a, b] for a, b in self.pairs],
        }


# ---------------------------------------------------------------- loading


def load(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (rgb uint8, luminance float, saturation int)."""
    rgb = np.array(Image.open(path).convert("RGB"))
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    sat = rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int)
    return rgb, lum, sat


def fill_small_holes(mask: np.ndarray, max_area: int = 8000) -> np.ndarray:
    """Fill holes smaller than max_area — digit strokes, not board faces."""
    inv = ~mask
    lab, n = ndimage.label(inv)
    if n == 0:
        return mask
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
    sizes = ndimage.sum(np.ones_like(lab, dtype=np.int32), lab, range(1, n + 1))
    lut = np.zeros(n + 1, dtype=bool)
    for i in range(1, n + 1):
        if i not in border and sizes[i - 1] <= max_area:
            lut[i] = True
    return mask | lut[lab]


def build_base_mask(lum: np.ndarray, sat: np.ndarray, thresh: float = 100.0,
                    sat_min: int = 60) -> np.ndarray:
    return (lum < thresh) | (sat > sat_min)


def radius_quantile(dt: np.ndarray, q: float = 0.999) -> float:
    """Robust estimate of the largest solid disk's radius; the dot radius, in px."""
    vals = dt[dt > 0]
    return float(np.quantile(vals, q)) if vals.size else 0.0


def auto_max_hole(base: np.ndarray) -> int:
    """Digit holes are far smaller than a board face, and both scale with the dot
    radius — so size the hole cap relative to the radius, never in absolute px."""
    r = radius_quantile(ndimage.distance_transform_edt(base))
    return int(2.5 * r * r)


def build_mask(lum: np.ndarray, sat: np.ndarray, thresh: float = 100.0,
               sat_min: int = 60, max_hole: int | None = None) -> np.ndarray:
    base = build_base_mask(lum, sat, thresh, sat_min)
    return fill_small_holes(base, max_hole if max_hole else auto_max_hole(base))


# ---------------------------------------------------------------- dots


def dots_from_dt(dist: np.ndarray, min_dist: float) -> list[tuple[float, float, float]]:
    """Centre + radius of every dot, via distance transform peaks."""
    lab, n = ndimage.label(dist >= min_dist)
    out: list[tuple[float, float, float]] = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        sub = lab[sl] == i
        dsub = np.where(sub, dist[sl], 0.0)
        k = np.unravel_index(int(np.argmax(dsub)), dsub.shape)
        out.append((float(sl[1].start + k[1]), float(sl[0].start + k[0]), float(dsub[k])))
    return out


# min_dist as a fraction of the dot radius.  Line pixels never reach much past
# their half-width (~0.1-0.2 of the dot radius), so anything above ~0.3 keeps
# only dot cores.  The ceiling is set by page furniture: on a full game
# screenshot the biggest UI blob reached 0.46 of the dot radius, so 0.45 was too
# tight.  0.6 sits in the middle of that gap, and the core still contains the
# true centre, so the reported radius stays exact.
DOT_SCALES = (0.60, 0.50, 0.45, 0.40, 0.32, 0.25, 0.72)

# Every dot in one of these puzzles is drawn the same size, so anything much
# smaller than the median is page furniture that slipped past the size gate.
OUTLIER_RATIO = 0.65


def drop_outliers(dots: list[tuple[float, float, float]]
                  ) -> tuple[list[tuple[float, float, float]], int]:
    if len(dots) < 3:
        return dots, 0
    rs = np.array([d[2] for d in dots])
    keep = rs >= OUTLIER_RATIO * np.median(rs)
    return [d for d, ok in zip(dots, keep) if ok], int((~keep).sum())


def radius_spread(dots: list[tuple[float, float, float]]) -> float:
    if len(dots) < 3:
        return 1.0
    rs = np.array([d[2] for d in dots])
    return float((np.percentile(rs, 90) - np.percentile(rs, 10)) / max(np.median(rs), 1e-6))


def find_dots(dist: np.ndarray, min_dist: float | None = None
              ) -> tuple[list[tuple[float, float, float]], float]:
    """Pick min_dist from the image itself unless the caller pins it."""
    if min_dist:
        return dots_from_dt(dist, min_dist), float(min_dist)
    dmax = radius_quantile(dist)
    best = None
    for f in DOT_SCALES:
        md = dmax * f
        cand = dots_from_dt(dist, md)
        if len(cand) < 3:
            continue
        spread = radius_spread(cand)
        if best is None or spread < best[2]:
            best = (cand, md, spread)
        if spread <= 0.12:
            return cand, md
    if best is None:
        return [], dmax * DOT_SCALES[0]
    return best[0], best[1]


# ---------------------------------------------------------------- colours

PALETTE: list[tuple[str, float]] = [
    ("red", 0.0),
    ("orange", 30.0),
    ("yellow", 50.0),
    ("green", 120.0),
    ("cyan", 185.0),
    ("blue", 225.0),
    ("purple", 275.0),
    ("magenta", 315.0),
]


def hue_map(rgb: np.ndarray) -> np.ndarray:
    r, g, b = (rgb[:, :, i].astype(float) / 255 for i in range(3))
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    d = mx - mn
    h = np.zeros(d.shape)
    m = d > 0
    idx = m & (mx == r)
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = m & (mx == g)
    h[idx] = ((b - r)[idx] / d[idx]) + 2
    idx = m & (mx == b)
    h[idx] = ((r - g)[idx] / d[idx]) + 4
    return h * 60.0


def classify_colors(rgb: np.ndarray, sat: np.ndarray, hue: np.ndarray, dots: list[Dot],
                    sat_min: int = 60, ring_lo: float = 0.72,
                    ring_hi: float = 1.0, cover: float = 0.55) -> None:
    """Set dot.color / dot.hue / dot.rgb in place: saturated outer annulus => endpoint."""
    h, w = sat.shape
    for d in dots:
        yy, xx = np.mgrid[max(0, int(d.y - d.r - 4)):min(h, int(d.y + d.r + 5)),
                          max(0, int(d.x - d.r - 4)):min(w, int(d.x + d.r + 5))]
        rr = np.hypot(xx - d.x, yy - d.y)
        ann = (rr > d.r * ring_lo) & (rr <= d.r * ring_hi)
        if ann.sum() == 0:
            continue
        on = ann & (sat[yy, xx] > sat_min)
        if on.sum() / ann.sum() < cover:
            continue
        rgb_med = np.median(rgb[yy, xx][on].astype(float), axis=0)
        hue_med = float(np.median(hue[yy, xx][on]))
        d.rgb = (int(rgb_med[0]), int(rgb_med[1]), int(rgb_med[2]))
        d.hue = hue_med
        d.color = name_hue(hue_med)


def group_pairs(dots: list[Dot], rgb_tol: float = 70.0) -> list[tuple[int, int]]:
    """Cluster coloured dots into classes by ring colour; returns the class members."""
    idx = [i for i, d in enumerate(dots) if d.rgb]
    classes: list[list[int]] = []
    for i in idx:
        c = np.array(dots[i].rgb, dtype=float)
        for cl in classes:
            ref = np.array(dots[cl[0]].rgb, dtype=float)
            if np.linalg.norm(c - ref) < rgb_tol:
                cl.append(i)
                break
        else:
            classes.append([i])
    counts: dict[str, int] = {}
    for n, cl in enumerate(classes):
        for i in cl:
            name = dots[i].color or "?"
            counts[name] = counts.get(name, 0) + 1
            dots[i].pair = n
    return [tuple(cl) for cl in classes]


def hue_dist(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return min(d, 360 - d)


def name_hue(h: float) -> str:
    return str(min(PALETTE, key=lambda p: hue_dist(h, p[1]))[0])


# ---------------------------------------------------------------- edges

# How far outside a dot body the segment probe starts, in units of its radius.
# Must stay above 1.0: the rim is where anti-aliasing and a pale dot's
# mask-negative body produce notches.  Must stay well below 1.3 or the window
# shrinks to the point where `t1 <= t0` short-circuits the pixel test entirely.
PAD = 1.10


def find_edges(mask: np.ndarray, dots: list[Dot], ratio: float = 1.9,
               fill: float = 0.97) -> list[tuple[int, int]]:
    """`ratio` is a cap on how far apart two dots may be, in units of the median
    nearest-neighbour distance.  It only limits the candidate set for speed: the
    pixel test decides.  It must stay above the longest real edge (a 45 degree
    diagonal is 1.41x the grid step) and can safely sit below 2.0x, where the
    two-step collinear pairs live — those are rejected as pass-throughs."""
    n = len(dots)
    if n < 2:
        return []
    pts = np.array([[d.x, d.y] for d in dots])
    rad = np.array([d.r for d in dots])
    dmat = np.hypot(pts[:, 0][:, None] - pts[:, 0][None, :],
                    pts[:, 1][:, None] - pts[:, 1][None, :])
    np.fill_diagonal(dmat, np.inf)
    limit = float(np.median(np.min(dmat, axis=1))) * ratio

    edges: list[tuple[int, int]] = []
    for i in range(n):
        for j in range(i + 1, n):
            if dmat[i, j] > limit:
                continue
            if not segment_is_line(mask, pts[i], pts[j], rad[i], rad[j], fill):
                continue
            if passes_through_third(pts, rad, i, j):
                continue
            edges.append((i, j))
    return edges


def segment_profile(mask: np.ndarray, a: np.ndarray, b: np.ndarray, ra: float,
                    rb: float) -> tuple[float, int]:
    """Sample the segment between two dots, strictly outside both bodies.

    Returns `(fill, hole)`: the fraction of samples that landed on line pixels,
    and the longest consecutive run of misses.  The window starts `PAD` radii
    out from each centre — probing *inside* a body (a factor below 1.0) only
    works while the body happens to be mask-positive, and a pale dot is bright
    and unsaturated, so its body falls out of the mask and leaves a few-pixel
    notch right at the rim.
    """
    seg = b - a
    L = float(np.hypot(*seg))
    if L <= ra + rb:
        return 1.0, 0
    t0, t1 = ra * PAD / L, 1 - rb * PAD / L
    if t1 <= t0:
        return 1.0, 0
    steps = max(16, int(L / 2))
    ts = np.linspace(t0, t1, steps + 1)
    xs = np.clip(np.round(a[0] + ts * seg[0]).astype(int), 0, mask.shape[1] - 1)
    ys = np.clip(np.round(a[1] + ts * seg[1]).astype(int), 0, mask.shape[0] - 1)
    hit = mask[ys, xs]
    hole = run = 0
    for v in hit:
        if v:
            run = 0
        else:
            run += 1
            hole = max(hole, run)
    return float(hit.mean()), hole


def segment_is_line(mask: np.ndarray, a: np.ndarray, b: np.ndarray, ra: float,
                    rb: float, fill: float = 0.97) -> bool:
    """True when the segment between two dot bodies is unbroken line pixels."""
    f, hole = segment_profile(mask, a, b, ra, rb)
    # a real edge is an unbroken run; allow one short anti-aliasing notch
    return f >= fill and hole <= 2


def complete_edges(mask: np.ndarray, dots: list[Dot], edges: list[tuple[int, int]],
                   ratio: float = 1.35, floor: float = 0.5
                   ) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """Add back edges the pixel test dropped but the board's structure demands.

    A covered Numberlink vertex needs two edges and a terminal needs one, so a
    vertex left below that is a recognition failure, not a board feature.  Only
    such vertices are repaired, and only with the best-scoring neighbour close
    enough to be lattice-adjacent — not with a blanket "everything one step
    apart is an edge", which would invent edges on boards that really do have
    gaps.  Returns `(all_edges, added)`.
    """
    n = len(dots)
    if n < 2:
        return list(edges), []
    pts = np.array([[d.x, d.y] for d in dots])
    rad = np.array([d.r for d in dots])
    dmat = np.hypot(pts[:, 0][:, None] - pts[:, 0][None, :],
                    pts[:, 1][:, None] - pts[:, 1][None, :])
    np.fill_diagonal(dmat, np.inf)
    limit = float(np.median(np.min(dmat, axis=1))) * ratio

    have = {(min(a, b), max(a, b)) for a, b in edges}
    deg = [0] * n
    for a, b in edges:
        deg[a] += 1
        deg[b] += 1
    need = [1 if d.pair is not None else 2 for d in dots]

    out = list(edges)
    added: list[tuple[int, int]] = []
    stuck: set[int] = set()
    while True:
        v = None
        for u in range(n):
            if u in stuck or deg[u] >= need[u]:
                continue
            if v is None or deg[u] - need[u] < deg[v] - need[v]:
                v = u
        if v is None:
            break
        best = None
        for u in range(n):
            if u == v:
                continue
            key = (min(v, u), max(v, u))
            if key in have or dmat[v, u] > limit:
                continue
            if passes_through_third(pts, rad, v, u):
                continue
            f, _ = segment_profile(mask, pts[v], pts[u], rad[v], rad[u])
            if f < floor:
                continue
            if best is None or f > best[0]:
                best = (f, key)
        if best is None:
            stuck.add(v)
            continue
        key = best[1]
        have.add(key)
        out.append(key)
        added.append(key)
        deg[key[0]] += 1
        deg[key[1]] += 1
    return out, added


def passes_through_third(pts: np.ndarray, rad: np.ndarray, i: int, j: int) -> bool:
    a, b = pts[i], pts[j]
    seg = b - a
    L2 = float(seg @ seg)
    if L2 == 0:
        return False
    for k in range(len(pts)):
        if k in (i, j):
            continue
        t = float((pts[k] - a) @ seg) / L2
        if not (0.08 < t < 0.92):
            continue
        proj = a + t * seg
        if np.hypot(*(pts[k] - proj)) < rad[k] * 0.8:
            return True
    return False


# ---------------------------------------------------------------- driver


def extract(path: str, thresh: float = 100.0, sat_min: int = 60,
            min_dist: float | None = None, ratio: float = 1.9,
            max_hole: int | None = None) -> Graph:
    rgb, lum, sat = load(path)
    base = build_base_mask(lum, sat, thresh, sat_min)
    mask = build_mask(lum, sat, thresh, sat_min, max_hole)
    dist = ndimage.distance_transform_edt(mask)
    found, md = find_dots(dist, min_dist)
    found, dropped = drop_outliers(found)
    dots = [Dot(x, y, r) for x, y, r in found]
    classify_colors(rgb, sat, hue_map(rgb), dots, sat_min)
    pairs = group_pairs(dots)
    edges, inferred = complete_edges(mask, dots, find_edges(mask, dots, ratio))
    spread = radius_spread(found)
    return Graph(dots=dots, edges=edges, pairs=[p for p in pairs if len(p) == 2],
                 meta={"radius": round(radius_quantile(dist), 1),
                       "min_dist": round(md, 1),
                       "max_hole": max_hole or auto_max_hole(base),
                       "spread": round(spread, 3),
                       "dropped": dropped,
                       "inferred": len(inferred)})


def write(graph: Graph, path: str) -> None:
    with open(path, "w") as f:
        json.dump(graph.to_json(), f, indent=2)
