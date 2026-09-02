# -*- coding: utf-8 -*-
"""
用空间聚类减面重做 game_ready 档位（QEM 的替代主流程）。

为什么不用 make_game_ready.py 的 QEM：
  1. 混元顶点 split → QEM 退化删面（已在其内部焊接修复，但——）
  2. 焊接后 QEM 仍会产出单点高价扇形尖刺（E-04 实测 118 个长面共享 1 顶点）
空间聚类对这两种病态免疫，见 decimate_cluster.py。

产出与 make_game_ready.py 完全同格式：{base}_{N}tris.{obj,ply,glb}（顶点色）。
后续角色（E-01..E-03 / B-01..B-03）统一用本脚本。

用法：
  python regen_game_ready_cluster.py --input E04.glb --targets 6000 1600
"""

import argparse
import importlib.util
import json
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--targets", nargs="+", type=int, default=[6000, 1600])
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    mgr = _load("_mgr", os.path.join(_HERE, "make_game_ready.py"))
    dcl = _load("_dcl", os.path.join(_HERE, "decimate_cluster.py"))

    src = args.input
    if not os.path.isfile(src):
        print(f"[FATAL] 输入不存在: {src}", file=sys.stderr)
        return 1
    outdir = args.outdir or os.path.join(
        os.path.dirname(os.path.abspath(src)), "game_ready")
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(src))[0]

    print("[1/4] 解析 GLB + 顶点色 ...", file=sys.stderr)
    verts, faces, uv, textures = mgr.parse_glb(src)
    colors = mgr.bake_vertex_colors(uv, textures["baseColor"]).astype(np.float64)
    print(f"      {len(faces)} 面 / {len(verts)} 顶点", file=sys.stderr)

    results = []
    for target in sorted(set(args.targets), reverse=True):
        print(f"[2/4] 聚类减面 -> {target} 面 ...", file=sys.stderr)
        cell, keep, f2, chosen, nv, nf = dcl.cluster_decimate(
            verts, faces, colors, target)
        print(f"      cell={cell*1000:.1f}mm -> {nv} 顶点 / {nf} 面", file=sys.stderr)

        # 顶点色：单元内触及面的面积加权平均（与 decimate_cluster.py 同算法）
        kept = faces[keep][chosen]
        tri_colors = colors[kept].mean(axis=1)
        a, b, c = verts[kept[:, 0]], verts[kept[:, 1]], verts[kept[:, 2]]
        areas = np.linalg.norm(np.cross(b - a, c - a), axis=1) + 1e-12
        ids = np.floor((verts - verts.min(0)) / cell).astype(np.int64)
        key = (ids[:, 0] << 42) | (ids[:, 1] << 21) | ids[:, 2]
        _, inverse = np.unique(key, return_inverse=True)
        nv = int(inverse.max()) + 1
        wsum = np.zeros((nv, 3)); asum = np.zeros(nv)
        for k in range(3):
            np.add.at(wsum, f2[chosen, k], tri_colors * areas[:, None])
            np.add.at(asum, f2[chosen, k], areas)
        out_colors = (wsum / np.maximum(asum, 1e-12)[:, None]).clip(0, 255).astype(np.uint8)
        vsum = np.zeros((nv, 3)); vcnt = np.zeros(nv)
        np.add.at(vsum, inverse, verts)
        np.add.at(vcnt, inverse, 1)
        out_verts = vsum / np.maximum(vcnt, 1)[:, None]

        stem = f"{base}_{target}tris"
        obj_path = os.path.join(outdir, f"{stem}.obj")
        mgr.write_obj_vcolors(obj_path, out_verts, f2[chosen], out_colors)

        # 面积保持率质检
        area_out = float(np.linalg.norm(np.cross(
            out_verts[f2[chosen][:, 1]] - out_verts[f2[chosen][:, 0]],
            out_verts[f2[chosen][:, 2]] - out_verts[f2[chosen][:, 0]]), axis=1).sum() / 2)
        area_src = float(np.linalg.norm(np.cross(
            verts[faces[:, 1]] - verts[faces[:, 0]],
            verts[faces[:, 2]] - verts[faces[:, 0]]), axis=1).sum() / 2)
        print(f"      面积 {area_src:.3f} -> {area_out:.3f} m² "
              f"(保持率 {area_out/area_src*100:.1f}%)", file=sys.stderr)

        results.append({"target": target, "faces": int(nf), "vertices": int(nv),
                        "area_retention_pct": round(area_out/area_src*100, 1),
                        "obj": obj_path})

    print("[3/4] OBJ -> PLY (pymeshlab, 带顶点色) ...", file=sys.stderr)
    import pymeshlab as ml
    for r in results:
        ms = ml.MeshSet()
        ms.load_new_mesh(r["obj"])
        ply_path = r["obj"].replace(".obj", ".ply")
        ms.save_current_mesh(ply_path, save_vertex_color=True)
        r["ply"] = ply_path

    print("[4/4] PLY -> GLB (trimesh) + 材质注入 ...", file=sys.stderr)
    import trimesh
    for r in results:
        m = trimesh.load(r["ply"], force="mesh", process=False)
        glb_path = r["obj"].replace(".obj", ".glb")
        m.export(glb_path)
        mgr.ensure_material(glb_path)
        r["glb"] = glb_path

    print(json.dumps({"input": src, "outdir": outdir, "outputs": results},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
