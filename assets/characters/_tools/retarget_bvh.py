# -*- coding: utf-8 -*-
"""
retarget_bvh.py — retarget a Mixamo BVH onto a rigged GLB (Blender-free).

retarget_to_glb(rigged_glb, bvh_path, out_glb)
  - parses a Mixamo BVH (HIERARCHY OFFSET + CHANNELS, MOTION frames with
    Zrotation/Yrotation/Xrotation per joint)
  - maps BVH joint names -> HumanIK/Mixamo bone names (handles Left/Right prefix,
    'mixamorig' prefix, and :LeftUpLeg style via fuzzy normalize)
  - bakes per-frame rotations into glTF animations[0]: each animated bone gets a
    channel (target node, path 'rotation', LINEAR) with output quaternions (xyzw);
    Hips translation (path 'translation') baked from the BVH root position delta.
  - if no BVH is given (or file missing), synthesizes a procedural walk cycle
    (sin-based leg/arm swing + vertical bob) so the GLB is self-validating.

Output reuses the rigged GLB's mesh/skin; only animation accessors are appended.
Byte-compatible with gpu/gltf.ts (quats xyzw, LINEAR, column-major irrelevant for quats).
"""

import os
import sys
import json
import argparse

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import glb_util as G  # noqa: E402


# ---- BVH name -> HumanIK bone name ----------------------------------------
def normalize_joint(name):
    s = name.strip().lower()
    s = s.replace("mixamorig", "")
    s = s.replace(":", "").replace("_", "")
    s = s.replace("left", "Left").replace("right", "Right")
    # synonyms
    s = s.replace("UpLeg", "UpLeg").replace("upleg", "UpLeg")
    s = s.replace("ForeArm", "ForeArm").replace("forearm", "ForeArm")
    s = s.replace("ToeBase", "ToeBase").replace("toebase", "ToeBase")
    s = s.replace("Shoulder", "Shoulder")
    s = s.replace("Hips", "Hips")
    return s


def map_bvh_to_bones(bvh_joints, bone_names):
    """Return dict bvh_name -> humanik_bone_name (best effort)."""
    out = {}
    targets = {normalize_joint(b): b for b in bone_names}
    for jn in bvh_joints:
        key = normalize_joint(jn)
        if key in targets:
            out[jn] = targets[key]
        else:
            # fuzzy: longest common prefix with a target key
            best = None
            bestp = 0
            for tk, tb in targets.items():
                p = sum(1 for a, b in zip(key, tk) if a == b)
                if p > bestp and p >= 4:
                    best, bestp = tb, p
            if best is not None:
                out[jn] = best
    return out


# ---- BVH parser -----------------------------------------------------------
def parse_bvh(path):
    with open(path, "r", encoding="latin-1") as fh:
        lines = fh.read().splitlines()
    i = 0
    while i < len(lines) and lines[i].strip().upper() != "HIERARCHY":
        i += 1
    i += 1
    joints = {}
    stack = []

    def parse_joint(i, parent):
        # lines[i] is "JOINT name" or "ROOT name" or "End Site"
        line = lines[i].strip()
        if line.upper().startswith("END SITE"):
            # next line "{"
            i += 2
            off = [float(x) for x in lines[i].strip().split()[1:]] if lines[i].strip().upper().startswith("OFFSET") else [0, 0, 0]
            i += 1
            while not lines[i].strip().startswith("}"):
                i += 1
            return i + 1
        kind, name = line.split(None, 1)
        name = name.strip()
        i += 1  # {
        off = [0, 0, 0]
        channels = []
        children_start = i
        while True:
            tok = lines[i].strip()
            if tok.upper().startswith("OFFSET"):
                off = [float(x) for x in tok.split()[1:]]
            elif tok.upper().startswith("CHANNELS"):
                parts = tok.split()
                nch = int(parts[1])
                channels = parts[2: 2 + nch]
            elif tok == "{":
                pass
            elif tok == "}":
                break
            elif tok.upper().startswith("JOINT") or tok.upper().startswith("END"):
                children_start = i
                break
            i += 1
        # parse children
        j = children_start
        while j < len(lines):
            t = lines[j].strip()
            if t.upper().startswith("JOINT"):
                j = parse_joint(j, name)
            elif t.upper().startswith("END"):
                j = parse_joint(j, name)  # consumes end site
            elif t == "}":
                break
            else:
                j += 1
        joints[name] = {"offset": off, "channels": channels, "parent": parent,
                        "order": channels}
        return j + 1

    # find ROOT
    while i < len(lines):
        if lines[i].strip().upper().startswith("ROOT"):
            i = parse_joint(i, None)
            break
        i += 1

    # MOTION
    while i < len(lines) and lines[i].strip().upper() != "MOTION":
        i += 1
    i += 1
    frame_time = 1.0 / 30.0
    nframes = 0
    while i < len(lines):
        t = lines[i].strip()
        if t.upper().startswith("FRAMES:"):
            nframes = int(t.split()[1])
        elif t.upper().startswith("FRAME TIME:"):
            frame_time = float(t.split()[2])
        elif t and t[0].isdigit():
            break
        i += 1
    motion = []
    while i < len(lines) and len(motion) < nframes:
        t = lines[i].strip()
        if t:
            vals = [float(x) for x in t.split()]
            if vals:
                motion.append(vals)
        i += 1
    motion = np.array(motion, dtype=np.float64)
    fps = 1.0 / frame_time if frame_time > 0 else 30.0
    return joints, motion, fps


# ---- procedural walk ------------------------------------------------------
def make_procedural_walk(order, bones, fps=30, frames=60):
    times = np.arange(frames, dtype=np.float64) / fps
    w = 2 * np.pi * times
    quats = {}
    swing = [
        ("LeftUpLeg", 0.45, [1, 0, 0]), ("RightUpLeg", -0.45, [1, 0, 0]),
        ("LeftLeg", 0.25, [1, 0, 0]), ("RightLeg", -0.25, [1, 0, 0]),
        ("LeftArm", -0.35, [1, 0, 0]), ("RightArm", 0.35, [1, 0, 0]),
        ("LeftForeArm", 0.25, [1, 0, 0]), ("RightForeArm", -0.25, [1, 0, 0]),
        ("Spine", 0.05, [1, 0, 0]), ("Spine1", 0.04, [1, 0, 0]),
    ]
    for bone, amp, axis in swing:
        if bone in order:
            ang = amp * np.sin(w)
            quats[bone] = np.array([G.quat_from_axis_angle(axis, a) for a in ang], dtype=np.float64)
    # Hips bob (absolute translation: include rest 1.0 m height)
    hips_rest = np.array(bones["Hips"]["offset"], dtype=np.float64)
    if bones["Hips"]["parent"] is not None:
        # Hips offset is from parent; but Hips is root, so it's world. Defensive:
        hips_rest = hips_rest  # already world
    hips_trans = np.tile(hips_rest, (frames, 1)).astype(np.float64)
    hips_trans[:, 1] += 0.03 * np.abs(np.sin(w)) - 0.015
    return times, quats, hips_trans


# ---- main retarget --------------------------------------------------------
def retarget_to_glb(rigged_glb, bvh_path, out_glb):
    js, bin_data = G.read_glb(rigged_glb)
    if "skins" not in js or not js["skins"]:
        raise ValueError("rigged_glb has no skin; rig it first with rig_humanik.py")

    # bone name -> node index
    name_to_node = {}
    for idx, n in enumerate(js.get("nodes", [])):
        if n.get("name"):
            name_to_node[n["name"]] = idx
    order, bones = G.load_skeleton(os.path.join(_HERE, "humanik_skeleton.json"))
    bone_names = order

    if bvh_path and os.path.isfile(bvh_path):
        print(f"[bvh ] parsing {os.path.basename(bvh_path)}")
        bvh_joints, motion, fps = parse_bvh(bvh_path)
        mapping = map_bvh_to_bones(list(bvh_joints.keys()), bone_names)
        print(f"[bvh ] mapped {len(mapping)}/{len(bvh_joints)} joints")
        # auto-detect cm scale (Mixamo exports in cm)
        root = [k for k, v in bvh_joints.items() if v["parent"] is None]
        scale = 1.0
        if root:
            off = np.array(bvh_joints[root[0]]["offset"], dtype=np.float64)
            if abs(off[1]) > 5.0:
                scale = 0.01
                print("[bvh ] detected cm-scale, dividing by 100")
        nframes = motion.shape[0]
        times = (np.arange(nframes) / fps).astype(np.float64)
        quats = {}
        hips_trans = None
        # build per-bone euler arrays
        for bvh_name, bone in mapping.items():
            info = bvh_joints[bvh_name]
            chs = info["channels"]
            if not any(c.endswith("rotation") for c in chs):
                continue
            # column indices for rotations
            cols = {c: k for k, c in enumerate(chs) if c.endswith("rotation")}
            fr = motion[:, cols["Zrotation"]] if "Zrotation" in cols else 0
            fa = motion[:, cols["Yrotation"]] if "Yrotation" in cols else 0
            fx = motion[:, cols["Xrotation"]] if "Xrotation" in cols else 0
            zr = np.deg2rad(fr); yr = np.deg2rad(fa); xr = np.deg2rad(fx)
            q = np.array([G.quat_from_euler_zyx(zr[k], yr[k], xr[k]) for k in range(nframes)], dtype=np.float64)
            quats[bone] = q
        # hips translation
        if root and any(c.endswith("position") for c in bvh_joints[root[0]]["channels"]):
            info = bvh_joints[root[0]]
            chs = info["channels"]
            cols = {c: k for k, c in enumerate(chs) if c.endswith("position")}
            rest = np.array(info["offset"], dtype=np.float64) * scale
            px = motion[:, cols["Xposition"]] * scale - rest[0]
            py = motion[:, cols["Yposition"]] * scale - rest[1]
            pz = motion[:, cols["Zposition"]] * scale - rest[2]
            hips_rest = np.array(bones["Hips"]["offset"], dtype=np.float64)
            hips_trans = np.stack([px + hips_rest[0], py + hips_rest[1], pz + hips_rest[2]], axis=1)
    else:
        print("[anim ] no BVH given -> synthesizing procedural walk cycle")
        times, quats, hips_trans = make_procedural_walk(order, bones)

    # ---- append animation accessors to bin ----
    new_bin = bytearray(bin_data)
    pad = (4 - (len(new_bin) % 4)) % 4
    new_bin += b"\x00" * pad

    def add_accessor(data_f32, comp, type_name, count):
        nonlocal new_bin
        raw = np.ascontiguousarray(data_f32, dtype="<f4").tobytes()
        while len(new_bin) % 4:
            new_bin.append(0)
        bv_off = len(new_bin)
        bv_idx = len(js["bufferViews"])
        js["bufferViews"].append({"buffer": 0, "byteOffset": bv_off, "byteLength": len(raw)})
        acc_idx = len(js["accessors"])
        js["accessors"].append({"bufferView": bv_idx, "componentType": comp,
                                "count": count, "type": type_name})
        new_bin += raw
        return acc_idx

    times_acc = add_accessor(times, 5126, "SCALAR", len(times))

    samplers = []
    channels = []
    for bone, q in quats.items():
        if bone not in name_to_node:
            continue
        node = name_to_node[bone]
        out_acc = add_accessor(np.asarray(q, dtype=np.float64).reshape(-1, 4), 5126, "VEC4", q.shape[0])
        si = len(samplers)
        samplers.append({"input": times_acc, "output": out_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": si, "target": {"node": node, "path": "rotation"}})

    if hips_trans is not None and "Hips" in name_to_node:
        node = name_to_node["Hips"]
        out_acc = add_accessor(np.asarray(hips_trans, dtype=np.float64).reshape(-1, 3), 5126, "VEC3", hips_trans.shape[0])
        si = len(samplers)
        samplers.append({"input": times_acc, "output": out_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": si, "target": {"node": node, "path": "translation"}})

    duration = float(times[-1]) if len(times) else 0.0
    js["animations"] = [{
        "name": "retargeted" if (bvh_path and os.path.isfile(bvh_path)) else "procedural_walk",
        "channels": channels,
        "samplers": samplers,
    }]

    os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
    G.write_glb(out_glb, js, bytes(new_bin))
    print(f"[anim ] wrote {out_glb}  ({os.path.getsize(out_glb)/1024:.1f} KB)  "
          f"clip='{js['animations'][0]['name']}'  channels={len(channels)}  "
          f"duration={duration:.3f}s")
    return out_glb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rigged", required=True)
    ap.add_argument("--bvh", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    retarget_to_glb(args.rigged, args.bvh, args.out)


if __name__ == "__main__":
    main()
