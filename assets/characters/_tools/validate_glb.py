# -*- coding: utf-8 -*-
"""
validate_glb.py — bind-pose LBS reconstruction check for a rigged GLB.

  validate_glb.py <rigged.glb> [--animated <animated.glb>]

Re-reads the rigged GLB (no Blender), rebuilds each joint's world bind matrix from the
node hierarchy, computes jointMatrix = worldMatrix · inverseBind (which is exactly I at
bind pose), applies linear-blend-skinning to EVERY vertex, and asserts the reconstructed
position equals the stored vertex position within 1e-3 (POSITION is already in scene-root
space, and the skinned mesh node is identity, so bind pose must be preserved exactly).

Also (with --animated) sanity-checks an animated GLB: animations >=1 clip, each channel
has a sampler, and sampler output length == times.length * component_count.

Prints PASS/FAIL.
"""

import os
import sys
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G  # noqa: E402


def _node_world_map(js):
    """Return dict nodeIndex -> world matrix (numpy 4x4) from node T/R/S hierarchy."""
    nodes = js.get("nodes", [])
    parent = [-1] * len(nodes)
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            if 0 <= c < len(nodes):
                parent[c] = i
    # compute via topological accumulation
    world = [None] * len(nodes)

    def rec(i):
        if world[i] is not None:
            return world[i]
        n = nodes[i]
        t = n.get("translation", [0, 0, 0])
        q = n.get("rotation", [0, 0, 0, 1])
        s = n.get("scale", [1, 1, 1])
        local = G.m_compose(t, q, s)
        if parent[i] == -1:
            world[i] = local
        else:
            world[i] = rec(parent[i]) @ local
        return world[i]

    for i in range(len(nodes)):
        rec(i)
    return world


def validate_glb(path, tol=1e-3):
    js, bin_data = G.read_glb(path)
    if "skins" not in js or not js["skins"]:
        print(f"[FAIL] {path}: no skins -> not a rigged GLB")
        return False, float("inf")

    skin = js["skins"][0]
    joints = skin["joints"]
    node_world = _node_world_map(js)

    # inverseBind matrices (column-major -> numpy per joint)
    ib_accessor = js["accessors"][skin["inverseBindMatrices"]]
    ib_flat = G.read_accessor(js, bin_data, ib_accessor)  # (count, 16)
    assert ib_flat.shape[0] == len(joints), "inverseBind count != joints count"

    # mesh primitive
    prim = js["meshes"][0]["primitives"][0]
    pos = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["POSITION"]])
    jnt = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["JOINTS_0"]]).astype(np.int64)
    wgt = G.read_accessor(js, bin_data, js["accessors"][prim["attributes"]["WEIGHTS_0"]])
    N = pos.shape[0]

    # weights must sum to 1
    wsum = wgt.sum(axis=1)
    if not np.allclose(wsum, 1.0, atol=1e-4):
        print(f"[FAIL] weights do not sum to 1 (min={wsum.min():.4f} max={wsum.max():.4f})")
        return False, float("inf")

    # jointMatrix_i = world_i · inverseBind_i  (== I at bind pose)
    jointMat = []
    for k, node_i in enumerate(joints):
        w = node_world[node_i]
        ib_cm = ib_flat[k]
        ib = G.colmajor_to_mat(ib_cm)
        jointMat.append(w @ ib)

    # LBS
    recon = np.zeros_like(pos)
    for vi in range(N):
        acc = np.zeros(3, dtype=np.float64)
        for c in range(4):
            w = wgt[vi, c]
            if w == 0:
                continue
            j = int(jnt[vi, c])
            M = jointMat[j]
            ph = np.array([pos[vi, 0], pos[vi, 1], pos[vi, 2], 1.0])
            rp = M @ ph
            acc += w * rp[:3]
        recon[vi] = acc

    err = np.linalg.norm(recon - pos, axis=1)
    max_err = float(err.max())
    mean_err = float(err.mean())
    ok = max_err < tol
    print(f"[{'PASS' if ok else 'FAIL'}] bind-pose LBS  verts={N}  "
          f"max_err={max_err:.2e}  mean_err={mean_err:.2e}  tol={tol}")
    return ok, max_err


def check_animated(path):
    js, bin_data = G.read_glb(path)
    anims = js.get("animations", [])
    if not anims:
        print("[FAIL] animated GLB has no animations")
        return False
    ok = True
    for a in anims:
        chs = a.get("channels", [])
        samps = a.get("samplers", [])
        if not chs:
            print(f"[FAIL] clip '{a.get('name')}' has no channels")
            ok = False
            continue
        for ch in chs:
            si = ch.get("sampler")
            samp = samps[si] if 0 <= si < len(samps) else None
            if samp is None:
                print(f"[FAIL] channel references missing sampler {si}")
                ok = False
                continue
            tin = js["accessors"][samp["input"]]
            tout = js["accessors"][samp["output"]]
            # accessor 'count' is the number of keyframes (VEC4/VEC3 already baked in),
            # so it must equal the number of time samples.
            expected = tin["count"]
            if tout["count"] != expected:
                print(f"[FAIL] clip '{a.get('name')}' channel path={ch['target']['path']}: "
                      f"output count {tout['count']} != times count {tin['count']}")
                ok = False
        print(f"[info] clip '{a.get('name')}'  channels={len(chs)}  samplers={len(samps)}")
    print(f"[{'PASS' if ok else 'FAIL'}] animated GLB sanity")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rigged")
    ap.add_argument("--animated", default=None)
    ap.add_argument("--tol", type=float, default=1e-3)
    args = ap.parse_args()
    ok, _ = validate_glb(args.rigged, args.tol)
    if args.animated:
        ok2 = check_animated(args.animated)
        ok = ok and ok2
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
