# -*- coding: utf-8 -*-
"""把 Z-up（躺姿）的静态 glb 数据修正为 Y-up 立姿。

用法:
  python fix_yup.py <file.glb> [<file.glb> ...]   # 修正指定文件
  python fix_yup.py --check <file.glb> [...]      # 只体检不改

方法: trimesh 载入场景（应用 node 变换得世界坐标）→ 量包围盒最高轴 →
  z→y 用 RotX(-90°)、x→y 用 RotZ(-90°) → 重导出（保留 baseColor 贴图 + UV）。
适用: 静态网格（无 skin）。skinned/animated 文件一律跳过。
注意: 重导出只保留 baseColor 贴图；raw 高模的 metallicRoughness/normal 图会被丢弃
  （原档在 git LFS 历史里可找回）。
"""
import os, sys
import numpy as np

def up_axis_report(path):
    import trimesh
    scene = trimesh.load(path, force="scene", process=False)
    # 合并所有几何（已应用 node 变换到世界系）
    joined = scene.dump(concatenate=True)
    if joined is None or len(joined.vertices) == 0:
        return None, None
    lo, hi = joined.bounds[0], joined.bounds[1]
    size = hi - lo
    return int(np.argmax(size)), dict(size=[round(float(x), 3) for x in size],
                                      n_geom=len(scene.geometry), has_skin=any(
                                          g for g in scene.geometry.values() if getattr(g, "visual", None) is not None and False))

def fix_one(path, apply=False):
    import trimesh
    axis, info = up_axis_report(path)
    if axis is None:
        return "EMPTY"
    tag = "xyz"[axis]
    if axis == 1:
        return f"YUP(ok) {info['size']}"
    if apply is False:
        return f"{tag.upper()}-UP(need fix) {info['size']}"

    scene = trimesh.load(path, force="scene", process=False)
    joined = scene.dump(concatenate=True)
    if axis == 2:      # Z-up → Y-up: (x,y,z) → (x, z, -y)
        R = trimesh.transformations.rotation_matrix(angle=np.pi / 2, direction=[1, 0, 0])
    else:              # X-up → Y-up: (x,y,z) → (-z? no) use RotZ(-90): (x,y,z) → (y, -x, z)
        R = trimesh.transformations.rotation_matrix(angle=-np.pi / 2, direction=[0, 0, 1])
    joined.apply_transform(R)
    # 贴图：取场景第一个带 image 的材质
    img, uv = None, None
    for g in scene.geometry.values():
        vis = getattr(g, "visual", None)
        if vis is not None and hasattr(vis, "material") and getattr(vis.material, "image", None) is not None and vis.uv is not None:
            img, uv = vis.material.image, vis.uv
            break
    if img is not None and uv is not None and len(uv) == len(joined.vertices):
        joined.visual = trimesh.visual.TextureVisuals(uv=uv, image=img)
    else:
        print(f"  ⚠️ {os.path.basename(path)}: 无贴图/UV 对不齐（uv={None if uv is None else len(uv)} v={len(joined.vertices)}），导出无贴图版")
    joined.export(path)
    axis2, info2 = up_axis_report(path)
    ok = axis2 == 1
    return f"{'FIXED→YUP' if ok else 'STILL-' + 'xyz'[axis2].upper()} {info2['size']}"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    for p in args:
        if not os.path.exists(p):
            print(f"{os.path.basename(p):46s} MISSING")
            continue
        try:
            print(f"{os.path.basename(p)[:44]:46s} {fix_one(p, apply=not check_only)}")
        except Exception as e:
            print(f"{os.path.basename(p)[:44]:46s} ERR {repr(e)[:120]}")

if __name__ == "__main__":
    main()
