"""CLI: extract a puzzle graph from a screenshot and write a debug overlay.

    uv run python main.py <image> [-o out.json] [--overlay out.png]
"""

from __future__ import annotations

import argparse
import collections
import json

from PIL import Image, ImageDraw

from extract import Graph, extract, write


def overlay(src: str, g: Graph, dst: str) -> None:
    im = Image.open(src).convert("RGB").copy()
    d = ImageDraw.Draw(im, "RGBA")
    for a, b in g.edges:
        p, q = g.dots[a], g.dots[b]
        d.line((p.x, p.y, q.x, q.y), fill=(40, 200, 120, 255), width=6)
    for i, dot in enumerate(g.dots):
        box = (dot.x - dot.r, dot.y - dot.r, dot.x + dot.r, dot.y + dot.r)
        fill = (255, 90, 90, 160) if dot.color else (150, 150, 150, 120)
        d.ellipse(box, outline=(255, 255, 0, 255), width=2, fill=fill)
        d.text((dot.x + dot.r + 2, dot.y - 6), f"{i}{':' + dot.color if dot.color else ''}",
               fill=(255, 255, 0, 255))
    im.save(dst)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("-o", "--out", default="graph.json")
    ap.add_argument("--overlay", default="overlay.png")
    ap.add_argument("--thresh", type=float, default=100.0)
    ap.add_argument("--sat", type=int, default=60)
    ap.add_argument("--min-dist", type=float, default=0.0,
                    help="0 = derive from the image (default)")
    ap.add_argument("--ratio", type=float, default=1.9)
    args = ap.parse_args()

    g = extract(args.image, args.thresh, args.sat, args.min_dist or None, args.ratio)
    write(g, args.out)
    overlay(args.image, g, args.overlay)

    deg = collections.Counter()
    for a, b in g.edges:
        deg[a] += 1
        deg[b] += 1
    print(f"dots={len(g.dots)} edges={len(g.edges)} meta={g.meta}")
    print("degrees:", collections.Counter(deg[i] for i in range(len(g.dots))))
    print("colours:", collections.Counter(d.color for d in g.dots if d.color))
    isolated = [i for i in range(len(g.dots)) if deg[i] == 0]
    if isolated:
        print("!! isolated dots:", isolated)


if __name__ == "__main__":
    main()
