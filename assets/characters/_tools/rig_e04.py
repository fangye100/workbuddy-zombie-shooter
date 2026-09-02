# -*- coding: utf-8 -*-
"""
rig_e04.py — Rig the REAL E-04 NPC (Hunyuan3D-generated, Z-up) to the HumanIK/Mixamo
22-bone skeleton, preserving its baked baseColor texture.

The raw E-04 GLB is Z-up, ~1.08 m tall, centered near origin. The HumanIK skeleton
(humanik_skeleton.json) is Y-up, ~2.05 m tall, T-pose. To get clean skin weights the
mesh MUST live in the same space as the bones, so we:

  1. Rotate Z-up -> Y-up:  p' = (x, -z, y)   (feet at z=0 -> y=0, head at z=-1.08 -> y≈+1.08)
  2. Uniform-scale to 2.05 m height so bones (at fixed world positions) line up with body parts.
  3. Compute clean LBS weights (nearest-bone-segment inverse-distance falloff, clamp 4, normalize).
  4. Preserve the embedded baseColor texture + material + TEXCOORD_0.
  5. Emit skins[0] (joints + inverseBindMatrices) and a bone node hierarchy.

Convention match: apps/lab/shader-lab/src/gpu/gltf.ts bakes a normalization matrix T into
vertices AND conjugates joint matrices by T (jointMatrix' = T·raw·T⁻¹), so as long as the
mesh and inverseBindMatrices share one space (here Y-up skeleton space) skinning is correct.
This is exactly what the validated synthetic_rigged GLB already does.

Usage:
    python rig_e04.py --input <textured E-04 glb> --out <rigged glb> [--skeleton humanik_skeleton.json]
"""
import os
import sys
import json
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G  # noqa: E402
from rig_humanik import compute_lbs_weights, bone_segments  # noqa: E402

DEFAULT_SKELETON = os.path.join(_HERE, "humanik_skeleton.json")
TARGET_HEIGHT = 2.05  # metres — matches HumanIK Hips(1.0)+legs; see humanik_skeleton.json


def rig_e04_glb(input_glb, out_glb, skeleton_json=DEFAULT_SKELETON):
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

    # --- Z-up -> Y-up + uniform scale to target height -------------------------
    zmin, zmax = float(pos[:, 2].min()), float(pos[:, 2].max())
    zspan = (zmax - zmin) or 1.0
    s = TARGET_HEIGHT / zspan
    px, py, pz = pos[:, 0], pos[:, 1], pos[:, 2]
    posY = np.stack([s * px, s * (-pz), s * py], axis=1)  # feet->y=0, head->y≈2.05

    # --- normals (E-04 has none) ----------------------------------------------
    idx_arr = G.read_accessor(js, bin_data, js["accessors"][prim["indices"]]).astype(np.int64)
    faces = idx_arr.reshape(-1, 3)
    nrm = G.compute_normals(posY, faces)

    # --- skin weights ---------------------------------------------------------
    joints, weights = compute_lbs_weights(posY, order, bones, world)
    wsum = weights.sum(axis=1)
    assert np.all(wsum > 1e-6), "zero-weight vertex produced"

    # --- carry texture + uv ---------------------------------------------------
    uv = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["TEXCOORD_0"]])
    img_bv = js["images"][0]["bufferView"]
    vb = js["bufferViews"][img_bv]
    img_bytes = bin_data[vb["byteOffset"]: vb["byteOffset"] + vb["byteLength"]]
    img_mime = js["images"][0].get("mimeType", "image/png")

    print(f"[rig ] {os.path.basename(input_glb)}  verts={posY.shape[0]}  tris={faces.shape[0]}")
    print(f"[rig ] Z-up->Y-up scale s={s:.4f}  bounds y=[{posY[:,1].min():.2f},{posY[:,1].max():.2f}]")

    # --- assemble new GLB (texture preserved) --------------------------------
    b = G.GLBBuilder()
    img_acc = b.add_raw(np.frombuffer(img_bytes, dtype=np.uint8), 5121, 1, "SCALAR")
    p_acc = b.positions(posY)
    n_acc = b.normals(nrm)
    uv_acc = b.add_raw(uv, 5126, 2, "VEC2")
    j_acc = b.joints(joints)
    w_acc = b.weights(weights)
    i_acc = b.indices(idx_arr)
    ib_acc = b.mat4s(inv_binds)

    nodes, bone_idx, hips_index, mesh_index = G.build_node_hierarchy(
        order, bones, mesh_node_index=None, skin_index=0)

    gltf = {
        "asset": {"version": "2.0", "generator": "rig_e04.py (texture-preserving)"},
        "scene": 0,
        "scenes": [{"nodes": [mesh_index, hips_index]}],
        "nodes": nodes,
        "meshes": [{
            "name": "E04_Bulwark",
            "primitives": [{
                "attributes": {
                    "POSITION": p_acc,
                    "NORMAL": n_acc,
                    "TEXCOORD_0": uv_acc,
                    "JOINTS_0": j_acc,
                    "WEIGHTS_0": w_acc,
                },
                "indices": i_acc,
                "material": 0,
            }],
        }],
        "skins": [{
            "name": "HumanIK",
            "joints": [bone_idx[n] for n in order],
            "inverseBindMatrices": ib_acc,
            "skeleton": hips_index,
        }],
        "materials": js.get("materials", [{
            "name": "rigMatte",
            "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.85, 1.0],
                                     "metallicFactor": 0.0, "roughnessFactor": 0.9},
            "doubleSided": True,
        }]),
        "textures": js.get("textures", [{"source": 0}]),
        "images": [{"bufferView": img_acc, "mimeType": img_mime}],
    }
    data = b.build(gltf)
    os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
    with open(out_glb, "wb") as f:
        f.write(data)
    print(f"[rig ] wrote {out_glb}  ({os.path.getsize(out_glb)/1024:.1f} KB)  joints={len(order)}")
    return out_glb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--skeleton", default=DEFAULT_SKELETON)
    args = ap.parse_args()
    rig_e04_glb(args.input, args.out, args.skeleton)


if __name__ == "__main__":
    main()
