# -*- coding: utf-8 -*-
"""
把 AI 生成的高模减面到游戏预算。

AI（混元 3D）出的是 8 万面的静态高模，游戏预算（roster.json 的 tris 字段）通常只有
一两千面。本脚本用二次误差简化（QEM）把面数压到目标值，并尽量保留 UV 与边界，
使原有 PBR 贴图仍能大致沿用。

用法
----
  python decimate_to_budget.py --input E04.glb --targets 1600 6000 --outdir out/

会为每个 target 产出 <basename>_<n>tris.glb 与 .obj，并打印前后统计。
"""

import argparse
import json
import os
import sys

try:
    import pymeshlab as ml
except ImportError:
    print("[FATAL] 需要 pymeshlab：pip install pymeshlab", file=sys.stderr)
    sys.exit(1)


def stats(ms) -> dict:
    m = ms.current_mesh()
    return {
        "vertices": m.vertex_number(),
        "faces": m.face_number(),
        "has_uv": bool(m.has_vertex_tex_coord()),
        "has_color": bool(m.has_vertex_color()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="输入模型（glb / obj / fbx）")
    ap.add_argument("--targets", nargs="+", type=int, default=[1600],
                    help="目标面数列表，例如 1600 6000")
    ap.add_argument("--outdir", default=None, help="输出目录，默认与输入同目录")
    ap.add_argument("--preserve-uv", action="store_true", default=True,
                    help="保留 UV（默认开启）")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print(f"[FATAL] 输入不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    outdir = args.outdir or os.path.dirname(os.path.abspath(args.input))
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.input))[0]

    ms = ml.MeshSet()
    ms.load_new_mesh(args.input)
    before = stats(ms)
    print(f"[INFO] 输入  {os.path.basename(args.input)}: "
          f"{before['faces']} 面 / {before['vertices']} 顶点 / UV={before['has_uv']}",
          file=sys.stderr)

    results = []

    for target in sorted(set(args.targets), reverse=True):
        # 每个目标都从原始高模重新简化，避免逐级累积误差
        ms.load_new_mesh(args.input)
        if before["faces"] <= target:
            print(f"[WARN] 输入面数 {before['faces']} 已低于目标 {target}，跳过", file=sys.stderr)
            continue

        # ⚠️ 混元 GLB 顶点带大量重复，pymeshlab 拓扑建不起来(edge=0)，QEM 会退化成
        # 删面(面积保持率 1.9%)。先焊接/修复再减面，面积保持率可到 91.5%。
        # 详见 make_game_ready.py 同位置注释。
        ms.meshing_remove_duplicate_faces()
        ms.meshing_remove_duplicate_vertices()
        ms.meshing_repair_non_manifold_edges()
        ms.meshing_repair_non_manifold_vertices()

        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target,
            qualitythr=1.0,          # 质量阈值，1.0 = 不额外惩罚
            preserveboundary=True,   # 保住开放边界（盾板边缘、断口）
            boundaryweight=1.0,
            preservenormal=True,     # 保住硬边法线，避免盾板/护甲塌成软面
            optimalplacement=True,   # 最优顶点放置，误差更小
            planarquadric=True,      # 对平面区域更友好
            qualityweight=False,
            autoclean=True,          # 清理退化面
            selected=False,
        )

        after = stats(ms)
        stem = f"{base}_{target}tris"
        glb_path = os.path.join(outdir, f"{stem}.glb")
        obj_path = os.path.join(outdir, f"{stem}.obj")

        try:
            ms.save_current_mesh(glb_path)
        except Exception as e:
            print(f"[WARN] GLB 导出失败: {e}", file=sys.stderr)
            glb_path = None
        try:
            ms.save_current_mesh(obj_path)
        except Exception as e:
            print(f"[WARN] OBJ 导出失败: {e}", file=sys.stderr)
            obj_path = None

        ratio = (1 - after["faces"] / before["faces"]) * 100 if before["faces"] else 0
        print(f"[OK] {target:>6} 面 -> 实际 {after['faces']:>6} 面 / "
              f"{after['vertices']:>6} 顶点  (减面 {ratio:.1f}%)  UV={after['has_uv']}",
              file=sys.stderr)

        results.append({
            "target": target,
            "faces": after["faces"],
            "vertices": after["vertices"],
            "has_uv": after["has_uv"],
            "reduction_pct": round(ratio, 2),
            "glb": glb_path,
            "obj": obj_path,
        })

    print(json.dumps({
        "input": args.input,
        "before": before,
        "outputs": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
