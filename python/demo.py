"""End-to-end: screenshot -> graph -> solution -> rendered answer.

    uv run python demo.py <image> [--out out/]
"""

from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw

from extract import Graph, extract, write
from solve import solve
from z3solve import solve_z3

FALLBACK = [(230, 60, 60), (60, 110, 230), (30, 170, 90), (0, 170, 200),
            (150, 60, 220), (230, 160, 20), (20, 110, 60), (220, 60, 160)]


def render(src: str, g: Graph, paths: list[list[int]], dst: str, alpha: int = 210) -> None:
    im = Image.open(src).convert("RGB").copy()
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for c, path in enumerate(paths):
        rgb = g.dots[path[0]].rgb or FALLBACK[c % len(FALLBACK)]
        pts = [(g.dots[i].x, g.dots[i].y) for i in path]
        d.line(pts, fill=(*rgb, alpha), width=30, joint="curve")
        for i in path:
            dot = g.dots[i]
            d.ellipse((dot.x - dot.r + 12, dot.y - dot.r + 12,
                       dot.x + dot.r - 12, dot.y + dot.r - 12), fill=(*rgb, alpha))
    Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB").save(dst)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--out", default="out")
    ap.add_argument("--full", action="store_true", default=True,
                    help="require every dot to be covered (default)")
    ap.add_argument("--no-full", dest="full", action="store_false")
    ap.add_argument("--limit", type=float, default=30.0)
    ap.add_argument("--solutions", type=int, default=1)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    g = extract(args.image)
    write(g, os.path.join(args.out, "graph.json"))
    print(f"dots={len(g.dots)} edges={len(g.edges)} colors={len(g.pairs)}")
    for c, (a, b) in enumerate(g.pairs):
        print(f"  color {c}: {g.dots[a].color} #{a} ({g.dots[a].x:.0f},{g.dots[a].y:.0f})"
              f"  <->  #{b} ({g.dots[b].x:.0f},{g.dots[b].y:.0f})")

    # Decide with z3 first: it separates "the extraction is wrong" from "this
    # board is just hard", and it gives a definitive answer where the DFS only
    # gives "I gave up".  unsat on a real level means look at the extraction.
    verdict = solve_z3(g, require_full=args.full, timeout_ms=int(args.limit * 1000))
    print(f"z3 verdict: {verdict.status} ({verdict.seconds:.2f}s)")
    if verdict.status == "unsat":
        print("无解 —— 真实关卡不会出现，优先怀疑识别：漏边 / 颜色配对错 / 多点少点")
        return
    if verdict.status == "unknown":
        print("z3 超时，退回 DFS 搜索（结果不代表题无解）")

    st = solve(g, require_full=args.full, time_limit=args.limit,
               max_solutions=args.solutions)
    print(f"dfs: solved={len(st.solutions)} nodes={st.nodes} "
          f"time={st.seconds:.3f}s timed_out={st.timed_out}")

    if verdict.status == "sat" and not st.solutions:
        print("DFS 没搜出来，改用 z3 的解")
        paths = verdict.paths
    elif not st.solutions:
        return
    else:
        paths = st.solutions[0]

    cov = sum(len(p) for p in paths)
    flat = [v for p in paths for v in p]
    print(f"coverage={cov}/{len(g.dots)} 顶点无重复={len(flat) == len(set(flat))}")
    for c, path in enumerate(paths):
        print(f"  {c}: " + " -> ".join(f"{i}" for i in path))
    render(args.image, g, paths, os.path.join(args.out, "solution.png"))


if __name__ == "__main__":
    main()
