# -*- coding: utf-8 -*-
"""路线 A 正式工具：原生高模 → 保 UV 低模 glb（内嵌原生贴图）。零烘焙 / 零重采样 / 零转移。

为什么要这样，别再走回头路（血泪史）
----------------------------------
1. **空间网格聚类减面（v1/v2）产出的三角形横跨模型不同部位**（胸口顶点连到后背），
   这种三角形采任何贴图都是花的。「花脸」的真根因是几何，不是 UV 算法。
   证据：v2 加了接缝屏障后花脸依旧，且面积保持率掉到 56%。
2. **混元高模的几何本体是完美封闭流形**：按位置焊点后 E = 1.5×F、边界边 0、非流形 0。
   表面上那 20% 的「边界边」全是 UV 切分造成的假象（atlas 被切成 1300+ 个小 chart）。
3. 正确做法：**先焊点（保留逐面角 wedge UV），再跑 pymeshlab 的「保纹理 QEM」**
   （`meshing_decimation_quadric_edge_collapse_with_texture`，把 UV 一并纳入二次误差）。
   实测 E-01：79744 面 → 3000 面，1482 顶点，面积保持 92.8%，边界/非流形均 0。
4. UV 布局与原生**完全一致** ⇒ 低模直接内嵌原生 4096² 贴图，不需要任何烘焙/采样。
   LOD0/1/2/3 共用同一张贴图，换贴图不需要重跑减面。

用法
----
  python decimate_uvkeep.py --input <raw.glb> --target 3000 --out <lod1.glb> --stats
  python decimate_uvkeep.py --input <raw.glb> --target 1500 --out x.glb --obj-out x.obj --png
"""
import argparse
import json
import os
import struct
import sys
import tempfile
from io import BytesIO

import numpy as np
import pymeshlab
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------- GLB 读取


def read_glb(path):
    buf = open(path, "rb").read()
    off, js, bd = 12, None, None
    while off + 8 <= len(buf):
        ln, ty = struct.unpack("<II", buf[off:off + 8])
        s = off + 8
        if ty == 0x4E4F534A:
            js = json.loads(buf[s:s + ln])
        elif ty == 0x004E4942:
            bd = buf[s:s + ln]
        off = s + ln + ((4 - ln % 4) % 4)
    return js, bd


def read_acc(js, bd, idx):
    acc = js["accessors"][idx]
    bv = js["bufferViews"][acc["bufferView"]]
    fmt, cs = {5126: ("<f4", 4), 5123: ("<u2", 2), 5125: ("<u4", 4), 5121: ("<u1", 1)}[acc["componentType"]]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    stride = bv.get("byteStride") or cs * ncomp
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    a = np.frombuffer(bd, dtype=np.dtype((np.void, stride)), count=acc["count"], offset=start)
    return np.frombuffer(a.tobytes(), dtype=fmt, count=acc["count"] * ncomp).reshape(-1, ncomp).astype(np.float64)


def node_world(js, ni):
    nodes = js["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in (n.get("children") or [])}

    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        M = np.eye(4)
        t = np.array(n.get("translation", [0, 0, 0]))
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        s = np.array(n.get("scale", [1, 1, 1]))
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M[:3, :3] = R * s
        M[:3, 3] = t
        return M

    chain = [ni]
    while chain[-1] in parent:
        chain.append(parent[chain[-1]])
    M = np.eye(4)
    for i in reversed(chain):
        M = M @ local(nodes[i])
    return M


def load_raw(path):
    """→ (V, F, UV, tex_png_bytes)。V 已应用到世界变换；UV 保持文件里原样，不做翻转。"""
    js, bd = read_glb(path)
    mesh_nodes = [(ni, n) for ni, n in enumerate(js["nodes"]) if "mesh" in n]
    ni, n = mesh_nodes[0]
    M = node_world(js, ni)
    prim = js["meshes"][n["mesh"]]["primitives"][0]
    V = read_acc(js, bd, prim["attributes"]["POSITION"])
    V = V @ M[:3, :3].T + M[:3, 3]
    F = read_acc(js, bd, prim["indices"]).astype(np.int64).reshape(-1, 3)
    UV = read_acc(js, bd, prim["attributes"]["TEXCOORD_0"])
    pbr = js["materials"][prim.get("material", 0)]["pbrMetallicRoughness"]
    tsrc = js["textures"][pbr["baseColorTexture"]["index"]]["source"]
    im = js["images"][tsrc]
    bv = js["bufferViews"][im["bufferView"]]
    png = bd[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    return V, F, UV, png


# ---------------------------------------------------------------- OBJ 读写


def write_obj(path, V, F, UV):
    """v + vt + f v/vt（UV 逐顶点 1:1）。"""
    with open(path, "w", encoding="utf-8") as f:
        for v in V:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        for t in UV:
            f.write(f"vt {t[0]:.6f} {t[1]:.6f}\n")
        for tri in F:
            f.write(f"f {tri[0]+1}/{tri[0]+1} {tri[1]+1}/{tri[1]+1} {tri[2]+1}/{tri[2]+1}\n")


def parse_obj(path):
    """→ (V, VT, FC)。FC[i] = 第 i 面的三个 (v 索引, vt 索引)。"""
    V, VT, FC = [], [], []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.split()
            if not p:
                continue
            if p[0] == "v":
                V.append([float(x) for x in p[1:4]])
            elif p[0] == "vt":
                VT.append([float(p[1]), float(p[2])])
            elif p[0] == "f":
                tri = []
                for tok in p[1:4]:
                    a = tok.split("/")
                    vi = int(a[0]) - 1
                    ti = int(a[1]) - 1 if len(a) > 1 and a[1] else vi
                    tri.append((vi, ti))
                FC.append(tri)
    return np.array(V), np.array(VT), FC


# ---------------------------------------------------------------- 减面


def decimate(src_obj, target, tmpdir, texture_weight=1.0, quality=0.6, threshold_pct=0.0002):
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(src_obj)
    v0 = ms.current_mesh().vertex_matrix().astype(np.float64)
    f0 = ms.current_mesh().face_matrix().astype(np.int64)
    e0 = _topo(v0, f0)

    ms.meshing_merge_close_vertices(threshold=pymeshlab.PercentageValue(threshold_pct))
    v1 = ms.current_mesh().vertex_matrix().astype(np.float64)
    f1 = ms.current_mesh().face_matrix().astype(np.int64)
    e1 = _topo(v1, f1)

    ms.meshing_decimation_quadric_edge_collapse_with_texture(
        targetfacenum=int(target),
        qualitythr=float(quality),
        extratcoordw=float(texture_weight),
        preserveboundary=False,
        boundaryweight=1.0,
        optimalplacement=True,
        planarquadric=True,
    )
    v2 = ms.current_mesh().vertex_matrix().astype(np.float64)
    f2 = ms.current_mesh().face_matrix().astype(np.int64)
    vn2 = ms.current_mesh().vertex_normal_matrix().astype(np.float64)
    e2 = _topo(v2, f2)
    dst = os.path.join(tmpdir, "decimated.obj")
    ms.save_current_mesh(dst)
    info = {"src": e0, "welded": e1, "out": e2}
    return dst, info, (v0, f0), (v2, f2), vn2


def _topo(v, f):
    e = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = np.sort(e, axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return dict(v=int(len(v)), f=int(len(f)), edges=int(len(cnt)),
                boundary=int((cnt == 1).sum()), nonmanifold=int((cnt > 2).sum()))


def tri_area(v, f):
    return float(np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1).sum() / 2)


# ---------------------------------------------------------------- glb 打包


def split_wedges(V, VT, FC, N=None):
    """🔴 OBJ 的 UV 是逐「面角」（wedge），glTF 的 TEXCOORD_0 是逐「顶点」属性。

    直接把 vt 表塞进 glTF 会得到 4209 个 UV 但只有 1482 个 POSITION，
    而 indices 只能引用 POSITION 的下标 ⇒ 前 1482 个 UV 被错配到不相干的顶点上，
    采样整体错位（表现为「颜色整体偏绿/偏移」）。必须在每条 UV 接缝处分裂顶点：
    每个唯一 (v, vt) 对生成一个新 glTF 顶点，POSITION / TEXCOORD_0 / NORMAL 同步复制。
    """
    key = {}
    pos, uv, nor, faces = [], [], [], []
    for tri in FC:
        ftri = []
        for (vi, ti) in tri:
            k = (vi, ti)
            j = key.get(k)
            if j is None:
                j = len(pos)
                key[k] = j
                pos.append(V[vi])
                uv.append(VT[ti])
                if N is not None:
                    nor.append(N[vi])
            ftri.append(j)
        faces.append(ftri)
    return (np.array(pos, dtype=np.float64), np.array(uv, dtype=np.float64),
            np.array(faces, dtype=np.int64),
            None if N is None else np.array(nor, dtype=np.float64))


def build_glb(dst, V, pairs, VT, tex_bytes, mime, N=None):
    """最小 glTF 2.0：一个 mesh + 一个 baseColor 贴图（wedge 已分裂，UV 逐顶点对齐）。

    pairs: 每个面的三个 (v 索引, vt 索引) 对（OBJ 语义）。
    """
    n_base = len(V)
    V, VT, FC, N = split_wedges(V, VT, pairs, N)
    nv, nf = len(V), len(FC)
    pos = np.asarray(V, dtype="<f4")
    uvs = np.asarray(VT, dtype="<f4")
    idx = np.array(FC, dtype=np.uint32).reshape(-1, 3)
    itype, ifmt = (5125, "<u4") if nv > 65535 else (5123, "<u2")
    idx = idx.astype(ifmt)

    def pad(b, n=4):
        return b + b"\x00" * ((n - len(b) % n) % n)

    chunks, offs = [], []
    cur = 0
    for arr in ([pos, uvs, np.asarray(N, dtype="<f4")] if N is not None else [pos, uvs]):
        b = arr.tobytes()
        offs.append(cur)
        chunks.append(pad(b))
        cur += len(pad(b))
    b_idx = idx.tobytes()
    off_idx = cur
    chunks.append(pad(b_idx))
    cur += len(pad(b_idx))
    off_tex = cur
    chunks.append(pad(tex_bytes))
    blob = b"".join(chunks)

    attrs = {"POSITION": 0, "TEXCOORD_0": 1}
    accessors = [
        {"bufferView": 0, "componentType": 5126, "count": nv, "type": "VEC3",
         "min": [float(x) for x in pos.min(0)], "max": [float(x) for x in pos.max(0)]},
        {"bufferView": 1, "componentType": 5126, "count": nv, "type": "VEC2"},
    ]
    n_bv = 3
    if N is not None:
        attrs["NORMAL"] = 2
        accessors.append({"bufferView": 2, "componentType": 5126, "count": nv, "type": "VEC3"})
        n_bv = 4
    idx_acc = len(accessors)
    accessors.append({"bufferView": n_bv - 1, "componentType": itype, "count": nf * 3, "type": "SCALAR"})
    # 重排：POSITION, TEXCOORD_0, [NORMAL], indices, texture
    bufferViews = [
        {"buffer": 0, "byteOffset": offs[0], "byteLength": pos.nbytes, "target": 34962},
        {"buffer": 0, "byteOffset": offs[1], "byteLength": uvs.nbytes, "target": 34962},
    ]
    if N is not None:
        bufferViews.append({"buffer": 0, "byteOffset": offs[2], "byteLength": np.asarray(N, dtype="<f4").nbytes,
                            "target": 34962})
    bufferViews.append({"buffer": 0, "byteOffset": off_idx, "byteLength": len(b_idx), "target": 34963})
    tex_bv = len(bufferViews)
    bufferViews.append({"buffer": 0, "byteOffset": off_tex, "byteLength": len(tex_bytes)})
    # 贴图 bufferView 索引要指向最后那个
    gltf = {
        "asset": {"version": "2.0", "generator": "aether route-A uvkeep decimator"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "LOD1"}],
        "meshes": [{"name": "LOD1", "primitives": [{"attributes": attrs, "indices": idx_acc, "material": 0}]}],
        "materials": [{"name": "baseColor", "doubleSided": False, "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 0.85}}],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "images": [{"bufferView": tex_bv, "mimeType": mime, "name": "baseColor-native"}],
        "accessors": accessors,
        "bufferViews": bufferViews,
        "buffers": [{"byteLength": len(blob)}],
    }
    jb = json.dumps(gltf, separators=(",", ":")).encode("utf8")
    # 🔴 JSON chunk 的填充必须用空格（0x20）：JSON.parse 不认 \x00 是空白，
    # 会在末尾抛 "Unexpected non-whitespace character after JSON"。BIN chunk 才用 \x00。
    jb += b" " * ((4 - len(jb) % 4) % 4)
    total = 12 + 8 + len(jb) + 8 + len(blob)
    out = b"glTF" + struct.pack("<II", 2, total)
    out += struct.pack("<II", len(jb), 0x4E4F534A) + jb
    out += struct.pack("<II", len(blob), 0x004E4942) + blob
    assert len(out) == total, (len(out), total)
    assert len(blob) % 4 == 0
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    open(dst, "wb").write(out)
    return len(out), dict(gltf_vertices=int(nv), gltf_faces=int(nf), base_vertices=int(n_base))


# ---------------------------------------------------------------- 可复用入口

SKELETON_HEIGHT = 2.05   # HumanIK 骨架静置高度，见 humanik_skeleton.json / rig_character.py


def low_geometry(raw_path, target, tmpdir, texture_weight=1.0, quality=0.6, log=print):
    """从原生高模产出「保 UV 低模」几何 —— 路线 A 的共用入口（rig 版也走这里）。

    返回 dict：
      V       低模顶点位置（与原高模同空间，Y-up，脚底 ≈ y=0）
      pairs   每面三个 (v 索引, vt 索引)  ← OBJ wedge 语义
      VT      wedge UV 表（布局 = 原生布局，故可直接采原生贴图）
      N       顶点法线（长度 == len(V)）
      tex_png 原生 baseColor 的 PNG 字节
    """
    V0, F0, UV0, png = load_raw(raw_path)
    log(f"      raw {len(F0)} 面 / {len(V0)} 顶点 / 贴图 {len(png)/1e6:.1f}MB / "
        f"UV∈[{UV0.min():.3f},{UV0.max():.3f}]")
    src_obj = os.path.join(tmpdir, "src.obj")
    write_obj(src_obj, V0, F0, UV0)

    dec_obj, tr, src_vf, out_vf, vn = decimate(src_obj, target, tmpdir,
                                               texture_weight=texture_weight, quality=quality)
    for k in ("src", "welded", "out"):
        t = tr[k]
        log(f"      {k:7s} V={t['v']:6d} F={t['f']:6d} 边界={t['boundary']:6d} "
            f"非流形={t['nonmanifold']:5d}")

    V, VT, FC = parse_obj(dec_obj)
    assert len(vn) == len(V), f"法线数 {len(vn)} != 顶点数 {len(V)}"
    pairs = [[(c[0], c[1]) for c in tri] for tri in FC]
    retention = tri_area(*out_vf) / tri_area(*src_vf) * 100

    # UV 密度探针（见文件头「接缝错位探针」）
    vt_idx = np.array([[c[1] for c in tri] for tri in FC], dtype=np.int64)
    fi = np.array([[c[0] for c in tri] for tri in FC], dtype=np.int64)
    U = VT[vt_idx]
    du, dv = U[:, 1] - U[:, 0], U[:, 2] - U[:, 0]
    a3 = np.linalg.norm(np.cross(V[fi[:, 1]] - V[fi[:, 0]], V[fi[:, 2]] - V[fi[:, 0]]), axis=1) / 2
    auv = np.abs(du[:, 0] * dv[:, 1] - du[:, 1] * dv[:, 0]) / 2
    dens = auv / np.maximum(a3, 1e-12)
    spread = float(np.percentile(dens, 99)) / max(float(np.median(dens)), 1e-12)

    log(f"      低模 {len(FC)} 面 / {len(V)} 顶点 / {len(VT)} vt / 法线 {len(vn)}")
    log(f"      面积保持 {retention:.1f}% | UV∈[{VT.min():.3f},{VT.max():.3f}] | "
        f"UV密度 p99/med={spread:.1f}")
    return dict(V=V, pairs=pairs, VT=VT, N=vn, tex_png=png, info=tr,
                retention=retention, src_faces=len(F0), spread=spread, faces=len(FC))


def encode_texture(png, force_png=False, max_bytes=4_000_000):
    """贴图入库编码：小图保 PNG，大图转 JPEG q92（与 rig 侧现状一致）。"""
    if force_png or len(png) <= max_bytes:
        return png, "image/png"
    im = Image.open(BytesIO(png)).convert("RGB")
    bio = BytesIO()
    im.save(bio, "JPEG", quality=92, optimize=True)
    return bio.getvalue(), "image/jpeg"


def write_obj_simple(path, V, VT, pairs):
    with open(path, "w", encoding="utf-8") as f:
        for v in V:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        for t in VT:
            f.write(f"vt {t[0]:.6f} {t[1]:.6f}\n")
        for tri in pairs:
            f.write("f " + " ".join(f"{a+1}/{b+1}" for a, b in tri) + "\n")


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="原生高模 glb（自带 UV + baseColor 贴图）")
    ap.add_argument("--target", type=int, default=3000,
                    help="目标面数。🔴 ≥2500：852 面级别的预算会把剪影削成麻花")
    ap.add_argument("--out", required=True, help="输出 glb")
    ap.add_argument("--obj-out", default=None, help="额外导出低模 OBJ（调试用）")
    ap.add_argument("--tex-weight", type=float, default=1.0, help="QEM 里 UV 的权重（默认 1.0）")
    ap.add_argument("--quality", type=float, default=0.6)
    ap.add_argument("--png", action="store_true", help="贴图保持 PNG（默认若 >4MB 转 JPEG q92）")
    args = ap.parse_args()

    tmpdir = tempfile.mkdtemp(prefix="uvkeep_")
    print(f"[1/4] 保 UV 减面（{os.path.basename(args.input)} → {args.target} 面）", flush=True)
    geo = low_geometry(args.input, args.target, tmpdir, args.tex_weight, args.quality)

    print("[2/4] 编码贴图", flush=True)
    tex, mime = encode_texture(geo["tex_png"], args.png)
    print(f"      {mime} {len(tex)/1e6:.2f}MB", flush=True)

    print("[3/4] 打包 glb（内嵌原生贴图）", flush=True)
    size, ginfo = build_glb(args.out, geo["V"], geo["pairs"], geo["VT"], tex, mime, N=geo["N"])
    print(f"      {os.path.abspath(args.out)}  {size/1e6:.2f}MB  "
          f"gltf顶点={ginfo['gltf_vertices']}（wedge 分裂自 {ginfo['base_vertices']}）", flush=True)

    if args.obj_out:
        write_obj_simple(args.obj_out, geo["V"], geo["VT"], geo["pairs"])
        print(f"      OBJ → {args.obj_out}", flush=True)

    print("[4/4] " + json.dumps({
        "input": args.input, "out": args.out, "target": args.target,
        "source_faces": geo["src_faces"], "output_faces": geo["faces"],
        "output_vertices": geo["V"].shape[0],
        "gltf_vertices_after_wedge_split": ginfo["gltf_vertices"],
        "welded_vertices": geo["info"]["welded"]["v"],
        "area_retention_pct": round(geo["retention"], 1),
        "output_boundary_edges": geo["info"]["out"]["boundary"],
        "output_nonmanifold_edges": geo["info"]["out"]["nonmanifold"],
        "uv_density_p99_over_med": round(geo["spread"], 1),
        "glb_bytes": size,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
