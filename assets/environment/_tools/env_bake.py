#!/usr/bin/env python3
"""环境资产链路 **第 1 步（UV 展开）**：调用 bake_lowpoly.py 给低模展 xatlas UV。

输入：assets/environment/models/<ID>/<ID>_low.obj（带顶点色）
输出：assets/environment/models/<ID>/tex/<ID>_tex.obj/.mtl/.png

🔴 上游 bake_lowpoly.py 已标 DEPRECATED，但**弃用的是它的「顶点色→平涂贴图」上色法**，
   不是它的 xatlas UV 展开：`tex/<ID>_tex.obj`（带 UV 的低模）正是第 2 步
   `env_transfer.py` 必需的低模输入。所以本脚本仍然有效，只是产物里的
   `_tex_baseColor.png` 已属历史遗留（贴图改由 env_transfer 从原生 4096² 转移得到）。

链路（两步，别只用第二步）：
  1. `env_bake.py`      → tex/<ID>_tex.obj（xatlas UV 低模；贴图 PNG 不采用）
  2. `env_transfer.py`  → tex2/<ID>_baked.glb + <ID>_tex.png（原生贴图转移版，**这才是成品**）

用法：
  PYTHONIOENCODING=utf-8 python env_bake.py [--only P-11]
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BAKE = os.path.join(HERE, "..", "..", "characters", "_tools", "bake_lowpoly.py")
MODELS = os.path.join(HERE, "..", "models")
# 注意：bake CLI 的 --outdir 落盘名 = <name>.obj/.png；name 参数控制前缀


def main():
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]

    done = fail = skip = 0
    for eid in sorted(os.listdir(MODELS)):
        if only and eid != only:
            continue
        low = os.path.join(MODELS, eid, f"{eid}_low.obj")
        texdir = os.path.join(MODELS, eid, "tex")
        if not os.path.exists(low):
            continue
        if os.path.exists(os.path.join(texdir, f"{eid}_tex_baked.glb")):
            skip += 1
            continue
        os.makedirs(texdir, exist_ok=True)
        cmd = [
            sys.executable, BAKE,
            "--input", low,
            "--size", "512",
            "--outdir", texdir,
            "--name", f"{eid}_tex",
            "--target-lum", "0.38",
            "--sat", "1.30",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        # 🔴 实际产物是 <name>_baked.glb + <name>_baseColor.png（GLB 内嵌 UV+贴图）
        ok = os.path.exists(os.path.join(texdir, f"{eid}_tex_baked.glb")) and \
             os.path.exists(os.path.join(texdir, f"{eid}_tex_baseColor.png"))
        if ok:
            done += 1
            print(f"[{eid}] OK tex/{eid}_tex_baked.glb")
        else:
            fail += 1
            print(f"[{eid}] FAIL rc={r.returncode} :: {(r.stderr or r.stdout or '').strip()[-200:]}")
    print(f"\n烘焙完成 {done} / 跳过 {skip} / 失败 {fail}")


if __name__ == "__main__":
    main()
