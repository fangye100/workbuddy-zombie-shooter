# -*- coding: utf-8 -*-
"""
rig_humanik.py — Blender-free auto-rigging of a STATIC humanoid GLB.

rig_static_glb(input_glb, out_glb, skeleton_json="humanik_skeleton.json")
  - reads POSITION / NORMAL / indices from the static GLB (pure-python + numpy reader)
  - builds the HumanIK/Mixamo rest skeleton, computes each bone's world bind matrix
    and inverseBind matrix (column-major mat4)
  - computes clean linear-blend-skinning weights: nearest-bone-segment distance with
    smooth inverse-distance falloff, clamped to 4 influences, normalized to sum 1
    (no all-zero weights: fallback to nearest bone weight 1.0)
  - writes a new GLB: keeps the mesh, adds skins[0] (joints + inverseBindMatrices),
    the primitive gets JOINTS_0 (u16 VEC4, not normalized) and WEIGHTS_0
    (f32 VEC4, not normalized). Skinned mesh node = identity transform
    (renderer handles placement, matches gpu/gltf.ts bind-pose contract).

Reuses glb_util.py (byte-compatible GLB packing + mat4/quat helpers).
"""

import os
import sys
import json
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G  # noqa: E402

DEFAULT_SKELETON = os.path.join(_HERE, "humanik_skeleton.json")


def bone_segments(order, bones, world):
    """For each bone return (A, B) world endpoints of its influence capsule: A = bone head,
    B = its first child's head (or the bone head itself for leaves, i.e. a point)."""
    segs = []
    child_of = {}
    for name in order:
        p = bones[name]["parent"]
        if p is not None:
            child_of.setdefault(p, name)  # first listed child
    for name in order:
        a = world[name]
        c = child_of.get(name)
        b = world[c] if c is not None else world[name]
        segs.append((a, b))
    return segs


def compute_lbs_weights(positions, order, bones, world, max_influences=4,
                        falloff=3.0, eps=0.02):
    """Return (joints (N,4) u16, weights (N,4) f32)."""
    segs = bone_segments(order, bones, world)
    n_bones = len(segs)
    N = positions.shape[0]
    A = np.array([s[0] for s in segs], dtype=np.float64)   # (B,3)
    B = np.array([s[1] for s in segs], dtype=np.float64)   # (B,3)
    AB = B - A
    AB_len2 = np.sum(AB * AB, axis=1)
    AB_len2[AB_len2 < 1e-12] = 1e-12

    joints = np.zeros((N, max_influences), dtype=np.uint16)
    weights = np.zeros((N, max_influences), dtype=np.float64)

    for i in range(N):
        v = positions[i]
        d = v - A                       # (B,3)
        t = np.sum(d * AB, axis=1) / AB_len2
        t = np.clip(t, 0.0, 1.0)
        proj = A + t[:, None] * AB      # (B,3)
        dist = np.linalg.norm(v - proj, axis=1)  # (B,)
        # smooth inverse-distance falloff
        w = 1.0 / (dist + eps) ** falloff
        # pick top-k influences
        if N <= 4000:
            idx = np.argpartition(-w, max_influences)[:max_influences]
        else:
            idx = np.argsort(-w)[:max_influences]
        idx = idx[np.argsort(-w[idx])]  # keep descending order
        sub = w[idx]
        s = sub.sum()
        if s <= 1e-12:
            # fallback: nearest bone weight 1.0
            j = int(np.argmin(dist))
            joints[i, 0] = j
            weights[i, 0] = 1.0
        else:
            joints[i] = idx.astype(np.uint16)
            weights[i] = sub / s
    return joints, weights.astype(np.float32)


def rig_static_glb(input_glb, out_glb, skeleton_json=DEFAULT_SKELETON):
    order, bones = G.load_skeleton(skeleton_json)
    world = G.skeleton_world_translations(order, bones)

    js, bin_data = G.read_glb(input_glb)
    pos, nrm, faces = G.read_mesh_geometry(js, bin_data)
    N = pos.shape[0]
    print(f"[rig ] {os.path.basename(input_glb)}  verts={N}  tris={faces.shape[0]}")

    # --- bind-pose world matrices + inverseBind (column-major) ---
    world_mats = G.skeleton_world_matrices(order, bones)
    inv_binds = np.array(
        [G.mat_to_colmajor(G.m_inverse(world_mats[name])) for name in order],
        dtype=np.float64,
    )  # shape (22, 16)

    # --- LBS weights ---
    joints, weights = compute_lbs_weights(pos, order, bones, world)
    # sanity: no all-zero rows
    wsum = weights.sum(axis=1)
    assert np.all(wsum > 1e-6), "zero-weight vertex produced"

    # --- build GLB ---
    b = G.GLBBuilder()
    p_acc = b.positions(pos)
    n_acc = b.normals(nrm if nrm is not None else G.compute_normals(pos, faces))
    j_acc = b.joints(joints)
    w_acc = b.weights(weights)
    i_acc = b.indices(faces)

    nodes, bone_idx, hips_index, mesh_index = G.build_node_hierarchy(
        order, bones, mesh_node_index=None, skin_index=0)

    ib_acc = b.mat4s(inv_binds)

    gltf = {
        "asset": {"version": "2.0", "generator": "rig_humanik.py (Blender-free)"},
        "scene": 0,
        "scenes": [{"nodes": [mesh_index, hips_index]}],
        "nodes": nodes,
        "meshes": [{
            "name": "RiggedHumanoid",
            "primitives": [{
                "attributes": {
                    "POSITION": p_acc,
                    "NORMAL": n_acc,
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
        "materials": [{
            "name": "rigMatte",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.8, 0.8, 0.85, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.9,
            },
            "doubleSided": True,
        }],
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
    rig_static_glb(args.input, args.out, args.skeleton)


if __name__ == "__main__":
    main()
