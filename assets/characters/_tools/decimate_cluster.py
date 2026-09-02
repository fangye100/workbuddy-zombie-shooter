# -*- coding: utf-8 -*-
"""
空间聚类减面（vertex clustering）—— 专治 AI 生成网格的病态拓扑。

背景
----
QEM（pymeshlab 边坍缩）对混元 3D 的网格不可用：
  1. 顶点带大量 split（56156 → 焊接后 39980），不焊接则拓扑建不起来，QEM 退化成删面
     （80000→1599 面、面积保持率 1.9%，就是"角色透明"事故的根因）；
  2. 焊接后网格仍有自接触区域，QEM 会把一片邻域塌到单个顶点上，产出 100+ 尖刺面
     （实测 118 个长面全部共享 492 号顶点）。

空间聚类不看索引连接，按位置把顶点吸到三维网格单元里，天生免疫以上两种病态：
  - 每个单元 = 一个输出顶点；面的三个顶点落入同一单元 → 丢弃
  - 同一 (a,b,c) 单元三元组的多张面 → 只保留一张（绕序沿用原始面，不重排）
  - 顶点色按「落进该单元的所有原始面的面积加权平均色」烘焙，渐变不糊

输出与 make_game_ready.py 同格式的带顶点色 OBJ，可直接交给 bake_lowpoly.py。

用法
----
  python decimate_cluster.py --input E04.glb --target 1600 --out low.obj
  python decimate_cluster.py --input E04.glb --target 1600 --out low.obj --stats
"""

import argparse
import importlib.util
import json
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_MGR = os.path.join(_HERE, "make_game_ready.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("_mgr", _MGR)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_mgr"] = mod
    spec.loader.exec_module(mod)
    return mod


def cluster_decimate(verts, faces, colors, target, lo=0.002, hi=0.2):
    """二分搜索单元尺寸，使输出面数逼近 target。"""
    mn, mx = verts.min(0), verts.max(0)

    def run(cell):
        ids = np.floor((verts - mn) / cell).astype(np.int64)
        # 单元 id 压成唯一标量
        key = (ids[:, 0] << 42) | (ids[:, 1] << 21) | ids[:, 2]
        uniq, first, inverse = np.unique(key, return_index=True, return_inverse=True)
        f_cl = inverse[faces]  # (F,3) 单元索引
        # 退化面：任两边同单元
        keep = (f_cl[:, 0] != f_cl[:, 1]) & (f_cl[:, 1] != f_cl[:, 2]) & (f_cl[:, 0] != f_cl[:, 2])
        f2 = f_cl[keep]
        # 同三元组去重：无序键去重计数，保留第一条的原始绕序
        sorted3 = np.sort(f2, axis=1)
        _, idx_uni = np.unique(sorted3, axis=0, return_index=True)
        chosen = np.sort(idx_uni)  # 稳定顺序
        return keep, f2, chosen, len(uniq), len(chosen)

    a, b = lo, hi
    best = None
    for _ in range(24):
        mid = (a * b) ** 0.5
        keep, f2, chosen, nv, nf = run(mid)
        best = (mid, keep, f2, chosen, nv, nf)
        if nf > target:
            a = mid
        else:
            b = mid
        if abs(nf - target) <= target * 0.06:
            break
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--target", type=int, default=1600)
    ap.add_argument("--out", required=True, help="输出带顶点色 OBJ")
    args = ap.parse_args()

    mgr = _load_module()
    print("[1/4] 解析 GLB + 采样顶点色 ...", file=sys.stderr)
    verts, faces, uv, textures = mgr.parse_glb(args.input)
    colors = mgr.bake_vertex_colors(uv, textures["baseColor"]).astype(np.float64)
    print(f"      {len(faces)} 面 / {len(verts)} 顶点", file=sys.stderr)

    print("[2/4] 空间聚类减面 ...", file=sys.stderr)
    cell, keep, f2, chosen, nv, nf = cluster_decimate(verts, faces, colors, args.target)
    print(f"      cell={cell*1000:.1f}mm -> {nv} 单元 / {nf} 面（目标 {args.target}）",
          file=sys.stderr)

    # 输出顶点色：落在该单元的所有原始面的「面积加权平均色」
    kept_faces = faces[keep][chosen]  # (nf,3) 原始索引，绕序未动
    tri_colors = colors[kept_faces].mean(axis=1)  # (nf,3) 每面平均色
    a = verts[kept_faces[:, 0]]
    b = verts[kept_faces[:, 1]]
    c = verts[kept_faces[:, 2]]
    areas = np.linalg.norm(np.cross(b - a, c - a), axis=1) + 1e-12

    # 每个输出单元的顶点色 = 触及面的面积加权色均值
    inv = None
    ids = np.floor((verts - verts.min(0)) / cell).astype(np.int64)
    key = (ids[:, 0] << 42) | (ids[:, 1] << 21) | ids[:, 2]
    uniq, inverse = np.unique(key, return_inverse=True)
    nv = len(uniq)
    wsum = np.zeros((nv, 3))
    asum = np.zeros(nv)
    for k in range(3):
        np.add.at(wsum, f2[chosen, k], tri_colors * areas[:, None])
        np.add.at(asum, f2[chosen, k], areas)
    out_colors = (wsum / np.maximum(asum, 1e-12)[:, None]).clip(0, 255).astype(np.uint8)

    # 输出顶点位置 = 单元内触及顶点的均值（比单元角点平滑）
    vsum = np.zeros((nv, 3))
    vcnt = np.zeros(nv)
    np.add.at(vsum, inverse, verts)
    np.add.at(vcnt, inverse, 1)
    out_verts = vsum / np.maximum(vcnt, 1)[:, None]

    print("[3/4] 写带顶点色 OBJ ...", file=sys.stderr)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fo:
        for i in range(nv):
            r, g, bch = out_colors[i] / 255.0
            fo.write(f"v {out_verts[i][0]:.6f} {out_verts[i][1]:.6f} {out_verts[i][2]:.6f} "
                     f"{r:.6f} {g:.6f} {bch:.6f}\n")
        for tri in f2[chosen]:
            fo.write(f"f {tri[0] + 1} {tri[1] + 1} {tri[2] + 1}\n")

    # 质检：面积保持率 + 长边统计
    area_out = float(np.linalg.norm(np.cross(
        out_verts[f2[chosen][:, 1]] - out_verts[f2[chosen][:, 0]],
        out_verts[f2[chosen][:, 2]] - out_verts[f2[chosen][:, 0]]), axis=1).sum() / 2)
    area_src = float(np.linalg.norm(np.cross(
        verts[faces[:, 1]] - verts[faces[:, 0]],
        verts[faces[:, 2]] - verts[faces[:, 0]]), axis=1).sum() / 2)
    el = np.stack([
        np.linalg.norm(out_verts[f2[chosen][:, 0]] - out_verts[f2[chosen][:, 1]], axis=1),
        np.linalg.norm(out_verts[f2[chosen][:, 1]] - out_verts[f2[chosen][:, 2]], axis=1),
        np.linalg.norm(out_verts[f2[chosen][:, 2]] - out_verts[f2[chosen][:, 0]], axis=1),
    ], axis=1).max(1)
    diag = float(np.linalg.norm(verts.max(0) - verts.min(0)))
    print(f"[4/4] 质检: 面积 {area_src:.3f} -> {area_out:.3f} m² "
          f"(保持率 {area_out / area_src * 100:.1f}%), 最长边 {el.max():.3f} m "
          f"(对角 {diag:.3f} m)", file=sys.stderr)

    print(json.dumps({
        "input": args.input, "out": args.out,
        "source_faces": int(len(faces)), "target": args.target,
        "output_faces": int(nf), "output_vertices": int(nv),
        "cell_meters": round(float(cell), 5),
        "area_retention_pct": round(area_out / area_src * 100, 1),
        "max_edge_m": round(float(el.max()), 3),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
