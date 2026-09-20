# -*- coding: utf-8 -*-
"""角色 LOD 贴图重烘焙（正式版）：原生高模贴图 → 空间映射转移 → 低模 UV。

取代已弃用的 bake_lowpoly.py（顶点色平涂，糊 + UV 无法复用）。
方法：低模 UV 每像素 → 反算 3D 点 → 空间网格找高模最近三角形（面级精确投影）→
     重心坐标采高模原生 baseColor 贴图 → 写回该像素。
     面级投影 = 逐面精确最近点，missproj≈0；比「最近顶点+1-ring」质量高得多。

用法:
  python bake_texture_transfer.py --char E-01 [--size 1024] [--skip-rig]
  python bake_texture_transfer.py --char all [--size 1024]

动作:
  1. 备份目标文件为 *.pre-rebake.bak（已存在则跳过，绝不低于备份）
  2. LOD1（textured/*_baked.glb）换贴图
  3. LOD2/LOD3（rigged/*_rigged*.glb）同步换贴图（--skip-rig 跳过）
  4. 旁路输出 <name>_baseColor.png 便于人工检查
"""
import os, sys, struct, json, shutil, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from collections import defaultdict
from io import BytesIO

CHARS = r"C:\Users\fangy\WorkBuddy\game-design-zombie\assets\characters\models"

# ---------------- glb 基础 ----------------
def read_glb(path):
    buf = open(path, "rb").read()
    assert buf[0:4] == b"glTF", f"{path} 不是 glb"
    off = 12; js = None; bd = None
    while off + 8 <= len(buf):
        ln = struct.unpack("<I", buf[off:off+4])[0]
        ty = struct.unpack("<I", buf[off+4:off+8])[0]
        s = off + 8
        if ty == 0x4E4F534A: js = json.loads(buf[s:s+ln])
        elif ty == 0x004E4942: bd = buf[s:s+ln]
        off = s + ln + ((4 - ln % 4) % 4)
    return js, bd

def read_acc(js, bd, idx):
    acc = js["accessors"][idx]
    bv = js["bufferViews"][acc["bufferView"]]
    comp = {5126: ("<f4", 4), 5123: ("<u2", 2), 5125: ("<u4", 4), 5121: ("<u1", 1)}[acc["componentType"]]
    tp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dt, cs = comp
    stride = bv.get("byteStride") or cs * tp
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    n = acc["count"]
    if stride == cs * tp:
        return np.frombuffer(bd, dtype=dt, count=n * tp, offset=start).reshape(n, tp).astype(np.float64)
    arr = np.frombuffer(bd, dtype=np.uint8, count=n * stride, offset=start).reshape(n, stride)
    return np.ascontiguousarray(arr[:, :cs * tp]).view(np.dtype(dt)).reshape(n, tp).astype(np.float64)

def node_world(js, node_idx):
    nodes = js["nodes"]
    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        M = np.eye(4)
        t = np.array(n.get("translation", [0, 0, 0]))
        r = np.array(n.get("rotation", [0, 0, 0, 1]))
        s = np.array(n.get("scale", [1, 1, 1]))
        x, y, z, w = r
        R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                      [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                      [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
        M[:3, :3] = R * s
        M[:3, 3] = t
        return M
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []) or []:
            parent[c] = i
    chain = [node_idx]
    while chain[-1] in parent:
        chain.append(parent[chain[-1]])
    M = np.eye(4)
    for idx in reversed(chain):
        M = M @ local(nodes[idx])
    return M

def load_static(path):
    """静态网格 → (V, F, UV, baseColor Image)。skinned 返回 None。"""
    js, bd = read_glb(path)
    if js.get("skins"):
        return None
    V = F = UV = None
    tex = None
    for mi, mesh in enumerate(js.get("meshes", [])):
        for prim in mesh.get("primitives", []):
            attr = prim.get("attributes", {})
            if "POSITION" not in attr:
                continue
            M = np.eye(4)
            for ni, n in enumerate(js.get("nodes", [])):
                if n.get("mesh") == mi:
                    M = node_world(js, ni)
                    break
            v = read_acc(js, bd, attr["POSITION"])
            v = v @ M[:3, :3].T + M[:3, 3]
            f = read_acc(js, bd, prim["indices"]).astype(np.int64).reshape(-1, 3)
            uv = read_acc(js, bd, attr["TEXCOORD_0"]) if "TEXCOORD_0" in attr else None
            if V is None:
                V, F, UV = v, f, uv
            else:
                F = np.vstack([F, f + len(V)])
                V = np.vstack([V, v])
                if uv is not None and UV is not None:
                    UV = np.vstack([UV, uv])
    mat = js["materials"][0] if js.get("materials") else None
    if mat and mat.get("pbrMetallicRoughness", {}).get("baseColorTexture"):
        img_idx = js["textures"][mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]
        im = js["images"][img_idx]
        if "bufferView" in im:
            bv = js["bufferViews"][im["bufferView"]]
            blob = bd[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
            tex = Image.open(BytesIO(blob)).convert("RGB")
    return V, F, UV, tex

def norm_v(V):
    """footprint 归一：XZ 最长轴 → 1、XZ 居中、Y 贴地。与 env_transfer 一致。"""
    size = V.max(0) - V.min(0)
    W = V - V.min(0)
    s = 1.0 / max(size[0], size[2])
    out = W * s
    out[:, 0] -= (out[:, 0].max() + out[:, 0].min()) / 2
    out[:, 2] -= (out[:, 2].max() + out[:, 2].min()) / 2
    out[:, 1] -= out[:, 1].min()
    return out

def closest_on_segment(P, A, B):
    ab = B - A
    denom = np.maximum((ab * ab).sum(-1), 1e-18)
    t = np.clip(((P - A) * ab).sum(-1) / denom, 0.0, 1.0)
    return A + t[..., None] * ab

def closest_point_on_tri(P, A, B, C):
    """P,A,B,C: (n,3)。返回 (n,3) 最近点（内部投影/三边/三顶点取最近）。"""
    ab = B - A; ac = C - A; ap = P - A
    n_ab = (ab * ab).sum(-1); n_ac = (ac * ac).sum(-1)
    d = n_ab * n_ac - (ab * ac).sum(-1) ** 2
    safe = np.abs(d) > 1e-14
    v = np.zeros(len(P)); w = np.zeros(len(P))
    v[safe] = ((n_ac[safe] * (ap[safe] * ab[safe]).sum(-1)
                - (ab[safe] * ac[safe]).sum(-1) * (ap[safe] * ac[safe]).sum(-1)) / d[safe])
    w[safe] = ((n_ab[safe] * (ap[safe] * ac[safe]).sum(-1)
                - (ab[safe] * ac[safe]).sum(-1) * (ap[safe] * ab[safe]).sum(-1)) / d[safe])
    u = 1 - v - w
    inside = safe & (u >= 0) & (v >= 0) & (w >= 0)
    proj = A + v[:, None] * ab + w[:, None] * ac
    cands = [closest_on_segment(P, A, B), closest_on_segment(P, A, C), closest_on_segment(P, B, C)]
    cand = np.stack(cands + [A, B, C, proj], axis=1)
    dist = ((cand - P[:, None, :]) ** 2).sum(-1)
    pick = np.argmin(dist, axis=1)
    idx = np.arange(len(P))
    return cand[idx, pick]

def transfer(hp, lp, size=1024):
    """空间映射转移。hp=(V,F,UV,tex) 高模；lp=(V,F,UV) 低模。返回 (贴图, 统计)。"""
    V_hp, F_hp, UV_hp, tex = hp
    V_lp, F_lp, UV_lp = lp
    if tex is None:
        raise RuntimeError("raw 无贴图")
    A_h = norm_v(V_hp)
    A_l = norm_v(V_lp)
    span = (A_l.max(0) - A_l.min(0)).max()
    cell = span / 40
    cents = (A_h[F_hp[:, 0]] + A_h[F_hp[:, 1]] + A_h[F_hp[:, 2]]) / 3
    keys = np.floor(cents / cell).astype(np.int64)
    grid = defaultdict(list)
    for fi, k in enumerate(keys):
        grid[tuple(k)].append(fi)
    arr_hp = np.asarray(tex)
    HW, HH = tex.size
    idmap = Image.new("I", (size, size), 0)
    dr = ImageDraw.Draw(idmap)
    uvp = np.stack([UV_lp[:, 0] * (size - 1), (1.0 - UV_lp[:, 1]) * (size - 1)], axis=1)
    for ti, (a, b, c) in enumerate(F_lp):
        dr.polygon([tuple(uvp[a]), tuple(uvp[b]), tuple(uvp[c])], fill=ti + 1)
    idarr = np.asarray(idmap)
    ys, xs = np.where(idarr > 0)
    a, b, c = F_lp[idarr[ys, xs] - 1].T
    p = np.stack([xs + 0.5, ys + 0.5], axis=1).astype(np.float64)
    p0, p1, p2 = uvp[a], uvp[b], uvp[c]
    d = (p1[:, 1] - p2[:, 1]) * (p0[:, 0] - p2[:, 0]) + (p2[:, 0] - p1[:, 0]) * (p0[:, 1] - p2[:, 1])
    with np.errstate(divide="ignore", invalid="ignore"):
        w0 = ((p1[:, 1] - p2[:, 1]) * (p[:, 0] - p2[:, 0]) + (p2[:, 0] - p1[:, 0]) * (p[:, 1] - p2[:, 1])) / d
        w1 = ((p2[:, 1] - p0[:, 1]) * (p[:, 0] - p2[:, 0]) + (p0[:, 0] - p2[:, 0]) * (p[:, 1] - p2[:, 1])) / d
    w0 = np.nan_to_num(w0); w1 = np.nan_to_num(w1)
    w2 = 1 - w0 - w1
    P3 = w0[:, None] * A_l[a] + w1[:, None] * A_l[b] + w2[:, None] * A_l[c]
    # 27 邻域格子 → (像素, 面) 配对
    ck = np.floor(P3 / cell).astype(np.int64)
    pix_parts, face_parts = [], []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cell_key = ck + np.array([dx, dy, dz])
                order = np.lexsort((cell_key[:, 2], cell_key[:, 1], cell_key[:, 0]))
                sk = cell_key[order]
                uniq, start = np.unique(sk, axis=0, return_index=True)
                start = np.sort(start)
                bounds = np.append(start, len(sk))
                for ui in range(len(uniq)):
                    faces = grid.get(tuple(uniq[ui]))
                    if not faces:
                        continue
                    pix = order[bounds[ui]:bounds[ui + 1]]
                    fa = np.array(faces)
                    pix_parts.append(np.repeat(pix, len(fa)))
                    face_parts.append(np.tile(fa, len(pix)))
    pix_all = np.concatenate(pix_parts)
    face_all = np.concatenate(face_parts)
    best_dist = np.full(len(P3), 1e18)
    best_face = np.full(len(P3), -1, dtype=np.int64)
    CH = 400_000
    Fa = A_h[F_hp[:, 0]]; Fb = A_h[F_hp[:, 1]]; Fc = A_h[F_hp[:, 2]]
    for s0 in range(0, len(pix_all), CH):
        sl = slice(s0, s0 + CH)
        pi = pix_all[sl]; fi = face_all[sl]
        cp = closest_point_on_tri(P3[pi], Fa[fi], Fb[fi], Fc[fi])
        d2 = ((cp - P3[pi]) ** 2).sum(-1)
        upd = d2 < best_dist[pi]
        pi_u = pi[upd]
        best_dist[pi_u] = d2[upd]
        best_face[pi_u] = fi[upd]
    hit_idx = np.where(best_face >= 0)[0]
    med = float(np.sqrt(np.median(best_dist[hit_idx]))) if len(hit_idx) else -1
    out = np.full((size, size, 3), 128, dtype=np.uint8)
    for s0 in range(0, len(hit_idx), CH):
        sl = slice(s0, s0 + CH)
        ii = hit_idx[sl]
        fi = best_face[ii]
        cp = closest_point_on_tri(P3[ii], Fa[fi], Fb[fi], Fc[fi])
        A3, B3, C3 = Fa[fi], Fb[fi], Fc[fi]
        v0 = B3 - A3; v1 = C3 - A3; v2v = cp - A3
        d00 = (v0 * v0).sum(-1); d01 = (v0 * v1).sum(-1); d11 = (v1 * v1).sum(-1)
        d20 = (v2v * v0).sum(-1); d21 = (v2v * v1).sum(-1)
        den = d00 * d11 - d01 * d01
        den = np.where(np.abs(den) < 1e-14, 1e-14, den)
        vv = (d11 * d20 - d01 * d21) / den
        ww = (d00 * d21 - d01 * d20) / den
        uu = 1 - vv - ww
        uv = uu[:, None] * UV_hp[F_hp[fi, 0]] + vv[:, None] * UV_hp[F_hp[fi, 1]] + ww[:, None] * UV_hp[F_hp[fi, 2]]
        sx = np.clip((uv[:, 0] * (HW - 1)).astype(int), 0, HW - 1)
        sy = np.clip(((1.0 - uv[:, 1]) * (HH - 1)).astype(int), 0, HH - 1)
        out[ys[ii], xs[ii]] = arr_hp[sy, sx]
    # 前景外扩去白边
    img = Image.fromarray(out)
    alpha = Image.new("L", (size, size), 0)
    ad = ImageDraw.Draw(alpha)
    for ti, (a2, b2, c2) in enumerate(F_lp):
        ad.polygon([tuple(uvp[a2]), tuple(uvp[b2]), tuple(uvp[c2])], fill=255)
    bg = img.filter(ImageFilter.MaxFilter(5))
    img = Image.composite(img, bg, alpha.filter(ImageFilter.MaxFilter(5)))
    st = dict(pix=len(ys), hit=len(hit_idx), miss3d=len(ys) - len(hit_idx),
              median_dist=med, span=float(span))
    return img, st

def repack(target_path, tex_img):
    """几何/skin/node 原样，仅替换 baseColor 贴图。双 chunk 4 对齐 + buffers 同步。"""
    buf = open(target_path, "rb").read()
    off = 12; js = None; bd = None
    while off + 8 <= len(buf):
        ln = struct.unpack("<I", buf[off:off+4])[0]
        ty = struct.unpack("<I", buf[off+4:off+8])[0]
        s = off + 8
        if ty == 0x4E4F534A: js = json.loads(buf[s:s+ln])
        elif ty == 0x004E4942: bd = buf[s:s+ln]
        off = s + ln + ((4 - ln % 4) % 4)
    pio = BytesIO(); tex_img.save(pio, "PNG")
    png = pio.getvalue()
    png_pad = (4 - len(png) % 4) % 4
    new_bin = bd + png + b"\x00" * png_pad
    new_bv = len(js["bufferViews"])
    js["bufferViews"].append({"buffer": 0, "byteOffset": len(bd), "byteLength": len(png)})
    js["images"][0]["bufferView"] = new_bv
    js["images"][0]["name"] = "baseColor-transferred"
    js["images"][0]["mimeType"] = "image/png"
    js["buffers"][0]["byteLength"] = len(new_bin)
    js_bin = json.dumps(js, separators=(",", ":")).encode("utf8")
    js_pad = (4 - len(js_bin) % 4) % 4
    js_bin += b" " * js_pad
    total = 12 + 8 + len(js_bin) + 8 + len(new_bin)
    out = b"glTF" + struct.pack("<II", 2, total)
    out += struct.pack("<II", len(js_bin), 0x4E4F534A) + js_bin
    out += struct.pack("<II", len(new_bin), 0x004E4942) + new_bin
    assert len(out) == total
    open(target_path, "wb").write(out)

def find_raw(cdir, cid):
    stem = cid.replace("-", "")
    pat = re.compile(rf"^{re.escape(stem)}_\d{{8}}_\d{{6}}\.glb$")
    for f in os.listdir(cdir):
        if pat.match(f):
            return os.path.join(cdir, f)
    return None

def process(cid, size=1024, skip_rig=False):
    cdir = os.path.join(CHARS, cid)
    raw = find_raw(cdir, cid)
    tex_dir = os.path.join(cdir, "textured")
    baked = None
    if os.path.isdir(tex_dir):
        for f in os.listdir(tex_dir):
            if f.endswith("_baked.glb"):
                baked = os.path.join(tex_dir, f)
                break
    if not raw or not baked:
        print(f"[{cid}] SKIP: raw={raw is not None} baked={baked is not None}")
        return False
    print(f"[{cid}] load ...", flush=True)
    hp = load_static(raw)
    lp = load_static(baked)
    if hp is None or lp is None:
        print(f"[{cid}] SKIP: raw/low 是 skinned")
        return False
    print(f"[{cid}] transfer {size}² ...", flush=True)
    img, st = transfer(hp, (lp[0], lp[1], lp[2]), size)
    print(f"[{cid}] pix={st['pix']} hit={st['hit']} miss3d={st['miss3d']} "
          f"med={st['median_dist']*100:.1f}cm(阈 {st['span']*3:.1f}cm)", flush=True)
    img.save(baked.replace(".glb", "_baseColor.png"))
    bak = baked + ".pre-rebake.bak"
    if not os.path.exists(bak):
        shutil.copy2(baked, bak)
    repack(baked, img)
    print(f"[{cid}] LOD1 done", flush=True)
    if skip_rig:
        return True
    rig_dir = os.path.join(cdir, "rigged")
    if os.path.isdir(rig_dir):
        for f in os.listdir(rig_dir):
            if f.endswith(".glb") and "_rigged" in f and "mixamo" not in f:
                t = os.path.join(rig_dir, f)
                bak2 = t + ".pre-rebake.bak"
                if not os.path.exists(bak2):
                    shutil.copy2(t, bak2)
                repack(t, img)
                print(f"[{cid}]   rigged/{f} done", flush=True)
    return True

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True, help="角色 ID（如 E-01）或 all")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--skip-rig", action="store_true", help="只处理 LOD1，不动 rigged")
    args = ap.parse_args()
    ids = sorted(os.listdir(CHARS)) if args.char == "all" else [args.char]
    ok = fail = 0
    for cid in ids:
        if not os.path.isdir(os.path.join(CHARS, cid)):
            continue
        try:
            if process(cid, args.size, args.skip_rig):
                ok += 1
            else:
                fail += 1
        except Exception as e:
            print(f"[{cid}] ✗ {repr(e)[:120]}")
            fail += 1
    print(f"\nDONE ok={ok} fail={fail}")

if __name__ == "__main__":
    main()
