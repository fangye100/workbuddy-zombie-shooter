# -*- coding: utf-8 -*-
"""
make_synthetic_rig.py — Blender-free end-to-end proof.

Builds a blocky capsule-stack humanoid mesh in WORLD space (Y-up, T-pose) that matches
the HumanIK skeleton, then:
  1. writes a STATIC GLB (synthetic_static.glb)
  2. rig_humanik  -> synthetic_rigged.glb          (skin + JOINTS_0/WEIGHTS_0)
  3. retarget_bvh -> synthetic_rigged_animated.glb (procedural walk animation)

Outputs under assets/characters/models/synthetic/.
At the end it runs the bind-pose LBS validation + animated-GLB sanity check.
"""

import os
import sys
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G
import rig_humanik as R
import retarget_bvh as RT
import validate_glb as V

OUT_DIR = os.path.normpath(os.path.join(_HERE, "..", "models", "synthetic"))


# =========================================================================
# mesh primitives (return (verts, normals, faces))
# =========================================================================
def _box(w, h, d):
    hx, hy, hz = w / 2, h / 2, d / 2
    faces_def = [
        ([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1]),
        ([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1]),
        ([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0]),
        ([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0]),
        ([[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 1, 0]),
        ([[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0]),
    ]
    v, n, f = [], [], []
    for corners, nrm in faces_def:
        b = len(v) // 3
        v.extend(corners); n.extend([nrm] * 4)
        f.append([b, b + 1, b + 2]); f.append([b, b + 2, b + 3])
    return np.array(v, float), np.array(n, float), np.array(f, int)


def _sphere(radius, segments=28, rings=18):
    v, n, f = [], [], []
    for r in range(rings + 1):
        phi = (r / rings) * np.pi
        sp, cp = np.sin(phi), np.cos(phi)
        for s in range(segments + 1):
            th = (s / segments) * np.pi * 2
            nx, ny, nz = sp * np.cos(th), cp, sp * np.sin(th)
            v.append([nx * radius, ny * radius, nz * radius]); n.append([nx, ny, nz])
    for r in range(rings):
        for s in range(segments):
            a = r * (segments + 1) + s; c = a + segments + 1
            b0 = len(v) // 3
            v.extend([]); n.extend([])
            f.append([a, c, c + 1]); f.append([a, c + 1, a + 1])
    return np.array(v, float), np.array(n, float), np.array(f, int)


def _rodrigues(from_v, to_v):
    a = np.array(from_v, float); b = np.array(to_v, float)
    a /= np.linalg.norm(a); b /= np.linalg.norm(b)
    d = float(np.clip(np.dot(a, b), -1, 1))
    if d > 0.999999:
        return np.eye(3)
    if d < -0.999999:
        # 180° about X
        return np.diag([1, -1, -1])
    axis = np.cross(a, b); axis /= np.linalg.norm(axis)
    ang = np.arccos(d)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * (K @ K)


def _capsule_y(r, cyl_h, segments=18, rings=6):
    """Y-axis capsule centered at origin (mimics geometry.ts createCapsule)."""
    v, n, f = [], [], []
    hy = cyl_h / 2
    # upper hemisphere
    for rg in range(rings + 1):
        phi = (rg / rings) * (np.pi / 2); cp, sp = np.cos(phi), np.sin(phi)
        y = hy + cp * r
        for s in range(segments + 1):
            th = (s / segments) * np.pi * 2
            nx, nz = np.cos(th) * sp, np.sin(th) * sp
            v.append([nx * r, y, nz * r]); n.append([nx, cp, nz])
    for rg in range(rings):
        for s in range(segments):
            a = rg * (segments + 1) + s; c = a + segments + 1
            f.append([a, c, c + 1]); f.append([a, c + 1, a + 1])
    bottom = (rings + 1) * (segments + 1)
    for rg in range(rings + 1):
        phi = (rg / rings) * (np.pi / 2); cp, sp = np.cos(phi), np.sin(phi)
        y = -hy - cp * r
        for s in range(segments + 1):
            th = (s / segments) * np.pi * 2
            nx, nz = np.cos(th) * sp, np.sin(th) * sp
            v.append([nx * r, y, nz * r]); n.append([nx, -cp, nz])
    for rg in range(rings):
        for s in range(segments):
            a = bottom + rg * (segments + 1) + s; c = a + segments + 1
            f.append([a, c, c + 1]); f.append([a, c + 1, a + 1])
    side = bottom + (rings + 1) * (segments + 1)
    for s in range(segments + 1):
        th = (s / segments) * np.pi * 2
        nx, nz = np.cos(th), np.sin(th)
        v.append([nx * r, hy, nz * r]); n.append([nx, 0, nz])
        v.append([nx * r, -hy, nz * r]); n.append([nx, 0, nz])
    for s in range(segments):
        a = side + s * 2
        f.append([a, a + 2, a + 3]); f.append([a, a + 3, a + 1])
    return np.array(v, float), np.array(n, float), np.array(f, int)


def _capsule(p0, p1, r, segments=18, rings=6):
    p0 = np.array(p0, float); p1 = np.array(p1, float)
    axis = p1 - p0; L = np.linalg.norm(axis)
    center = (p0 + p1) / 2
    cyl_h = max(L - 2 * r, 1e-3)
    v, n, f = _capsule_y(r, cyl_h, segments, rings)
    Rm = _rodrigues([0, 1, 0], axis / L)
    v = (v @ Rm.T) + center
    # rotate normals (no translation)
    n = n @ Rm.T
    return v, n, f.astype(int)


def _place(prim, center):
    v, n, f = prim
    return v + np.array(center, float), n, f


# =========================================================================
# assemble synthetic humanoid
# =========================================================================
def build_synthetic_humanoid(order, bones):
    world = G.skeleton_world_translations(order, bones)
    verts, normals, faces = [], [], []

    def add(v, n, f):
        b = len(verts) // 3
        verts.extend(v.tolist()); normals.extend(n.tolist())
        for tri in f:
            faces.extend([tri[0] + b, tri[1] + b, tri[2] + b])

    # torso + pelvis
    add(*_place(_box(0.34, 0.50, 0.22), (0, 1.30, 0)))
    add(*_place(_box(0.34, 0.20, 0.22), world["Hips"]))
    # head + neck
    add(*_place(_sphere(0.18, 28, 18), world["Head"]))
    add(*_capsule(world["Neck"], world["Head"], 0.06))
    # shoulders
    add(*_capsule(world["Spine2"], world["LeftShoulder"], 0.07))
    add(*_capsule(world["Spine2"], world["RightShoulder"], 0.07))
    # arms (upper + forearm) + hands
    for side in ("Left", "Right"):
        add(*_capsule(world[side + "Shoulder"], world[side + "Arm"], 0.075))
        add(*_capsule(world[side + "Arm"], world[side + "ForeArm"], 0.065))
        add(*_capsule(world[side + "ForeArm"], world[side + "Hand"], 0.055))
        add(*_place(_sphere(0.07, 18, 12), world[side + "Hand"]))
    # legs (upleg + leg) + feet + toes
    for side in ("Left", "Right"):
        add(*_capsule(world[side + "UpLeg"], world[side + "Leg"], 0.10))
        add(*_capsule(world[side + "Leg"], world[side + "Foot"], 0.085))
        add(*_place(_box(0.13, 0.09, 0.30), (world[side + "Foot"][0], 0.02, 0.07)))
        add(*_place(_box(0.11, 0.06, 0.14), world[side + "ToeBase"]))

    pos = np.array(verts, dtype=np.float64)
    nrm = np.array(normals, dtype=np.float64)
    fac = np.array(faces, dtype=np.int64).reshape(-1, 3)
    # recenter X/Z and ensure feet near y=0 (skeleton already places them)
    return pos, nrm, fac


def write_static_glb(path, pos, nrm, fac):
    b = G.GLBBuilder()
    p = b.positions(pos)
    n = b.normals(nrm if nrm is not None else G.compute_normals(pos, fac))
    i = b.indices(fac)
    gltf = {
        "asset": {"version": "2.0", "generator": "make_synthetic_rig.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "SyntheticMesh", "mesh": 0}],
        "meshes": [{
            "name": "SyntheticHumanoid",
            "primitives": [{"attributes": {"POSITION": p, "NORMAL": n}, "indices": i, "material": 0}],
        }],
        "materials": [{
            "name": "matte",
            "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.85, 1.0],
                                     "metallicFactor": 0.0, "roughnessFactor": 0.9},
            "doubleSided": True,
        }],
    }
    data = b.build(gltf)
    with open(path, "wb") as f:
        f.write(data)
    print(f"[mesh ] wrote {path}  ({os.path.getsize(path)/1024:.1f} KB)  "
          f"verts={pos.shape[0]} tris={fac.shape[0]}")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=OUT_DIR)
    ap.add_argument("--bvh", default=None, help="optional Mixamo BVH to retarget (else procedural walk)")
    ap.add_argument("--skeleton", default=os.path.join(_HERE, "humanik_skeleton.json"))
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    order, bones = G.load_skeleton(args.skeleton)
    pos, nrm, fac = build_synthetic_humanoid(order, bones)

    static_glb = os.path.join(args.outdir, "synthetic_static.glb")
    rigged_glb = os.path.join(args.outdir, "synthetic_rigged.glb")
    anim_glb = os.path.join(args.outdir, "synthetic_rigged_animated.glb")

    write_static_glb(static_glb, pos, nrm, fac)
    R.rig_static_glb(static_glb, rigged_glb, args.skeleton)
    RT.retarget_to_glb(rigged_glb, args.bvh, anim_glb)

    # ---- validate ----
    ok_rig, err = V.validate_glb(rigged_glb)
    ok_anim = V.check_animated(anim_glb)
    print("\n==== SUMMARY ====")
    print(f"  synthetic_static.glb          : {os.path.getsize(static_glb)} B")
    print(f"  synthetic_rigged.glb          : {os.path.getsize(rigged_glb)} B")
    print(f"  synthetic_rigged_animated.glb : {os.path.getsize(anim_glb)} B")
    print(f"  bind-pose LBS max_err         : {err:.2e}  -> {'PASS' if ok_rig else 'FAIL'}")
    print(f"  animated GLB sanity           : {'PASS' if ok_anim else 'FAIL'}")
    if not (ok_rig and ok_anim):
        sys.exit(1)


if __name__ == "__main__":
    main()
