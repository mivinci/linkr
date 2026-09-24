"""Diagnostics for the extraction pipeline."""

from __future__ import annotations

import sys

import numpy as np
from PIL import Image
from scipy import ndimage

from extract import _hue, dark_mask, find_dots, load

PATH = sys.argv[1] if len(sys.argv) > 1 else (
    "/Users/leo/Library/Containers/com.tencent.qq/Data/tmp/QQ_1790222800694.png"
)

rgb, lum = load(PATH)
sat = rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int)
hue = _hue(rgb)

print("=== saturation distribution ===")
for t in (40, 60, 80, 100, 120, 150):
    print(f"  sat>{t}: {(sat > t).mean() * 100:.3f}%")

print("\n=== dark mask / distance transform ===")
mask = dark_mask(lum, 100)
dist = ndimage.distance_transform_edt(mask)
print("  dt max", dist.max())
for t in (4, 6, 8, 9, 10, 12, 14, 16):
    lab, n = ndimage.label(dist >= t)
    print(f"  dt>={t}: {n} components")

print("\n=== find_dots(9) ===")
pts = find_dots(mask, 9.0)
pts.sort(key=lambda p: (round(p[1] / 20), p[0]))
print("  count:", len(pts))
for i, (x, y, r) in enumerate(pts):
    print(f"  {i:3d} x={x:7.1f} y={y:7.1f} r={r:5.2f}")

# duplicate check
arr = np.array([[p[0], p[1]] for p in pts])
if len(arr):
    d = np.hypot(arr[:, 0][:, None] - arr[:, 0][None, :], arr[:, 1][:, None] - arr[:, 1][None, :])
    np.fill_diagonal(d, 1e9)
    close = np.argwhere(d < 25)
    print("\n  pairs closer than 25px:", len(close) // 2, close[:20].tolist())

print("\n=== radial profile of a few dots ===")
h, w = sat.shape
for idx in range(min(6, len(pts))):
    x, y, r = pts[idx]
    print(f"  dot {idx} ({x:.0f},{y:.0f}) r={r:.1f}")
    for f in (0.5, 0.7, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 1.8):
        rad = max(1.0, r * f)
        yy, xx = np.mgrid[max(0, int(y - rad - 3)):min(h, int(y + rad + 4)),
                          max(0, int(x - rad - 3)):min(w, int(x + rad + 4))]
        rr = np.hypot(xx - x, yy - y)
        sel = (rr > rad - 2) & (rr < rad + 2)
        if sel.sum() == 0:
            continue
        s = sat[yy, xx][sel]
        hh = hue[yy, xx][sel]
        m = s > 60
        med = float(np.median(hh[m])) if m.sum() else float("nan")
        print(f"    r*f={f:4.1f} px={sel.sum():4d} sat_med={np.median(s):5.0f} "
              f"sat>60={m.sum():4d} hue_med={med:6.1f}")
