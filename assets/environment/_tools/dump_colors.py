"""dump 顶点色直方图（16 桶亮度 × 代表色），确认烘焙色彩真实。"""
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
                cs.append([float(x) for x in p[4:7]] if len(p) >= 7 else [.6] * 3)
            elif p[0] == "f":
                fs.append([int(x.split("/")[0]) - 1 for x in p[1:4]])
    return np.array(vs), np.array(fs), np.array(cs)


def hexc(c):
    return "#%02x%02x%02x" % tuple(int(np.clip(x, 0, 1) * 255) for x in c)


for eid in (sys.argv[1:] or ["P-11", "P-14", "P-15"]):
    obj = os.path.join(MODELS, eid, f"{eid}_low.obj")
    if not os.path.exists(obj):
        continue
    vs, fs, cs = load_obj(obj)
    print(f"\n=== {eid}（{len(cs)} 顶点）===")
    lum = cs.mean(1)
    hist, edges = np.histogram(lum, bins=8, range=(0, 1))
    for i in range(8):
        sel = (lum >= edges[i]) & (lum < edges[i + 1])
        n = int(sel.sum())
        if n == 0:
            continue
        avg = cs[sel].mean(0)
        print(f"  亮度 {edges[i]:.2f}-{edges[i+1]:.2f}: {n:4d} 顶点  均色 {hexc(avg)}")
    # 最饱和的 5 个顶点
    mx = cs.max(1); mn = cs.min(1)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    top = np.argsort(-s)[:5]
    print("  最饱和顶点:", ", ".join(hexc(cs[i]) for i in top))
