# -*- coding: utf-8 -*-
"""LOD2/LOD3（+骨骼 / +动画）重制：路线 A 几何 + 复用既有骨架 + 权重转移。

为什么这样做
------------
LOD2/LOD3 与 LOD1 的差别只在「有没有骨架 / 动画」，几何与贴图应当是同一份：
  · 几何 = decimate_uvkeep.low_geometry()（保 UV 减面，直接采原生贴图）
  · 骨架 = **原样复用**既有 rigged glb 的 nodes / skins.inverseBindMatrices / animations
  · 权重 = 从既有 rigged 网格按三维最近邻转移（k=4 反距离加权，取 top-4 归一）

🔴 尺度铁律（必须与 rig_character.py 一致）
------------------------------------------
HumanIK 骨架的骨点是**固定世界坐标**（Hips ≈ y=1.0，总高 2.05 m），所以绑骨阶段的
网格必须等比缩放到 2.05 m 且脚底压到 y=0 —— 否则骨点落不到对应体段上，权重全错。
实测既有 rigged 网格 = 旧 baked × 1.9122（三个轴比值一致，误差 <0.02%），
本条已在 rig_character.py:140 `s = SKELETON_HEIGHT / zspan` 得到印证。
本脚本的 s 直接由「低模自身高度 → 2.05」求得，与管线常数相差 ~0.7%（≈1.4 cm），
对骨骼-体段对齐无实质影响（权重 falloff eps=0.02 m）。

用法
----
  python rig_uvkeep.py --char E-01 --target 3000 --stats
  python rig_uvkeep.py --char E-01 --target 3000 --only rigged
"""
import argparse
import importlib.util
import json
import os
import re
import struct
import sys
import tempfile

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("_uvkeep", os.path.join(_HERE, "decimate_uvkeep.py"))
uk = importlib.util.module_from_spec(_spec)
sys.modules["_uvkeep"] = uk
_spec.loader.exec_module(uk)

ASSETS = os.path.abspath(os.path.join(_HERE, "..", ".."))
MODELS = os.path.join(ASSETS, "characters", "models")

SKELETON_HEIGHT = uk.SKELETON_HEIGHT     # 2.05


# ---------------------------------------------------------------- 读 GLB


def read_glb_raw(path):
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


def acc(js, bd, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    fmt, cs = {5126: ("<f4", 4), 5123: ("<u2", 2), 5125: ("<u4", 4), 5121: ("<u1", 1),
               5120: ("<i1", 1), 5122: ("<i2", 2)}[a["componentType"]]
    nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
    stride = bv.get("byteStride") or cs * nc
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    va = np.frombuffer(bd, dtype=np.dtype((np.void, stride)), count=a["count"], offset=start)
    return np.frombuffer(va.tobytes(), dtype=fmt, count=a["count"] * nc).reshape(-1, nc)


# ---------------------------------------------------------------- 权重转移


def transfer_weights(target_V, src_V, src_joints, src_weights, k=4, eps=1e-4, max_infl=4):
    """目标顶点 ← k 个最近源顶点的反距离加权（再取 top-4 归一）。

    src_joints/src_weights 是既有 rigged 网格的 JOINTS_0/WEIGHTS_0（已归一）。
    """
    n_t = target_V.shape[0]
    out_j = np.zeros((n_t, max_infl), dtype=np.uint16)
    out_w = np.zeros((n_t, max_infl), dtype=np.float64)
    acc_w = {}
    B = 512                      # 分块，避免 (n_t × n_s) 全量矩阵过大
    for s0 in range(0, n_t, B):
        s1 = min(s0 + B, n_t)
        d = target_V[s0:s1, None, :] - src_V[None, :, :]
        d2 = np.einsum("ijk,ijk->ij", d, d)
        kk = min(k, src_V.shape[0])
        idx = np.argpartition(d2, kk - 1, axis=1)[:, :kk]
        dist = np.sqrt(np.take_along_axis(d2, idx, axis=1))
        w = 1.0 / (dist + eps) ** 2
        w /= w.sum(axis=1, keepdims=True)
        for r in range(s1 - s0):
            m = {}
            for c in range(kk):
                si = idx[r, c]
                ww = w[r, c]
                for t in range(max_infl):
                    sw = src_weights[si, t]
                    if sw <= 0:
                        continue
                    j = int(src_joints[si, t])
                    m[j] = m.get(j, 0.0) + ww * float(sw)
            if not m:
                # 兜底：直接用最近源的第一个有效影响
                si = idx[r, 0]
                for t in range(max_infl):
                    if src_weights[si, t] > 0:
                        m[int(src_joints[si, t])] = 1.0
                        break
            items = sorted(m.items(), key=lambda kv: -kv[1])[:max_infl]
            tot = sum(v for _, v in items) or 1.0
            for t, (j, v) in enumerate(items):
                out_j[s0 + r, t] = j
                out_w[s0 + r, t] = v / tot
    return out_j, out_w


# ---------------------------------------------------------------- glb 组装


def prune_base(js, bd):
    """精简 base glb：只保留骨架与动画真正需要的 accessor，重排 bufferViews。

    🔴 为什么必须做：若原样保留旧数据，新 glb 会同时含「旧网格 852 面的全部属性 + 新网格
    3000 面的全部属性」，体积反而比 LOD1 更大（实测 1.9MB → 5.0MB，LOD2 比 LOD1 还大，
    这在 LOD 体系里是反向的、会在量化 HUD 上暴露）。
    保留集 = skins[*].inverseBindMatrices + animations[*].samplers[*].{input,output}，
    旧网格的 POSITION/NORMAL/TEXCOORD/JOINTS/WEIGHTS/indices 全部丢弃（新的会追加）。
    """
    keep = set()
    for sk in js.get("skins", []):
        if "inverseBindMatrices" in sk:
            keep.add(sk["inverseBindMatrices"])
    for an in js.get("animations", []):
        for sp in an["samplers"]:
            keep.add(sp["input"])
            keep.add(sp["output"])
    if not keep:
        raise SystemExit("[FATAL] base glb 没有 skin/animation 可保留，用法有误")

    bvs_needed = sorted({js["accessors"][i]["bufferView"] for i in keep})
    bv_map = {old: new for new, old in enumerate(bvs_needed)}
    old_accs = sorted(keep)
    acc_map = {old: new for new, old in enumerate(old_accs)}

    new_bvs, blob = [], b""
    for old in bvs_needed:
        bv = js["bufferViews"][old]
        o, ln = bv.get("byteOffset", 0), bv["byteLength"]
        off = len(blob)
        blob += bd[o:o + ln]
        blob += b"\x00" * ((4 - len(blob) % 4) % 4)
        new_bvs.append({"buffer": 0, "byteOffset": off, "byteLength": ln})

    new_accs = []
    for old in old_accs:
        a = dict(js["accessors"][old])
        a["bufferView"] = bv_map[a["bufferView"]]
        new_accs.append(a)

    for sk in js.get("skins", []):
        if "inverseBindMatrices" in sk:
            sk["inverseBindMatrices"] = acc_map[sk["inverseBindMatrices"]]
    for an in js.get("animations", []):
        for sp in an["samplers"]:
            sp["input"] = acc_map[sp["input"]]
            sp["output"] = acc_map[sp["output"]]

    # 只留一个 mesh / 一个 primitive（旧几何已被丢弃，留着就是悬空引用）
    js["meshes"] = [{"name": js["meshes"][0].get("name", "LOD"), "primitives": [js["meshes"][0]["primitives"][0]]}]
    js["bufferViews"] = new_bvs
    js["accessors"] = new_accs
    return js, blob


def build_rigged_glb(out_path, base_glb, V, pairs, VT, N, J, W, tex_bytes, mime):
    """以 base_glb（rigged 或 rigged_animated）为容器，替换网格与贴图。

    🔴 nodes / skins / animations **语义原样保留**（骨架与动画不变），只清理无用的
    旧几何数据并把新网格追加进去。
    """
    js, bd = read_glb_raw(base_glb)
    js, bd = prune_base(js, bd)          # ← 先精简（含 accessor/bufferView 重编号）
    V2, VT2, FC, N2 = uk.split_wedges(V, VT, pairs, N)
    assert J.shape[0] == len(V) and W.shape[0] == len(V), (J.shape, W.shape, len(V))
    # wedge 分裂后权重按同一映射重排（split_wedges 的键是 (vi, ti)，顺序即输出顺序）
    key = {}
    for tri in pairs:
        for (vi, ti) in tri:
            if (vi, ti) not in key:
                key[(vi, ti)] = len(key)
    perm = np.zeros(len(V2), dtype=np.int64)
    for kk, j in key.items():
        perm[j] = kk[0]
    J2, W2 = J[perm], W[perm]
    assert np.allclose(W2.sum(1), 1.0, atol=1e-4), f"权重和异常 {W2.sum(1).min()}~{W2.sum(1).max()}"

    nv, nf = len(V2), len(FC)
    pos = np.asarray(V2, dtype="<f4")
    uvs = np.asarray(VT2, dtype="<f4")
    nrm = np.asarray(N2, dtype="<f4")
    jts = np.asarray(J2, dtype="<u2")
    wts = np.asarray(W2, dtype="<f4")
    idx = np.array(FC, dtype=np.uint32).reshape(-1, 3)
    itype = 5125 if nv > 65535 else 5123
    idx = idx.astype("<u4" if itype == 5125 else "<u2")

    blob = bd
    blob += b"\x00" * ((4 - len(blob) % 4) % 4)

    def add_bv(arr, target=None):
        nonlocal blob
        raw = arr if isinstance(arr, (bytes, bytearray)) else arr.tobytes()
        off = len(blob)
        blob += raw
        blob += b"\x00" * ((4 - len(blob) % 4) % 4)
        e = {"buffer": 0, "byteOffset": off, "byteLength": len(raw)}
        if target:
            e["target"] = target
        js["bufferViews"].append(e)
        return len(js["bufferViews"]) - 1

    def add_ac(bv, ctype, count, typ, mn=None, mx=None):
        e = {"bufferView": bv, "componentType": ctype, "count": int(count), "type": typ}
        if mn is not None:
            e["min"] = [float(x) for x in mn]
            e["max"] = [float(x) for x in mx]
        js["accessors"].append(e)
        return len(js["accessors"]) - 1

    a_pos = add_ac(add_bv(pos, 34962), 5126, nv, "VEC3", pos.min(0), pos.max(0))
    a_uv = add_ac(add_bv(uvs, 34962), 5126, nv, "VEC2")
    a_nrm = add_ac(add_bv(nrm, 34962), 5126, nv, "VEC3")
    a_j = add_ac(add_bv(jts, 34962), 5123, nv, "VEC4")
    a_w = add_ac(add_bv(wts, 34962), 5126, nv, "VEC4")
    a_i = add_ac(add_bv(idx, 34963), itype, nf * 3, "SCALAR")

    prim = js["meshes"][0]["primitives"][0]
    prim["attributes"] = {"POSITION": a_pos, "NORMAL": a_nrm,
                          "TEXCOORD_0": a_uv, "JOINTS_0": a_j, "WEIGHTS_0": a_w}
    prim["indices"] = a_i

    if js.get("images"):
        bv_tex = add_bv(tex_bytes)
        js["images"] = [{"bufferView": bv_tex, "mimeType": mime, "name": "baseColor-native"}]
        js["textures"] = [{"sampler": 0, "source": 0}]
        js["samplers"] = [{"magFilter": 9729, "minFilter": 9987,
                           "wrapS": 10497, "wrapT": 10497}]
    js["buffers"] = [{"byteLength": len(blob)}]
    js["asset"]["generator"] = "aether route-A rig_uvkeep"

    jb = json.dumps(js, separators=(",", ":")).encode("utf8")
    jb += b" " * ((4 - len(jb) % 4) % 4)          # JSON chunk 用空格填充
    total = 12 + 8 + len(jb) + 8 + len(blob)
    out = b"glTF" + struct.pack("<II", 2, total)
    out += struct.pack("<II", len(jb), 0x4E4F534A) + jb
    out += struct.pack("<II", len(blob), 0x004E4942) + blob
    assert len(out) == total, (len(out), total)
    assert len(blob) % 4 == 0
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    open(out_path, "wb").write(out)
    return len(out), dict(gltf_vertices=nv, gltf_faces=nf)


# ---------------------------------------------------------------- 流程


def find_files(cid):
    d = os.path.join(MODELS, cid)
    raw = None
    for f in os.listdir(d):
        if re.match(rf"^{cid.replace('-', '')}_\d{{8}}_\d{{6}}\.glb$", f):
            raw = os.path.join(d, f)
            break
    rd = os.path.join(d, "rigged")
    rig = ani = None
    if os.path.isdir(rd):
        for f in os.listdir(rd):
            if f.endswith("_rigged_animated.glb"):
                ani = os.path.join(rd, f)
            elif f.endswith("_rigged.glb"):
                rig = os.path.join(rd, f)
    return raw, rig, ani


def process(cid, target, only=None, tex_weight=1.0, quality=0.6, keep_png=False, log=print):
    raw, rig, ani = find_files(cid)
    if not raw:
        raise SystemExit(f"[FATAL] {cid} 找不到原生高模")
    log(f"\n{'='*74}\n{cid}  raw={os.path.basename(raw)}")

    tmpdir = tempfile.mkdtemp(prefix=f"riguv_{cid}_")
    geo = uk.low_geometry(raw, target, tmpdir, texture_weight=tex_weight, quality=quality, log=log)
    # 🔴 缩放到骨架空间（见文件头「尺度铁律」）
    V = geo["V"]
    h = float(V[:, 1].max() - V[:, 1].min())
    s = SKELETON_HEIGHT / max(h, 1e-9)
    V = V * s
    V[:, 1] -= V[:, 1].min()                      # 脚底压到 y=0
    log(f"      缩放 s={s:.4f}（低模高 {h:.4f} m → 骨架空间 {SKELETON_HEIGHT} m），"
        f"y∈[{V[:,1].min():.3f},{V[:,1].max():.3f}]")

    tex, mime = uk.encode_texture(geo["tex_png"], keep_png)

    results = []
    for tag, base in (("rigged", rig), ("rigged_animated", ani)):
        if only and tag != only:
            continue
        if not base:
            log(f"      [{tag}] 源文件不存在，跳过")
            continue
        # 🔴 首次运行先存原始备份；之后一律从备份读骨架模板 —— 否则幂等重跑会拿到
        # 上一次已被替换过的文件（骨架仍对，但贴图/几何是旧的，且 prune 后结构不同）。
        bak = base + ".pre-uvkeep.bak"
        if not os.path.exists(bak):
            import shutil
            shutil.copy2(base, bak)
            log(f"      [{tag}] 原始备份 → {os.path.basename(bak)}")
        src = bak

        bj, bbd = read_glb_raw(src)
        bpr = bj["meshes"][0]["primitives"][0]
        src_V = acc(bj, bbd, bpr["attributes"]["POSITION"]).astype(np.float64)
        src_J = acc(bj, bbd, bpr["attributes"]["JOINTS_0"]).astype(np.uint16)
        src_W = acc(bj, bbd, bpr["attributes"]["WEIGHTS_0"]).astype(np.float64)
        log(f"      [{tag}] 模板 {len(src_V)} 顶点 / {len(bj['skins'][0]['joints'])} joints / "
            f"{len(bj.get('animations', []))} 动画")

        J, W = transfer_weights(V, src_V, src_J, src_W)
        # QC：新顶点到模板网格的最近距离（对齐体检；点到点，源网格稀疏故量级为面片尺寸）
        d2 = ((V[:, None, :] - src_V[None, :, :]) ** 2).sum(-1)
        dmin = np.sqrt(d2.min(1))
        log(f"      [{tag}] 权重转移完成 | 最近顶点距 med={np.median(dmin)*1000:.1f}mm "
            f"p95={np.percentile(dmin,95)*1000:.1f}mm | 权重和 "
            f"[{W.sum(1).min():.4f},{W.sum(1).max():.4f}]")

        size, ginfo = build_rigged_glb(base, src, V, geo["pairs"], geo["VT"], geo["N"],
                                       J, W, tex, mime)
        log(f"      [{tag}] → {os.path.basename(base)}  {size/1e6:.2f}MB  "
            f"{ginfo['gltf_faces']} 面 / {ginfo['gltf_vertices']} 顶点")
        results.append(dict(tag=tag, out=base, size=size, faces=ginfo["gltf_faces"],
                            verts=ginfo["gltf_vertices"],
                            align_med_mm=round(float(np.median(dmin)) * 1000, 1),
                            align_p95_mm=round(float(np.percentile(dmin, 95)) * 1000, 1)))
    return dict(char=cid, scale=round(float(s), 4), retention=round(geo["retention"], 1),
                lod_faces=geo["faces"], lod_verts=int(geo["V"].shape[0]),
                spread=round(geo["spread"], 1), results=results)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", default="E-01", help="角色 ID，或 all")
    ap.add_argument("--target", type=int, default=3000)
    ap.add_argument("--only", choices=["rigged", "rigged_animated"], default=None)
    ap.add_argument("--tex-weight", type=float, default=1.0)
    ap.add_argument("--quality", type=float, default=0.6)
    ap.add_argument("--keep-png", action="store_true")
    args = ap.parse_args()

    import json as _json
    roster = _json.load(open(os.path.join(ASSETS, "characters", "roster.json"), encoding="utf-8"))
    ids = [c["id"] for c in roster["npcs"] + roster["bosses"]]
    todo = ids if args.char == "all" else [args.char]

    allres = []
    for cid in todo:
        allres.append(process(cid, args.target, args.only, args.tex_weight, args.quality,
                              args.keep_png))
    print("\n" + _json.dumps(allres, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
