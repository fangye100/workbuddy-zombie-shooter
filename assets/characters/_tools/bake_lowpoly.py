# -*- coding: utf-8 -*-
"""
给游戏低模补 UV 并烘焙 baseColor 贴图。

背景
----
make_game_ready.py 产出的低模带顶点色（够看），但没有成型的 UV —— QEM 减面后的网格
是非流形的，pymeshlab 的自动 UV 展开（voronoi atlas / LSCM / harmonic）全部拒绝处理，
remesh + 补洞 + 修非流形也救不回来（实测结论，别再试）。

本脚本改用 xatlas（游戏行业的 UV atlas 库，能容忍这类输入）来展 UV，
再把顶点色按三角形光栅化进贴图，最终产出「低模 + UV + 贴图」的标准资产。

用法
----
  python bake_lowpoly.py --input game_ready/E04_..._1600tris.ply --size 1024 --oudir out/
"""

import argparse
import json
import os
import sys

import numpy as np

try:
    import xatlas
except ImportError:
    print("[FATAL] 需要 xatlas：pip install xatlas", file=sys.stderr)
    sys.exit(1)
try:
    import pymeshlab as ml
except ImportError:
    print("[FATAL] 需要 pymeshlab：pip install pymeshlab", file=sys.stderr)
    sys.exit(1)
try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print("[FATAL] 需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(1)


def load_ply(path: str):
    """用 pymeshlab 读 PLY，返回 (verts, faces, colors_uint8)。"""
    ms = ml.MeshSet()
    ms.load_new_mesh(path)
    m = ms.current_mesh()
    verts = m.vertex_matrix().astype(np.float64)
    faces = m.face_matrix().astype(np.int64)
    colors = None
    if m.has_vertex_color():
        c = m.vertex_color_matrix()
        arr = np.asarray(c)
        # pymeshlab 返回 0-1 浮点或 0-255，按数值范围判断
        colors = (arr * 255.0).clip(0, 255).astype(np.uint8) if arr.max() <= 1.5 \
            else arr.clip(0, 255).astype(np.uint8)
    return verts, faces, colors


def grade_colors(colors: np.ndarray, target_lum: float = 0.35,
                 sat: float = 1.25) -> np.ndarray:
    """
    自动色阶 + 加饱和。

    实测：混元 3D 生成的 baseColor 普遍偏暗 —— E-04 那张 4096² 贴图亮度中位数只有
    22/255、70% 的像素低于 40、最亮仅 156。直接拿去做 albedo，模型在游戏里会糊成一团黑，
    也不符合本项目「美漫卡通、高饱和撞色」的调性。

    做法：按当前亮度中位数反解一个 gamma，把它拉到 target_lum（保持色相、只动明度），
    再整体加饱和。gamma 限制在 0.3-1.5，避免极端输入被拉爆。
    """
    arr = np.asarray(colors)
    # pymeshlab 的顶点色是 RGBA，只处理 RGB，alpha 原样带回
    if arr.ndim == 2 and arr.shape[1] >= 4:
        alpha = arr[:, 3:4]
        rgb_in = arr[:, :3]
    else:
        alpha = None
        rgb_in = arr

    c = rgb_in.astype(np.float64) / 255.0
    lum = c @ np.array([0.2126, 0.7152, 0.0722])
    med = float(np.median(lum))
    if med <= 1e-4:
        return colors

    gamma = float(np.clip(np.log(target_lum) / np.log(med), 0.3, 1.5))
    c = np.power(np.clip(c, 0.0, 1.0), gamma)

    # 加饱和：围绕亮度轴放大色度分量
    l = (c @ np.array([0.2126, 0.7152, 0.0722]))[:, None]
    c = np.clip(l + (c - l) * sat, 0.0, 1.0)

    out = (c * 255.0).clip(0, 255).astype(np.uint8)
    new_lum = float(np.median((out / 255.0) @ np.array([0.2126, 0.7152, 0.0722])))
    print(f"      色阶校正：亮度中位 {med:.3f} -> {new_lum:.3f} "
          f"(gamma={gamma:.2f}, sat={sat})", file=sys.stderr)
    if alpha is not None:
        out = np.concatenate([out, alpha], axis=1)
    return out


def rasterize_texture(uvs, faces, colors, size: int, dilate: int = 2):
    """把顶点色按 UV 光栅化成贴图（每三角形填平均色 + 同色描边抗接缝）。"""
    img = Image.new("RGB", (size, size), (128, 128, 128))
    draw = ImageDraw.Draw(img)

    px = np.stack([uvs[:, 0] * (size - 1), (1.0 - uvs[:, 1]) * (size - 1)], axis=1)

    n = len(colors) if colors is not None else 0
    for tri in faces:
        if int(tri.max()) >= n:
            continue
        col = colors[tri].mean(axis=0).astype(np.uint8)
        rgb = (int(col[0]), int(col[1]), int(col[2]))
        pts = [tuple(px[int(i)].tolist()) for i in tri]
        # outline 用同色，等效于向外膨胀一个像素，避免 UV 接缝采到背景
        draw.polygon(pts, fill=rgb, outline=rgb)

    if dilate > 0:
        for _ in range(dilate):
            img = img.filter(ImageFilter.MaxFilter(3))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="带顶点色的低模（ply / obj）")
    ap.add_argument("--size", type=int, default=1024, help="贴图分辨率")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--name", default=None, help="输出文件名前缀")
    ap.add_argument("--no-grade", action="store_true",
                    help="关闭自动色阶校正（AI 贴图偏暗，默认开启）")
    ap.add_argument("--target-lum", type=float, default=0.35,
                    help="校正后的目标亮度中位数，0-1")
    ap.add_argument("--sat", type=float, default=1.25, help="饱和度倍数")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print(f"[FATAL] 输入不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    outdir = args.outdir or os.path.dirname(os.path.abspath(args.input))
    os.makedirs(outdir, exist_ok=True)
    name = args.name or os.path.splitext(os.path.basename(args.input))[0]

    print("[1/4] 读取低模 ...", file=sys.stderr)
    verts, faces, colors = load_ply(args.input)
    print(f"      {len(faces)} 面 / {len(verts)} 顶点 / "
          f"顶点色={'有' if colors is not None else '无'}", file=sys.stderr)
    if colors is None:
        print("[FATAL] 低模没有顶点色，无法烘焙（请先用 make_game_ready.py）", file=sys.stderr)
        sys.exit(1)

    print("[2/4] xatlas 展开 UV ...", file=sys.stderr)
    vmapping, indices, uvs = xatlas.parametrize(
        verts.astype(np.float32), faces.astype(np.uint32)
    )
    new_verts = verts[vmapping]
    new_colors = colors[vmapping]
    new_faces = np.asarray(indices).reshape(-1, 3)
    new_uvs = np.asarray(uvs)
    print(f"      UV 展开完成：{len(new_faces)} 面 / {len(new_verts)} 顶点（UV 顶点）",
          file=sys.stderr)

    bake_colors = new_colors
    if not args.no_grade:
        print("[3/4] 色阶校正 ...", file=sys.stderr)
        bake_colors = grade_colors(new_colors, args.target_lum, args.sat)

    print(f"      烘焙 baseColor 贴图（{args.size}x{args.size}）...", file=sys.stderr)
    tex = rasterize_texture(new_uvs, new_faces, bake_colors, args.size)
    tex_path = os.path.join(outdir, f"{name}_baseColor.png")
    tex.save(tex_path)
    print(f"      已保存 {os.path.basename(tex_path)}", file=sys.stderr)

    print("[4/4] 导出模型 ...", file=sys.stderr)
    outputs = {"texture": tex_path, "size": args.size}

    # OBJ + MTL
    obj_path = os.path.join(outdir, f"{name}.obj")
    mtl_path = os.path.join(outdir, f"{name}.mtl")
    with open(mtl_path, "w", encoding="utf-8") as f:
        f.write(f"newmtl baked\n")
        f.write("Ka 1.000 1.000 1.000\nKd 1.000 1.000 1.000\n")
        f.write("Ks 0.000 0.000 0.000\n")
        f.write(f"map_Kd {os.path.basename(tex_path)}\n")
    with open(obj_path, "w", encoding="utf-8") as f:
        f.write(f"mtllib {os.path.basename(mtl_path)}\n")
        for v in new_verts:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        for uv in new_uvs:
            f.write(f"vt {uv[0]:.6f} {uv[1]:.6f}\n")
        f.write("usemtl baked\n")
        for tri in new_faces:
            a, b, c = int(tri[0]) + 1, int(tri[1]) + 1, int(tri[2]) + 1
            f.write(f"f {a}/{a} {b}/{b} {c}/{c}\n")
    outputs["obj"] = obj_path

    # GLB（用 trimesh 组装，贴图内嵌）
    try:
        import trimesh
        from trimesh.visual.material import PBRMaterial

        mat = PBRMaterial(baseColorTexture=tex, metallicFactor=0.0, roughnessFactor=0.85)
        mesh = trimesh.Trimesh(
            vertices=new_verts,
            faces=new_faces,
            visual=trimesh.visual.TextureVisuals(uv=new_uvs, material=mat),
            process=False,
        )
        glb_path = os.path.join(outdir, f"{name}_baked.glb")
        mesh.export(glb_path)
        outputs["glb"] = glb_path
        print(f"      {os.path.basename(glb_path)}  "
              f"({os.path.getsize(glb_path) / 1024:.0f} KB)", file=sys.stderr)
    except Exception as e:
        print(f"      [WARN] GLB 导出失败: {e}", file=sys.stderr)

    print(json.dumps({
        "input": args.input,
        "faces": int(len(new_faces)),
        "uv_vertices": int(len(new_verts)),
        "outputs": outputs,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
