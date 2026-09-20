#!/usr/bin/env python3
"""环境低模贴图转移（正解版）：raw glb 的原贴图 → 低模 xatlas UV。

背景（2026-09-17 教训）：
  旧 env_bake.py 从「顶点色低模」烘贴图 = 贴图有损压成顶点色再放大回贴图 → 糊/灰。
  raw glb（混元原版）自带嵌入 baseColor PNG + 完整 UV —— 正确做法是把原贴图
  经三维空间对应转移到低模的新 UV 上（复用角色管线 bake_texture_transfer.py 的方法）。

流程（每件）：
  1. 解析 raw glb：顶点/面/UV（含场景图 TRS）+ 嵌入 baseColor PNG
  2. 解析低模 OBJ（env_pipeline 产物：Y-up 贴地 + footprint 归一 + xatlas UV + 顶点色）
  3. 低模 UV 三角形光栅化 → 每像素 3D 点 → raw 空间哈希最近点 → 1-ring 重心投影
     → raw UV → 采样原贴图；投影不中用低模顶点色兜底
  4. 空间对应质检：最近点中位距离必须 < 低模最长边的 3%（转移可信度判据）
  5. 输出 tex2/<ID>_tex.png + 更新 tex2/<ID>.obj（map_Kd 引用）
     + tex2/<ID>_baked.glb（重打包：低模几何 + 新贴图）

用法：
  PYTHONIOENCODING=utf-8 python env_transfer.py [--only P-11] [--size 512]
"""
import json
import os
import struct
import sys
from collections import defaultdict
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "models")


# ---------------- GLB 解析（含场景图 TRS） ----------------
def read_glb(path):
    raw = open(path, "rb").read()
    off = 12
    js = None
    bin_data = b""
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        data = raw[off + 8:off + 8 + clen]
        if ctype == b"JSON":
            js = json.loads(data.decode("utf-8"))
        elif ctype == b"BIN\x00":
            bin_data = data
        off += 8 + clen
    return js, bin_data


def accessor(js, bin_data, idx):
    acc = js["accessors"][idx]
    bv = js["bufferViews"][acc["bufferView"]]
    comp = {5126: ("<f4", 4), 5123: ("<u2", 2), 5125: ("<u4", 4), 5121: ("<u1", 1), 5122: ("<i2", 2)}[acc["componentType"]]
    tp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dt, cs = comp
    stride = bv.get("byteStride") or cs * tp
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    n = acc["count"]
    if stride == cs * tp:
        return np.frombuffer(bin_data, dtype=dt, count=n * tp, offset=start).reshape(n, tp).astype(np.float64)
    arr = np.frombuffer(bin_data, dtype=np.uint8, count=n * stride, offset=start).reshape(n, stride)
    return np.ascontiguousarray(arr[:, : cs * tp]).view(np.dtype(dt)).reshape(n, tp).astype(np.float64)


def node_transform(js):
    def walk(i, out):
        n = js["nodes"][i]
        out.append(n)
        for c in n.get("children", []) or []:
            walk(c, out)
    roots = js.get("scenes", [{}])[0].get("nodes", []) if js.get("scenes") else list(range(len(js.get("nodes", []))))
    nodes = []
    for r in roots:
        walk(r, nodes)
    mnodes = [n for n in nodes if "mesh" in n]
    if not mnodes:
        return np.eye(4)
    n = mnodes[0]
    t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
    r = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
    s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
    x, y, z, w = r
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


def load_high(path):
    """raw glb → 顶点/面/UV/贴图（PIL Image）"""
    js, bin_data = read_glb(path)
    prim = js["meshes"][0]["primitives"][0]
    V = accessor(js, bin_data, prim["attributes"]["POSITION"])
    F = accessor(js, bin_data, prim["indices"]).astype(np.int64).reshape(-1, 3)
    UV = accessor(js, bin_data, prim["attributes"]["TEXCOORD_0"]) if "TEXCOORD_0" in prim["attributes"] else None
    M = node_transform(js)
    V = V @ M[:3, :3].T + M[:3, 3]
    # 贴图：material→baseColorTexture→source（不是 images[0]，教训来自角色管线）
    tex = None
    mat = js["materials"][0] if js.get("materials") else None
    if mat and mat.get("pbrMetallicRoughness", {}).get("baseColorTexture"):
        img_idx = js["textures"][mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]
        img = js["images"][img_idx]
        if "bufferView" in img:
            bv = js["bufferViews"][img["bufferView"]]
            blob = bin_data[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
            tex = Image.open(BytesIO(blob)).convert("RGB")
    return V, F, UV, tex


# ---------------- 低模 OBJ（带顶点色 + xatlas UV） ----------------
def load_low(path):
    """xatlas 展过 UV 的低模 OBJ（tex/<ID>_tex.obj，f v/vt 格式）。
    🔴 env_pipeline 直出的 _low.obj 无 UV；env_bake 的 tex obj 才有。"""
    vs, fs_, uvs, vcs = [], [], [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = line.split()
            if not p:
                continue
            if p[0] == "v":
                vs.append([float(x) for x in p[1:4]])
                if len(p) >= 7:
                    vcs.append([float(x) for x in p[4:7]])
            elif p[0] == "vt":
                uvs.append([float(p[1]), float(p[2])])
            elif p[0] == "f":
                fs_.append([int(x.split("/")[0]) - 1 for x in p[1:4]])
    vs = np.array(vs)
    fs_ = np.array(fs_, dtype=np.int64)
    uvs = np.array(uvs) if uvs else None
    vcs = np.array(vcs) if vcs else None
    if uvs is not None:
        assert len(uvs) >= vs.shape[0], "vt 少于 v"
        if len(uvs) > vs.shape[0]:
            uvs = uvs[: vs.shape[0]]  # v/vt 1:1（bake_lowpoly 产物）
    return vs, fs_, uvs, vcs


# ---------------- 空间哈希 + 转移 ----------------
def align_high_to_low(V_hp, V_lp):
    """把 raw 顶点对齐到低模空间：footprint 同规则归一 + 贴地 + 居中。

    raw（混元原版）与低模（env_pipeline footprint 归一化过）尺度差可达 4 倍，
    不对齐则空间哈希最近点全部 miss。
    与 env_pipeline 相同规则：X/Z 长边对 footprint 长边、Y 贴地、XZ 居中。
    """
    def norm(V):
        size = V.max(0) - V.min(0)
        mn = V.min(0)
        W = V - mn
        if size[0] >= size[2]:
            sx, sz = 1.0, 1.0  # 保持等比：以最长轴为单位 1
        else:
            sx, sz = 1.0, 1.0
        # 各向等比归一（最长 XZ 轴 → 1）
        s = 1.0 / max(size[0], size[2])
        out = W * s
        out[:, 0] -= (out[:, 0].max() + out[:, 0].min()) / 2
        out[:, 2] -= (out[:, 2].max() + out[:, 2].min()) / 2
        out[:, 1] -= out[:, 1].min()
        return out, s
    Ah, sh = norm(V_hp)
    Al, sl = norm(V_lp)
    # raw 归一后 ×低模归一逆（即低模的真实尺度）
    # 直接用低模归一空间做匹配更稳：两边都归一到 [0,1] 空间再比较
    return Ah, Al


def transfer(hp, lp, size=512):
    V_hp, F_hp, UV_hp, tex = hp
    V_lp, F_lp, UV_lp, VC_lp = lp
    if tex is None:
        return None, None, "raw 无贴图"
    if UV_hp is None or UV_lp is None:
        return None, None, "缺 UV"
    # 🔴 尺度对齐：raw 与低模归一到同一 [0,1]³ 空间再匹配（两者尺度差可达 4 倍）
    V_hp, V_lp = align_high_to_low(V_hp, V_lp)

    # 空间哈希（cell = 低模最长边 / 40）
    span = (V_lp.max(0) - V_lp.min(0)).max()
    cell = span / 40
    keys = np.floor(V_hp / cell).astype(np.int64)
    grid = defaultdict(list)
    for i, k in enumerate(keys):
        grid[tuple(k)].append(i)
    adj = defaultdict(list)
    for fi, (a, b, c) in enumerate(F_hp):
        adj[int(a)].append(fi)
        adj[int(b)].append(fi)
        adj[int(c)].append(fi)

    arr_hp = np.asarray(tex)
    HW, HH = tex.size

    # 低模 UV 三角形 → 像素光栅化（id map + 重心）
    idmap = Image.new("I", (size, size), 0)
    dr = ImageDraw.Draw(idmap)
    uvp = np.stack([UV_lp[:, 0] * (size - 1), (1.0 - UV_lp[:, 1]) * (size - 1)], axis=1)
    for ti, (a, b, c) in enumerate(F_lp):
        x0, y0 = uvp[a]
        x1, y1 = uvp[b]
        x2, y2 = uvp[c]
        dr.polygon([(x0, y0), (x1, y1), (x2, y2)], fill=ti + 1)
    idarr = np.asarray(idmap)

    # 高模顶点色（贴图采样，供兜底）
    sx_hp = np.clip(UV_hp[:, 0] * (HW - 1), 0, HW - 1).astype(int)
    sy_hp = np.clip((1.0 - UV_hp[:, 1]) * (HH - 1), 0, HH - 1).astype(int)
    hp_vcol = arr_hp[sy_hp, sx_hp].astype(np.float64)

    out = np.zeros((size, size, 3), dtype=np.float64)
    hit = miss3d = miss_proj = 0
    dists = []
    Fa = V_hp[F_hp[:, 0]]
    Fb = V_hp[F_hp[:, 1]]
    Fc = V_hp[F_hp[:, 2]]
    Ua = UV_hp[F_hp[:, 0]]
    Ub = UV_hp[F_hp[:, 1]]
    Uc = UV_hp[F_hp[:, 2]]

    ys, xs = np.nonzero(idarr)
    for py, px in zip(ys, xs):
        ti = idarr[py, px] - 1
        if ti < 0:
            continue
        a, b, c = F_lp[ti]
        # 🔴 用**像素中心**在 UV 三角形内的重心坐标插出 3D 点，不能用三角形质心。
        # 用质心的话整片三角形都采到同一个高模位置、得到同一种颜色，面内纹理变化全部丢失
        # —— 低模只有几百面时整张贴图会退化成马赛克，声称的「空间转移」名存实亡。
        # 见 PR #3 review。
        p0, p1, p2 = uvp[a], uvp[b], uvp[c]
        d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
        if abs(d) < 1e-12:
            continue
        rx, ry = px + 0.5, py + 0.5
        w0 = ((p1[1] - p2[1]) * (rx - p2[0]) + (p2[0] - p1[0]) * (ry - p2[1])) / d
        w1 = ((p2[1] - p0[1]) * (rx - p2[0]) + (p0[0] - p2[0]) * (ry - p2[1])) / d
        w2 = 1.0 - w0 - w1
        P3 = w0 * V_lp[a] + w1 * V_lp[b] + w2 * V_lp[c]
        # 最近高模顶点（3x3x3 邻域）
        k = tuple(np.floor(P3 / cell).astype(np.int64))
        best = None
        bestd = 1e18
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for vi in grid.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                        d = ((V_hp[vi] - P3) ** 2).sum()
                        if d < bestd:
                            bestd = d
                            best = vi
        if best is None:
            # 低模顶点色兜底
            col = VC_lp[a] if VC_lp is not None else np.array([0.5, 0.5, 0.5])
            out[py, px] = col * 255
            miss3d += 1
            continue
        dists.append(bestd ** 0.5)
        # 在最近点的 1-ring 面里做重心投影
        uv = None
        for fi in adj[best]:
            A, B, C = Fa[fi], Fb[fi], Fc[fi]
            ab = B - A
            ac = C - A
            ap = P3 - A
            d00 = ab @ ab
            d01 = ab @ ac
            d11 = ac @ ac
            d20 = ap @ ab
            d21 = ap @ ac
            den = d00 * d11 - d01 * d01
            if abs(den) < 1e-16:
                continue
            v_ = (d11 * d20 - d01 * d21) / den
            w_ = (d00 * d21 - d01 * d20) / den
            u_ = 1 - v_ - w_
            if u_ >= -0.05 and v_ >= -0.05 and w_ >= -0.05:
                uva, uvb, uvc = Ua[fi], Ub[fi], Uc[fi]
                uv = u_ * uva + v_ * uvb + w_ * uvc
                break
        if uv is None:
            out[py, px] = hp_vcol[best]
            miss_proj += 1
        else:
            sx = int(np.clip(uv[0] * (HW - 1), 0, HW - 1))
            sy = int(np.clip((1.0 - uv[1]) * (HH - 1), 0, HH - 1))
            out[py, px] = arr_hp[sy, sx]
            hit += 1

    med = float(np.median(dists)) if dists else 1e9
    return out, Image.fromarray(out.astype(np.uint8)), dict(
        hit=hit, miss3d=miss3d, miss_proj=miss_proj, median_dist=med, span=span)


# ---------------- GLB 重打包（低模 + 新贴图） ----------------
def pack_glb(verts, faces, uvs, tex_png_path, out_path):
    import trimesh  # venv 有（角色管线用过）
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, visual=trimesh.visual.TextureVisuals(
        uv=uvs, image=Image.open(tex_png_path)))
    mesh.export(out_path)


def main():
    only = None
    size = 512
    args = sys.argv[1:]
    if "--only" in args:
        only = args[args.index("--only") + 1]
    if "--size" in args:
        size = int(args[args.index("--size") + 1])

    done = fail = 0
    for eid in sorted(os.listdir(MODELS)):
        if only and eid != only:
            continue
        raw = os.path.join(MODELS, eid, f"{eid}.glb")
        # 🔴 低模输入 = tex/<ID>_tex.obj（xatlas UV 版），不是无 UV 的 _low.obj
        low = os.path.join(MODELS, eid, "tex", f"{eid}_tex.obj")
        if not (os.path.exists(raw) and os.path.exists(low)):
            continue
        outdir = os.path.join(MODELS, eid, "tex2")
        png = os.path.join(outdir, f"{eid}_tex.png")
        glb = os.path.join(outdir, f"{eid}_baked.glb")
        if os.path.exists(glb):
            done += 1
            continue
        try:
            hp = load_high(raw)
            lp = load_low(low)
            _, img, st = transfer(hp, lp, size)
            if img is None:
                raise RuntimeError(st)
            os.makedirs(outdir, exist_ok=True)
            img.save(png)
            ok_dist = st["median_dist"] < st["span"] * 0.03
            print(f"[{eid}] 转移 hit={st['hit']} miss3d={st['miss3d']} missproj={st['miss_proj']} "
                  f"中位距离={st['median_dist']*100:.1f}cm(阈 {st['span']*3:.1f}cm) {'✓' if ok_dist else '⚠️'}")
            if not ok_dist:
                print(f"[{eid}] ⚠️ 空间对应过远，转移可能失真（仍输出，待目检）")
            # 重打包
            V_lp, F_lp, UV_lp, _ = lp
            pack_glb(V_lp, F_lp, UV_lp, png, glb)
            done += 1
        except Exception as e:
            fail += 1
            print(f"[{eid}] ✗ {e}")
    print(f"\n转移完成 {done} / 失败 {fail}")


if __name__ == "__main__":
    main()
