"""低模 OBJ 客观质检（无人工目检条件下的数值化判据）。"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "models")


def load_obj(path):
    vs, fs, cs = [], [], []
    with open(path) as f:
        for line in f:
            p = line.split()
            if p[0] == "v":
                vs.append([float(x) for x in p[1:4]])
                cs.append([float(x) for x in p[4:7]] if len(p) >= 7 else [0.6, 0.6, 0.6])
            elif p[0] == "f":
                fs.append([int(x.split("/")[0]) - 1 for x in p[1:4]])
    return np.array(vs), np.array(fs), np.array(cs)


ids = sys.argv[1:] or sorted(
    d for d in os.listdir(MODELS)
    if os.path.exists(os.path.join(MODELS, d, f"{d}_low.obj"))
)
print(f"{'ID':6} {'面数':>5} {'尺寸(m)':>16} {'色相熵':>7} {'彩色占比':>7} {'退化面':>6} {'非引用v':>7}")
for eid in ids:
    obj = os.path.join(MODELS, eid, f"{eid}_low.obj")
    vs, fs, cs = load_obj(obj)
    size = vs.max(0) - vs.min(0)
    # 退化面（零面积）
    a, b, c = vs[fs[:, 0]], vs[fs[:, 1]], vs[fs[:, 2]]
    ar = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    degen = int((ar < 1e-10).sum())
    # 非引用顶点
    used = np.zeros(len(vs), dtype=bool)
    used[fs.ravel()] = True
    orphans = int((~used).sum())
    # 颜色：HSV 色相直方图熵 + 饱和度（彩色占比）
    mx = cs.max(1); mn = cs.min(1); v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    r, g, b_ = cs[:, 0], cs[:, 1], cs[:, 2]
    hue = np.zeros(len(cs))
    m = mx > 1e-6
    hue[m & (mx == r)] = ((g - b_)[m & (mx == r)] / mx[m & (mx == r)]) % 6
    hue[m & (mx == g)] = (b_ - r)[m & (mx == g)] / mx[m & (mx == g)] + 2
    hue[m & (mx == b_)] = (r - g)[m & (mx == b_)] / mx[m & (mx == b_)] + 4
    hist, _ = np.histogram(hue, bins=12, range=(0, 6))
    p = hist / max(hist.sum(), 1)
    ent = -(p[p > 0] * np.log2(p[p > 0])).sum()
    colorful = float((s > 0.25).mean())
    print(f"{eid:6} {len(fs):5d} {size[0]:5.1f}x{size[2]:5.1f}x{size[1]:4.1f} {ent:7.2f} {colorful:7.1%} {degen:6d} {orphans:7d}")
