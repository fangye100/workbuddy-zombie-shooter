# -*- coding: utf-8 -*-
"""
rig_character.py — 把任意「混元 3D 生成的静态角色网格」绑到 HumanIK/Mixamo 22 骨骼上，
保留内嵌 baseColor 贴图。是 rig_e04.py 的通用化版本（E-04 专用逻辑已参数化）。

为什么必须先换空间
------------------
混元产物是 **Z-up**（脚在 z 的一端），HumanIK 骨架（humanik_skeleton.json）是 **Y-up、约
2.05 m、T-pose**。LBS 权重是按「顶点到骨段的最近距离」算的，网格和骨骼必须在同一空间、
同一尺度，否则权重全糊。所以：

  1. Z-up -> Y-up：p' = (x, -z, y)（`--up-flip` 时用 (x, z, -y)，即极性相反的模型）
  2. 等比缩放到骨架高度（默认 2.05 m），让固定世界位的骨点落在对应体段上
  3. 算干净 LBS 权重（最近骨段 + 反距离衰减，clamp 4，归一化）
  4. 保留 TEXCOORD_0 + 内嵌贴图 + 材质
  5. 写出 skins[0]（joints + inverseBindMatrices）与骨节点层级

朝上轴极性自动判定
------------------
混元产物**通常脚在 z-max**，但并非绝对。`--auto-up` 用切片法判定：分别假设两种极性，
看「脚底端 2% 高度范围内的水平截面占比」哪个更大（脚底是接近平面的一片，头顶是尖的）。
判错会让整个模型上下颠倒、权重完全错位，所以默认开启自动判定并打印判据。

空间约定与编辑器对齐
--------------------
apps/lab/shader-lab/src/gpu/gltf.ts 会把归一化矩阵 T 烘进顶点，同时对关节矩阵做共轭
（jointMatrix' = T·raw·T⁻¹）。只要网格与 inverseBindMatrices 共享同一空间（这里是
Y-up 骨架空间），蒙皮就是对的 —— 与已验证的 synthetic_rigged / E-04 rigged 同款。

用法
----
    # 单个角色（自动判定朝上轴，身高从 roster.json 取）
    python rig_character.py --input <混元 glb> --out <rigged glb> --id E-01

    # 显式指定高度、强制极性
    python rig_character.py --input x.glb --out y.glb --height 1.75 --up-flip

    # 批量：扫 models/<ID>/ 下的 textured 产物
    python rig_character.py --batch --outdir-pattern "models/{id}/rigged"
"""
import os
import sys
import json
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G  # noqa: E402
from rig_humanik import compute_lbs_weights  # noqa: E402

DEFAULT_SKELETON = os.path.join(_HERE, "humanik_skeleton.json")
ROSTER = os.path.normpath(os.path.join(_HERE, "..", "roster.json"))
SKELETON_HEIGHT = 2.05  # HumanIK 骨架静置高度，见 humanik_skeleton.json


# ---------------------------------------------------------------- roster ----
def load_roster():
    """返回 {id: {...}}，npcs + bosses 合并。"""
    with open(ROSTER, encoding="utf-8") as f:
        d = json.load(f)
    out = {}
    for key in ("npcs", "bosses"):
        for c in d.get(key, []):
            out[c["id"]] = c
    return out


def roster_height(cid):
    """从 roster 取身高（米）。'1.75 m' -> 1.75。取不到返回 None。"""
    c = load_roster().get(cid)
    if not c:
        return None
    raw = str(c.get("height", "")).replace("m", "").strip()
    try:
        return float(raw)
    except ValueError:
        return None


# ------------------------------------------------------------- up-axis ----
def detect_up_polarity(pos):
    """
    判定 Z-up 网格的极性：脚在 z-max 还是 z-min。

    判据：脚底是一片接近水平的面（鞋底），头顶是尖的。分别取 z 的两端 2% 高度切片，
    比较切片内顶点数占比 —— 脚那一端明显更多。

    返回 (feet_at_zmax: bool, ratio_max, ratio_min)
    """
    z = pos[:, 2]
    zmin, zmax = float(z.min()), float(z.max())
    span = (zmax - zmin) or 1.0
    band = 0.02 * span
    n = len(z)
    ratio_max = float(np.count_nonzero(z >= zmax - band)) / n
    ratio_min = float(np.count_nonzero(z <= zmin + band)) / n
    return ratio_max >= ratio_min, ratio_max, ratio_min


# ----------------------------------------------------------------- rig ----
def rig_glb(input_glb, out_glb, mesh_name=None, height=None,
            skeleton_json=DEFAULT_SKELETON, up_flip=None, auto_up=True):
    """
    绑骨主流程。

    height: 角色目标身高（米）。仅用于**记录**（写进 mesh name extras 不必要），
            网格实际会缩放到骨架高度 2.05 m —— 因为骨点是固定世界位的。
            角色间的相对身高差由编辑器/引擎侧的对象缩放表达，不在绑骨阶段引入，
            否则同一套骨架配不同尺度网格，权重会对不上。
    up_flip: True 强制 (x, z, -y)；False 强制 (x, -z, y)；None + auto_up 则自动判定。
    """
    order, bones = G.load_skeleton(skeleton_json)
    world = G.skeleton_world_translations(order, bones)
    world_mats = G.skeleton_world_matrices(order, bones)
    inv_binds = np.array(
        [G.mat_to_colmajor(G.m_inverse(world_mats[name])) for name in order],
        dtype=np.float64,
    )  # (22, 16)

    js, bin_data = G.read_glb(input_glb)
    prim = js["meshes"][0]["primitives"][0]
    pos = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["POSITION"]])

    # --- 朝上轴极性 -----------------------------------------------------------
    if up_flip is None:
        if auto_up:
            feet_at_zmax, r_max, r_min = detect_up_polarity(pos)
            up_flip = not feet_at_zmax
            print(f"[up  ] auto: 底面占比 zmax={r_max:.4f} zmin={r_min:.4f} "
                  f"-> feet_at_{'zmax' if feet_at_zmax else 'zmin'} "
                  f"(up_flip={up_flip})")
        else:
            up_flip = False

    # --- Z-up -> Y-up + 等比缩放到骨架高度 -----------------------------------
    zmin, zmax = float(pos[:, 2].min()), float(pos[:, 2].max())
    zspan = (zmax - zmin) or 1.0
    s = SKELETON_HEIGHT / zspan
    px, py, pz = pos[:, 0], pos[:, 1], pos[:, 2]
    if up_flip:
        posY = np.stack([s * px, s * pz, s * (-py)], axis=1)
    else:
        posY = np.stack([s * px, s * (-pz), s * py], axis=1)
    # 把脚底压到 y=0（骨架 Hips 在 y=1.0，脚在 y≈0）
    posY[:, 1] -= posY[:, 1].min()

    idx_arr = G.read_accessor(js, bin_data, js["accessors"][prim["indices"]]).astype(np.int64)
    faces = idx_arr.reshape(-1, 3)

    # --- 法线（混元产物通常没有 NORMAL） -------------------------------------
    nrm_attr = prim["attributes"].get("NORMAL")
    if nrm_attr is not None:
        raw_n = G.read_accessor(js, bin_data, js["accessors"][nrm_attr])
        nx, ny, nz = raw_n[:, 0], raw_n[:, 1], raw_n[:, 2]
        nrm = (np.stack([nx, nz, -ny], axis=1) if up_flip
               else np.stack([nx, -nz, ny], axis=1)).astype(np.float32)
    else:
        nrm = G.compute_normals(posY, faces)

    # --- 权重 -----------------------------------------------------------------
    joints, weights = compute_lbs_weights(posY, order, bones, world)
    wsum = weights.sum(axis=1)
    assert np.all(wsum > 1e-6), "zero-weight vertex produced"

    print(f"[rig ] {os.path.basename(input_glb)}  verts={posY.shape[0]}  tris={faces.shape[0]}")
    print(f"[rig ] scale s={s:.4f}  y=[{posY[:,1].min():.3f},{posY[:,1].max():.3f}]  "
          f"wsum=[{wsum.min():.4f},{wsum.max():.4f}]")

    # --- 贴图 / UV ------------------------------------------------------------
    b = G.GLBBuilder()
    has_tex = ("TEXCOORD_0" in prim["attributes"]) and js.get("images")
    uv_acc = img_acc = None
    img_mime = "image/png"
    if has_tex:
        uv = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["TEXCOORD_0"]])
        img_bv = js["images"][0]["bufferView"]
        vb = js["bufferViews"][img_bv]
        img_bytes = bin_data[vb["byteOffset"]: vb["byteOffset"] + vb["byteLength"]]
        img_mime = js["images"][0].get("mimeType", "image/png")
        img_acc = b.add_raw(np.frombuffer(img_bytes, dtype=np.uint8), 5121, 1, "SCALAR")
        uv_acc = b.add_raw(uv, 5126, 2, "VEC2")
        print(f"[tex ] baseColor {len(img_bytes)/1024:.1f} KB ({img_mime})")
    else:
        print("[tex ] 无贴图/UV -> 输出哑光材质")

    p_acc = b.positions(posY)
    n_acc = b.normals(nrm)
    j_acc = b.joints(joints)
    w_acc = b.weights(weights)
    i_acc = b.indices(idx_arr)
    ib_acc = b.mat4s(inv_binds)

    nodes, bone_idx, hips_index, mesh_index = G.build_node_hierarchy(
        order, bones, mesh_node_index=None, skin_index=0)

    attrs = {"POSITION": p_acc, "NORMAL": n_acc, "JOINTS_0": j_acc, "WEIGHTS_0": w_acc}
    if uv_acc is not None:
        attrs["TEXCOORD_0"] = uv_acc

    gltf = {
        "asset": {"version": "2.0", "generator": "rig_character.py"},
        "scene": 0,
        "scenes": [{"nodes": [mesh_index, hips_index]}],
        "nodes": nodes,
        "meshes": [{
            "name": mesh_name or os.path.splitext(os.path.basename(out_glb))[0],
            "primitives": [{"attributes": attrs, "indices": i_acc, "material": 0}],
        }],
        "skins": [{
            "name": "HumanIK",
            "joints": [bone_idx[n] for n in order],
            "inverseBindMatrices": ib_acc,
            "skeleton": hips_index,
        }],
    }
    if has_tex:
        gltf["materials"] = js.get("materials") or [
            {"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "doubleSided": True}]
        gltf["textures"] = js.get("textures", [{"source": 0}])
        gltf["images"] = [{"bufferView": img_acc, "mimeType": img_mime}]
    else:
        gltf["materials"] = [{
            "name": "rigMatte",
            "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.85, 1.0],
                                     "metallicFactor": 0.0, "roughnessFactor": 0.9},
            "doubleSided": True,
        }]

    data = b.build(gltf)
    os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
    with open(out_glb, "wb") as f:
        f.write(data)
    print(f"[rig ] wrote {out_glb}  ({os.path.getsize(out_glb)/1024:.1f} KB)  joints={len(order)}")
    return out_glb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="混元生成的静态角色 GLB")
    ap.add_argument("--out", required=True, help="输出 rigged GLB")
    ap.add_argument("--id", default=None, help="roster 角色 ID（如 E-01），用于取名/身高")
    ap.add_argument("--height", type=float, default=None, help="覆盖 roster 身高（米）")
    ap.add_argument("--mesh-name", default=None)
    ap.add_argument("--skeleton", default=DEFAULT_SKELETON)
    up = ap.add_mutually_exclusive_group()
    up.add_argument("--up-flip", action="store_true", help="强制 (x, z, -y)")
    up.add_argument("--no-up-flip", action="store_true", help="强制 (x, -z, y)")
    ap.add_argument("--no-auto-up", action="store_true", help="关掉朝上轴自动判定")
    args = ap.parse_args()

    h = args.height
    name = args.mesh_name
    if args.id:
        r = load_roster().get(args.id)
        if r:
            h = h if h is not None else roster_height(args.id)
            name = name or f"{args.id.replace('-', '')}_{r.get('en', '')}".strip("_")
            print(f"[roster] {args.id} {r.get('name')} ({r.get('en')})  height={h} m  "
                  f"tris budget={r.get('tris')}")

    flip = True if args.up_flip else (False if args.no_up_flip else None)
    rig_glb(args.input, args.out, mesh_name=name, height=h,
            skeleton_json=args.skeleton, up_flip=flip,
            auto_up=not args.no_auto_up)


if __name__ == "__main__":
    main()
