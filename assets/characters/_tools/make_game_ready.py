# -*- coding: utf-8 -*-
"""
高模 → 游戏可用低模：减面 + 贴图烘焙到顶点色。

为什么要把贴图烘成顶点色
------------------------
把 8 万面的模型压到 1600 面（约 2%），UV 会严重拉伸错位，原 PBR 贴图基本没法沿用。
真实生产流程此时要「重新展 UV + 从高模烘焙 normal/AO/baseColor」，工序重。
但对本项目这种 god view 下只有几十像素的小怪，有个更划算的做法：
**把高模的 baseColor 按 UV 采样成顶点色**，低模就自带颜色，完全不依赖 UV 与贴图，
还能省一张贴图。1600 面的网格携带顶点色，视觉上足够。

流程
----
1. 直接解析 GLB 二进制，取出顶点 / 三角面 / UV / 贴图 PNG
   （trimesh 5.x 对这套 GLB 的 PBR 材质解析不出来，所以自己解析）
2. 按 UV 采样 baseColor，得到每个顶点的 RGB
3. 写出带顶点色的 OBJ，交给 pymeshlab 做二次误差简化（QEM）
4. 导出低模 OBJ / PLY，并用 trimesh 转成带 COLOR_0 的 GLB

用法
----
  python make_game_ready.py --input E04.glb --targets 1600 6000 --outdir out/
"""

import argparse
import base64
import json
import os
import struct
import sys

import numpy as np

try:
    import pymeshlab as ml
except ImportError:
    print("[FATAL] 需要 pymeshlab：pip install pymeshlab", file=sys.stderr)
    sys.exit(1)
try:
    from PIL import Image
except ImportError:
    print("[FATAL] 需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------
# GLB 解析
# --------------------------------------------------------------------------

_COMP = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def parse_glb(path: str):
    """解析 GLB，返回 (verts, faces, uv, textures_dict)。"""
    raw = open(path, "rb").read()
    js, bin_data = None, b""
    off = 12
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        data = raw[off + 8:off + 8 + clen]
        if ctype == b"JSON":
            js = json.loads(data.decode("utf-8"))
        elif ctype == b"BIN\x00":
            bin_data = data
        off += 8 + clen

    if js is None:
        raise ValueError("不是有效的 GLB（缺少 JSON chunk）")

    def read_accessor(i):
        acc = js["accessors"][i]
        bv = js["bufferViews"][acc["bufferView"]]
        fmt, size = _COMP[acc["componentType"]]
        n = _NCOMP[acc["type"]]
        count = acc["count"]
        base_off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = bv.get("byteStride")
        if stride and stride != size * n:
            # 交错存储：逐元素按 stride 取
            arr = np.frombuffer(
                bin_data, dtype=np.uint8,
                count=count * stride, offset=base_off,
            ).reshape(count, stride)
            return np.ascontiguousarray(arr[:, : size * n]).view(np.dtype(fmt)).reshape(count, n)
        arr = np.frombuffer(bin_data, dtype=np.dtype(fmt), count=count * n, offset=base_off)
        return arr.reshape(count, n)

    prim = js["meshes"][0]["primitives"][0]
    verts = read_accessor(prim["attributes"]["POSITION"]).astype(np.float64)
    # indices 是 SCALAR 访问器，count = 三角形数 x 3，需要按 3 个一组折成面
    faces = read_accessor(prim["indices"]).astype(np.int64).reshape(-1, 3)
    uv = None
    if "TEXCOORD_0" in prim["attributes"]:
        uv = read_accessor(prim["attributes"]["TEXCOORD_0"]).astype(np.float64)

    # 提取贴图（按 material 里出现的顺序推断语义）
    textures = {}
    mat_root = (js.get("materials") or [{}])[0]
    mat = mat_root.get("pbrMetallicRoughness", {})
    semantic = {}
    if "baseColorTexture" in mat:
        semantic[mat["baseColorTexture"].get("index", 0)] = "baseColor"
    if "metallicRoughnessTexture" in mat:
        semantic[mat["metallicRoughnessTexture"].get("index", 0)] = "metallicRoughness"
    # normal / occlusion 挂在 material 根上，不在 pbrMetallicRoughness 里
    if "normalTexture" in mat_root:
        semantic[mat_root["normalTexture"].get("index", 0)] = "normal"
    if "occlusionTexture" in mat_root:
        semantic[mat_root["occlusionTexture"].get("index", 0)] = "occlusion"

    for idx, img in enumerate(js.get("images", [])):
        name = semantic.get(idx, f"tex{idx}")
        if "uri" in img:
            if img["uri"].startswith("data:"):
                textures[name] = base64.b64decode(img["uri"].split(",", 1)[1])
            else:
                textures[name] = None
        elif "bufferView" in img:
            bv = js["bufferViews"][img["bufferView"]]
            o = bv.get("byteOffset", 0)
            textures[name] = bin_data[o:o + bv["byteLength"]]
        else:
            textures[name] = None

    return verts, faces, uv, textures


# --------------------------------------------------------------------------
# 顶点色烘焙
# --------------------------------------------------------------------------

def ensure_material(path: str) -> bool:
    """
    确保 GLB 带材质定义。

    trimesh 从 PLY 转 GLB 时不写 materials，而没有材质的 glTF 在部分渲染器里
    不会启用顶点色（会显示成白模）。这里补一个哑光 PBR 材质；
    渲染器检测到 COLOR_0 后会自动打开 vertexColors。
    """
    raw = open(path, "rb").read()
    if len(raw) < 12 or raw[:4] != b"glTF":
        return False

    chunks = []
    off = 12
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        chunks.append((ctype, raw[off + 8:off + 8 + clen]))
        off += 8 + clen

    js = None
    for ctype, data in chunks:
        if ctype == b"JSON":
            js = json.loads(data.decode("utf-8"))
            break
    if js is None:
        return False

    if js.get("materials"):
        return False  # 已有材质，无需处理

    js["materials"] = [{
        "name": "vertexColorMatte",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.85,
        },
        "doubleSided": True,
    }]
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            prim.setdefault("material", 0)

    # 重新打包：JSON 用 0x20 补齐，BIN 用 0x00 补齐（glTF 2.0 规范要求）
    out = bytearray()
    body = bytearray()
    for ctype, data in chunks:
        if ctype == b"JSON":
            payload = json.dumps(js, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            pad = (4 - len(payload) % 4) % 4
            payload += b"\x20" * pad
        else:
            payload = data
            pad = (4 - len(payload) % 4) % 4
            payload += b"\x00" * pad
        body += struct.pack("<I", len(payload)) + ctype + payload

    total = 12 + len(body)
    out += struct.pack("<III", 0x46546C67, 2, total) + body
    with open(path, "wb") as f:
        f.write(out)
    print(f"      已注入材质 -> {os.path.basename(path)}", file=sys.stderr)
    return True


def bake_vertex_colors(uv: np.ndarray, tex_bytes: bytes) -> np.ndarray:
    """按 UV 采样贴图，得到顶点 RGB（0-255 整数）。"""
    import io

    img = Image.open(io.BytesIO(tex_bytes)).convert("RGB")
    arr = np.asarray(img)
    h, w, _ = arr.shape

    u = np.clip(uv[:, 0], 0.0, 1.0)
    v = np.clip(uv[:, 1], 0.0, 1.0)
    # glTF 的 UV 原点在图像左上角，与 PIL 一致，不做 v 翻转
    x = np.round(u * (w - 1)).astype(np.int64)
    y = np.round(v * (h - 1)).astype(np.int64)
    return arr[y, x].astype(np.uint8)


def write_obj_vcolors(path: str, verts, faces, colors):
    """写出带顶点色的 OBJ（v x y z r g b，rgb 为 0-1 浮点）。"""
    with open(path, "w", encoding="utf-8") as f:
        n = min(len(verts), len(colors))
        for i in range(len(verts)):
            if i < n:
                r, g, b = colors[i] / 255.0
            else:
                r = g = b = 1.0
            f.write(f"v {verts[i][0]:.6f} {verts[i][1]:.6f} {verts[i][2]:.6f} "
                    f"{r:.6f} {g:.6f} {b:.6f}\n")
        for tri in faces:
            f.write(f"f {tri[0] + 1} {tri[1] + 1} {tri[2] + 1}\n")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=None, help="输入高模（--patch-only 时不需要）")
    ap.add_argument("--targets", nargs="+", type=int, default=[1600])
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--keep-temp", action="store_true", help="保留中间 OBJ")
    ap.add_argument("--patch-only", nargs="*", default=None,
                    help="只给指定 GLB 注入材质定义，不做减面")
    args = ap.parse_args()

    if args.patch_only is not None:
        for p in args.patch_only:
            if os.path.isfile(p):
                ensure_material(p)
            else:
                print(f"[WARN] 跳过（不存在）: {p}", file=sys.stderr)
        return

    src = args.input
    if not os.path.isfile(src):
        print(f"[FATAL] 输入不存在: {src}", file=sys.stderr)
        sys.exit(1)

    outdir = args.outdir or os.path.join(os.path.dirname(os.path.abspath(src)), "game_ready")
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(src))[0]
    tmp = os.path.join(outdir, "_tmp")
    os.makedirs(tmp, exist_ok=True)

    print("[1/4] 解析 GLB ...", file=sys.stderr)
    verts, faces, uv, textures = parse_glb(src)
    print(f"      顶点 {len(verts)} / 面 {len(faces)} / "
          f"UV {'有' if uv is not None else '无'} / 贴图 {list(textures)}", file=sys.stderr)

    colors = None
    if uv is not None and textures.get("baseColor"):
        print("[2/4] 采样 baseColor -> 顶点色 ...", file=sys.stderr)
        colors = bake_vertex_colors(uv, textures["baseColor"])
        # 顺手把贴图也落盘，方便后续在 DCC 里手工重烘焙
        for name, data in textures.items():
            if data:
                with open(os.path.join(outdir, f"{base}_{name}.png"), "wb") as f:
                    f.write(data)
        print(f"      已烘焙 {len(colors)} 个顶点颜色，贴图另存至 {outdir}", file=sys.stderr)
    else:
        print("[2/4] 缺少 UV 或 baseColor 贴图，跳过着色（将产出白模）", file=sys.stderr)

    tmp_obj = os.path.join(tmp, "src_vcol.obj")
    if colors is not None:
        write_obj_vcolors(tmp_obj, verts, faces, colors)
    else:
        write_obj_vcolors(tmp_obj, verts, faces,
                          np.full((len(verts), 3), 255, dtype=np.uint8))

    ms = ml.MeshSet()
    results = []

    print("[3/4] 减面 ...", file=sys.stderr)
    for target in sorted(set(args.targets), reverse=True):
        ms.load_new_mesh(tmp_obj)
        before = ms.current_mesh().face_number()
        if before <= target:
            print(f"      [WARN] 输入 {before} 面已低于目标 {target}，跳过", file=sys.stderr)
            continue

        # ⚠️ 混元 GLB 的顶点带大量重复(split per-UV-vertex)，pymeshlab 直接加载
        # 拓扑建不起来(edge=0)，QEM 边坍缩全部失效、退化成"删面"——
        # 实测 80000→1599 面时表面积保持率仅 1.9%，网格碎成渣(就是"角色透明"事故的根因)。
        # 必须先焊接重复顶点、修非流形，再减面；焊后 QEM 面积保持率 91.5%。
        ms.meshing_remove_duplicate_faces()
        ms.meshing_remove_duplicate_vertices()
        ms.meshing_repair_non_manifold_edges()
        ms.meshing_repair_non_manifold_vertices()
        before = ms.current_mesh().face_number()
        print(f"      拓扑清理后 {before} 面 / {ms.current_mesh().vertex_number()} 顶点",
              file=sys.stderr)

        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target,
            qualitythr=1.0,
            preserveboundary=False,   # 必须放开：护住 UV 接缝就永远压不到 2%
            preservenormal=True,      # 保住硬边，盾板/护甲不塌成软面
            preservetopology=False,
            optimalplacement=True,
            planarquadric=True,
            qualityweight=True,
            autoclean=True,
        )
        after = ms.current_mesh().face_number()
        stem = f"{base}_{target}tris"
        obj_path = os.path.join(outdir, f"{stem}.obj")
        ply_path = os.path.join(outdir, f"{stem}.ply")
        ms.save_current_mesh(obj_path, save_vertex_color=True)
        ms.save_current_mesh(ply_path, save_vertex_color=True)

        pct = (1 - after / before) * 100
        print(f"      {target:>6} 面 -> 实际 {after:>6} 面  (减 {pct:.1f}%)", file=sys.stderr)
        results.append({
            "target": target, "faces": after,
            "vertices": ms.current_mesh().vertex_number(),
            "reduction_pct": round(pct, 2),
            "obj": obj_path, "ply": ply_path,
        })

    # 转成 GLB（pymeshlab 不支持直接导出 glb，用 trimesh 转一手）
    print("[4/4] 转换 GLB ...", file=sys.stderr)
    try:
        import trimesh
        for r in results:
            try:
                m = trimesh.load(r["ply"], force="mesh", process=False)
                glb_path = os.path.join(outdir, f"{base}_{r['target']}tris.glb")
                m.export(glb_path)
                ensure_material(glb_path)
                r["glb"] = glb_path
                vc = getattr(m.visual, "vertex_colors", None)
                print(f"      {os.path.basename(glb_path)}  "
                      f"顶点色={'有' if vc is not None else '无'}", file=sys.stderr)
            except Exception as e:
                print(f"      [WARN] GLB 转换失败 ({r['target']}): {e}", file=sys.stderr)
    except ImportError:
        print("      [WARN] 缺少 trimesh，跳过 GLB 转换", file=sys.stderr)

    if not args.keep_temp:
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)

    print(json.dumps({
        "input": src,
        "source_faces": len(faces),
        "baked_vertex_color": colors is not None,
        "outdir": outdir,
        "outputs": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
