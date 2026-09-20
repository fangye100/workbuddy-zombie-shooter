"""诊断顶点色烘焙失败：贴图是否存在、UV 是否有效、采样结果分布。"""
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CHAR_TOOLS = os.path.join(HERE, "..", "..", "characters", "_tools")
spec = importlib.util.spec_from_file_location("_mgr", os.path.join(CHAR_TOOLS, "make_game_ready.py"))
mgr = importlib.util.module_from_spec(spec)
sys.modules["_mgr"] = mgr
spec.loader.exec_module(mgr)

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "models", "P-11", "P-11.glb")
verts, faces, uv, textures = mgr.parse_glb(src)
print("textures keys:", list(textures.keys()))
for k, v in textures.items():
    if v is not None:
        try:
            print(f"  {k}: shape={getattr(v,'shape',None)} dtype={getattr(v,'dtype',None)}")
        except Exception:
            print(f"  {k}: {type(v)}")
print("uv:", None if uv is None else (uv.shape, uv.dtype, "范围", uv.min(0), uv.max(0)))
if textures.get("baseColor") is not None and uv is not None:
    colors = mgr.bake_vertex_colors(uv, textures["baseColor"])
    print("采样色统计: mean=", colors.mean(0), " std=", colors.std(0))
    print("灰度接近 0.5 的顶点占比:", float((np.abs(colors - 0.5).max(1) < 0.02).mean()))
