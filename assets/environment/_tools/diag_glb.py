"""诊断 TokenHub glb：解析后的顶点包围盒、面积、与文件内场景图变换。"""
import importlib.util
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHAR_TOOLS = os.path.join(HERE, "..", "..", "characters", "_tools")

spec = importlib.util.spec_from_file_location("_mgr", os.path.join(CHAR_TOOLS, "make_game_ready.py"))
mgr = importlib.util.module_from_spec(spec)
sys.modules["_mgr"] = mgr
spec.loader.exec_module(mgr)

import numpy as np

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "models", "P-11", "P-11.glb")

verts, faces, uv, textures = mgr.parse_glb(src)
print(f"解析结果: {len(faces)} 面 / {len(verts)} 顶点")
mn, mx = verts.min(0), verts.max(0)
print(f"包围盒 min={mn}\n        max={mx}\n        尺寸={mx-mn}")
a = verts[faces[:, 0]]; b = verts[faces[:, 1]]; c = verts[faces[:, 2]]
area = (np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2).sum()
print(f"总表面积 = {area:.4f}")

# 直接读 glb 的 JSON chunk，看 nodes 的 scale/translation
with open(src, "rb") as f:
    magic, ver, total = struct.unpack("<III", f.read(12))
    clen, ctype = struct.unpack("<II", f.read(8))
    doc = json.loads(f.read(clen))
print("\n场景图 nodes（前 6 个）：")
for n in doc.get("nodes", [])[:6]:
    print(f"  {n.get('name','?')}: mesh={n.get('mesh')} scale={n.get('scale')} translation={n.get('translation')} rotation={n.get('rotation')} children={n.get('children')}")
print("meshes:", len(doc.get("meshes", [])), " accessors:", len(doc.get("accessors", [])))
m0 = doc["meshes"][0] if doc.get("meshes") else None
if m0:
    for p in m0["primitives"][:3]:
        pos_acc = doc["accessors"][p["attributes"]["POSITION"]]
        print(f"  primitive: mode={p.get('mode',4)} POSITION count={pos_acc['count']} min={pos_acc.get('min')} max={pos_acc.get('max')}")
