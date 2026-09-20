#!/usr/bin/env python3
"""环境道具管线：TokenHub 混元 3D glb → 聚类减面 → footprint 归一化 → 低模 OBJ。

关键事实（2026-09-17 实测 8 件得出）：
  1. TokenHub glb 的场景图变换（node.rotation 绕 X 90°）已经把模型摆成
     Y-up 且 y=0 贴地 —— **不需要也不应该再做极性判定**，之前的
     detect_up_axis 会把已正确的模型转坏。
  2. 混元产物是 50 万面的实心/体网格，含大量内部面 —— 「表面积和」「投影
     面积和」类指标分母虚高几十倍，全部失真。有效质检 = 俯视光栅 IoU。
  3. 尺寸归一化按设计表 footprint 各向映射（俯视角游戏 footprint 优先）。

对每件道具（assets/environment/models/<ID>/<ID>.glb）：
  解析 → 应用场景图 TRS → 空间聚类减面到 tris 预算 → footprint 归一化
  → 俯视光栅 IoU 质检（≥65%）→ 输出 <ID>_low.obj（顶点色，Y-up 贴地）

用法：
  python env_pipeline.py            # 处理所有有 raw glb 但没有 low 的
  python env_pipeline.py --only P-11
"""
import importlib.util
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CHAR_TOOLS = os.path.join(HERE, "..", "..", "characters", "_tools")
PROPS = os.path.join(HERE, "..", "props.json")
MODELS = os.path.join(HERE, "..", "models")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def mesh_node_transform(glb_path):
    """读场景图里 mesh 节点的 TRS，返回 4x4 矩阵。"""
    raw = open(glb_path, "rb").read()
    off = 12
    js = None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        if ctype == b"JSON":
            js = json.loads(raw[off + 8:off + 8 + clen].decode("utf-8"))
            break
        off += 8 + clen
    if js is None:
        return np.eye(4)

    def walk(idx, out):
        n = js["nodes"][idx]
        out.append(n)
        for ch in n.get("children", []) or []:
            walk(ch, out)

    root_ids = js.get("scenes", [{}])[0].get("nodes", []) if js.get("scenes") else list(range(len(js.get("nodes", []))))
    nodes = []
    for rid in root_ids:
        walk(rid, nodes)
    mesh_nodes = [n for n in nodes if "mesh" in n]
    if not mesh_nodes:
        return np.eye(4)
    n = mesh_nodes[0]
    t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
    r = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)  # xyzw
    s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
    x, y, z, w = r
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    M = np.eye(4)
    M[:3, :3] = R * s  # (s broadcasting per column)
    M[:3, 3] = t
    return M


def raster_footprint(verts, faces, res=96):
    """俯视光栅：把 XZ 投影光栅化成布尔栅格（轮廓占用）。"""
    xz = verts[:, [0, 2]]
    mn, mx = xz.min(0), xz.max(0)
    span = np.maximum(mx - mn, 1e-9)
    # 面中心点光栅（原始网格 50 万面足够密集；减面后网格另法）
    centroids = xz[faces].mean(axis=1)
    cell = span / res
    idx = np.floor((centroids - mn) / cell).astype(np.int64)
    idx = np.clip(idx, 0, res - 1)
    grid = np.zeros((res, res), dtype=bool)
    grid[idx[:, 0], idx[:, 1]] = True
    return grid, (mn, span)


def raster_footprint_tri(verts, faces, res=96):
    """三角形级俯视光栅（减面后网格用：面少，必须逐面填充三角形覆盖）。"""
    xz = verts[:, [0, 2]]
    mn, mx = xz.min(0), xz.max(0)
    span = np.maximum(mx - mn, 1e-9)
    cell = span / res
    grid = np.zeros((res, res), dtype=bool)
    for tri in faces:
        a, b, c = xz[tri[0]], xz[tri[1]], xz[tri[2]]
        # 三角形 AABB 栅格范围
        lo = np.clip(np.floor((np.minimum(np.minimum(a, b), c) - mn) / cell).astype(int), 0, res - 1)
        hi = np.clip(np.ceil((np.maximum(np.maximum(a, b), c) - mn) / cell).astype(int), 0, res - 1)
        if lo[0] >= hi[0] and lo[1] >= hi[1]:
            grid[lo[0], lo[1]] = True
            continue
        # AABB 内格子中心做点在三角形内测试（向量化小批量）
        gx = np.arange(lo[0], hi[0] + 1)
        gz = np.arange(lo[1], hi[1] + 1)
        GX, GZ = np.meshgrid(gx, gz, indexing="ij")
        px = mn[0] + (GX + 0.5) * cell[0]
        pz = mn[1] + (GZ + 0.5) * cell[1]
        d = ((b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]))
        if abs(d) < 1e-15:
            continue
        l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[1])) / d
        l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[1])) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        grid[GX[inside], GZ[inside]] = True
    return grid


def process(eid, target, footprint):
    src = os.path.join(MODELS, eid, f"{eid}.glb")
    out_obj = os.path.join(MODELS, eid, f"{eid}_low.obj")
    if not os.path.exists(src):
        return False
    if os.path.exists(out_obj):
        return True
    mgr = load("_mgr", os.path.join(CHAR_TOOLS, "make_game_ready.py"))
    dc = load("_dc", os.path.join(CHAR_TOOLS, "decimate_cluster.py"))

    print(f"[{eid}] 解析 glb ...")
    verts, faces, uv, textures = mgr.parse_glb(src)
    M = mesh_node_transform(src)
    verts = verts @ M[:3, :3].T + M[:3, 3]
    print(f"      变换后 y∈[{verts[:,1].min():.3f},{verts[:,1].max():.3f}]（场景图姿态直接采信）")
    colors = mgr.bake_vertex_colors(uv, textures["baseColor"]).astype(np.float64)
    # 🔴 bake_vertex_colors 返回 0-255，不是 0-1！不归一的话 clip(0,1) 会把
    # 一切截成白色（P-11 全白 bug 的根因）。
    if colors.max() > 1.5:
        colors = colors / 255.0

    cell, keep, f2, chosen, nv, nf = dc.cluster_decimate(verts, faces, colors, target)
    print(f"      {len(faces)} 面 → {nf} 面（cell={cell*1000:.0f}mm，目标 {target}）")

    # 重建输出网格（聚类代表点 + 面积加权顶点色）
    ids = np.floor((verts - verts.min(0)) / cell).astype(np.int64)
    key = (ids[:, 0] << 42) | (ids[:, 1] << 21) | ids[:, 2]
    uniq, first, inverse = np.unique(key, return_index=True, return_inverse=True)
    ov = verts[first]
    # chosen 是对「保留面」的索引（f2 已经过 keep 过滤），直接用
    of = f2[chosen]
    kept = faces[keep][chosen]
    tri_c = colors[kept].mean(axis=1)
    a, b, c = ov[of[:, 0]], ov[of[:, 1]], ov[of[:, 2]]
    areas = np.linalg.norm(np.cross(b - a, c - a), axis=1) + 1e-12
    wsum = np.zeros((len(ov), 3)); asum = np.zeros(len(ov))
    for k in range(3):
        np.add.at(wsum, of[:, k], tri_c * areas[:, None])
        np.add.at(asum, of[:, k], areas)
    with np.errstate(invalid="ignore"):
        oc = np.where(asum[:, None] > 0, wsum / np.maximum(asum[:, None], 1e-12), 0.5)

    # 质检：俯视光栅 IoU（对内部面免疫，只比轮廓）
    g_raw, _ = raster_footprint(verts, faces)
    g_low = raster_footprint_tri(ov, of)
    inter = (g_raw & g_low).sum()
    union = (g_raw | g_low).sum()
    iou = inter / max(union, 1)
    print(f"      俯视轮廓 IoU = {iou*100:.1f}%（阈值 65%）")

    # footprint 归一化：XZ 长边对齐 W×D，Y 对齐 H，贴地
    W, D, H = footprint
    size = ov.max(0) - ov.min(0)
    # X/Z 谁对 W 谁对 D：模型 XZ 较长的一侧对 W
    if size[0] >= size[2]:
        sx, sz = W / max(size[0], 1e-9), D / max(size[2], 1e-9)
    else:
        sx, sz = W / max(size[2], 1e-9), D / max(size[0], 1e-9)
    sy = H / max(size[1], 1e-9)
    ov = ov * np.array([sx, sy, sz])
    ov[:, 1] -= ov[:, 1].min()

    with open(out_obj, "w") as f:
        for i in range(len(ov)):
            r, g, b = np.clip(oc[i], 0, 1)
            f.write(f"v {ov[i,0]:.6f} {ov[i,1]:.6f} {ov[i,2]:.6f} {r:.4f} {g:.4f} {b:.4f}\n")
        for t in of:
            f.write(f"f {t[0]+1} {t[1]+1} {t[2]+1}\n")
    print(f"      输出 {out_obj}（{len(ov)}v/{len(of)}f，footprint {W}x{D}x{H}）")
    return True


def main():
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    props = json.load(open(PROPS, encoding="utf-8"))
    ok = fail = skip = 0
    for e in props["entries"]:
        if only and e["id"] != only:
            continue
        try:
            if process(e["id"], e["tris"], e["footprint"]):
                ok += 1
            else:
                skip += 1
        except Exception as ex:
            print(f"[{e['id']}] FAIL {ex}")
            fail += 1
    print(f"\n完成 {ok} / 跳过 {skip} / 失败 {fail}")


if __name__ == "__main__":
    main()
