# -*- coding: utf-8 -*-
"""
gen_test_bvh.py — emit a Mixamo-format BVH fixture to exercise the REAL
retarget path in retarget_bvh.py (the --bvh branch, currently untested).

- Uses the standard HumanIK/Mixamo 22-bone hierarchy.
- Bone names carry the "mixamorig:" prefix + are exported in CENTIMETERS
  (Mixamo's default) so the parser's prefix-strip + cm-scale detection both fire.
- Motion = a synthetic walk cycle (leg/arm counter-swing + hips bob), 60 frames @30fps.

This is a FORMAT-COMPATIBILITY fixture, not captured mocap. It proves the
BVH ingestion code path works so a real Mixamo .bvh drops in identically.
"""
import os
import json
import math
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
skel = json.load(open(os.path.join(_HERE, "humanik_skeleton.json")))
bones = skel["bones"]
order = skel["boneOrder"]  # parent-before-child DFS order


def depth(name):
    d = 0
    p = bones[name]["parent"]
    while p:
        d += 1
        p = bones[p]["parent"]
    return d


def channels_for(name):
    if name == "Hips":
        return ["Xposition", "Yposition", "Zposition", "Zrotation", "Yrotation", "Xrotation"]
    return ["Zrotation", "Yrotation", "Xrotation"]


# ---- synthetic walk cycle (degrees about X for limb swing) ----
fps = 30
frames = 60
t = np.arange(frames) / fps
w = 2 * math.pi * t


def euler_for(name):
    # returns (z, y, x) arrays in degrees
    zero = np.zeros(frames)
    if name == "LeftUpLeg":   return (zero, zero, 28 * np.sin(w))
    if name == "RightUpLeg":  return (zero, zero, -28 * np.sin(w))
    if name == "LeftLeg":     return (zero, zero, 16 * np.sin(w + 0.4))
    if name == "RightLeg":    return (zero, zero, -16 * np.sin(w + 0.4))
    if name == "LeftArm":     return (zero, zero, -22 * np.sin(w + math.pi))
    if name == "RightArm":    return (zero, zero, 22 * np.sin(w))
    if name == "LeftForeArm": return (zero, zero, 12 * np.sin(w + math.pi))
    if name == "RightForeArm":return (zero, zero, -12 * np.sin(w))
    if name == "Spine":       return (zero, zero, 5 * np.sin(w))
    if name == "Spine1":      return (zero, zero, 4 * np.sin(w + 0.3))
    if name == "Spine2":      return (zero, zero, 3 * np.sin(w + 0.5))
    return (zero, zero, zero)


# cm export: humanik offsets are meters -> *100
def off_cm(name):
    return [round(v * 100, 3) for v in bones[name]["offset"]]


# Hips root position in cm (rest ~100cm + bob)
hips_x = np.zeros(frames)
hips_y = 100.0 + 2.0 * np.abs(np.sin(w))      # cm
hips_z = np.zeros(frames)

lines = ["HIERARCHY"]

# build child map for proper brace nesting
children_map = {}
for _n in order:
    _p = bones[_n]["parent"]
    children_map.setdefault(_p, []).append(_n)


def emit(name, indent):
    bvh_name = "mixamorig:" + name
    if bones[name]["parent"] is None:
        lines.append(f"{indent}ROOT {bvh_name}")
    else:
        lines.append(f"{indent}JOINT {bvh_name}")
    lines.append(f"{indent}{{")
    lines.append(f"{indent}  OFFSET {' '.join(str(v) for v in off_cm(name))}")
    ch = channels_for(name)
    lines.append(f"{indent}  CHANNELS {len(ch)} {' '.join(ch)}")
    for c in children_map.get(name, []):
        emit(c, indent + "  ")
    lines.append(f"{indent}}}")


emit("Hips", "")

# ---- MOTION ----
motion_rows = []
for f in range(frames):
    row = []
    for name in order:
        ch = channels_for(name)
        ez, ey, ex = euler_for(name)
        for c in ch:
            if c == "Xposition":
                row.append(round(float(hips_x[f]), 4))
            elif c == "Yposition":
                row.append(round(float(hips_y[f]), 4))
            elif c == "Zposition":
                row.append(round(float(hips_z[f]), 4))
            else:  # rotation channel
                if c == "Zrotation":
                    row.append(round(float(ez[f]), 4))
                elif c == "Yrotation":
                    row.append(round(float(ey[f]), 4))
                else:  # Xrotation
                    row.append(round(float(ex[f]), 4))
    motion_rows.append(row)

out = "\n".join(lines)
out += "\nMOTION\n\n"   # blank line so the FRAMES/Frame Time header is not eaten as a data row
out += f"Frames: {frames}\n"
out += f"Frame Time: {1.0/fps:.6f}\n"
for row in motion_rows:
    out += " ".join(f"{v:g}" for v in row) + "\n"

dst = os.path.join(_HERE, "sample_mixamo_walk.bvh")
with open(dst, "w", encoding="utf-8") as fh:
    fh.write(out)
print(f"[bvh ] wrote {dst}  ({os.path.getsize(dst)/1024:.1f} KB)  frames={frames} fps={fps}")
