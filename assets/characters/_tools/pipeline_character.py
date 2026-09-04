# -*- coding: utf-8 -*-
"""
pipeline_character.py — 一个角色从概念图到「可播动作的 rigged GLB」的全自动流水线。

链路（每步都是已单独验证过的现成脚本，本脚本只负责串接 + 参数按 roster 取）：

  概念图 front.png
    → [1] gen3d_from_image.py   混元图生3D（80000 tris 高模 + PBR 贴图）
    → [2] decimate_cluster.py   空间聚类减面到 roster.tris 预算（对病态拓扑免疫）
    → [3] bake_lowpoly.py       xatlas 展 UV + 烘 baseColor
    → [4] rig_character.py      Z-up→Y-up + HumanIK 22 骨 LBS 权重（保贴图）
    → [5] retarget_bvh.py       烤 6 段程序化动作（idle/run/attack/walk/hit/death）
    → [6] validate_glb.py       bind-pose LBS 自洽 + animated sanity

两套 Python 环境（必须分开用，否则 import 失败）
------------------------------------------------
  云端/绑骨（要 requests + numpy）：
    C:/Users/fangy/.workbuddy/binaries/python/versions/3.13.12/python.exe
  减面/烘焙（要 pymeshlab + xatlas）：
    C:/Users/fangy/.workbuddy/binaries/python/envs/default/Scripts/python.exe

用法
----
    # 单个角色全流程（token 从 stdin 读）
    echo -n "<token>" | python pipeline_character.py --id E-02

    # 已经有混元产物、只跑后续步骤
    python pipeline_character.py --id E-02 --skip-gen

    # 批量（缺 token 时自动只跑已有产物的角色）
    echo -n "<token>" | python pipeline_character.py --all

坑（都踩过）
------------
- 混元 API **不允许 prompt 与图片同时传**（"Prompt和ImageBase64、ImageUrl不能同时存在"）
  → 图生3D 时不要带 --prompt。
- decimate_cluster.py 只吃 **GLB**，不吃 OBJ（内部走 make_game_ready.parse_glb）。
- 面积保持率 >80% 才算健康；低于就调大 --target 重跑。
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_CHARS = os.path.normpath(os.path.join(_HERE, ".."))
ROSTER = os.path.join(_CHARS, "roster.json")

PY_CLOUD = r"C:/Users/fangy/.workbuddy/binaries/python/versions/3.13.12/python.exe"
PY_MESH = r"C:/Users/fangy/.workbuddy/binaries/python/envs/default/Scripts/python.exe"


def load_roster():
    with open(ROSTER, encoding="utf-8") as f:
        d = json.load(f)
    out = {}
    for key in ("npcs", "bosses"):
        for c in d.get(key, []):
            out[c["id"]] = c
    return out


def run(cmd, stdin_data=None, label=""):
    print(f"\n>>> [{label}] {' '.join(str(c) for c in cmd[1:4])} ...", flush=True)
    p = subprocess.run(cmd, input=stdin_data, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    tail = (p.stdout or "").strip().split("\n")
    for line in tail[-14:]:
        print("    " + line, flush=True)
    if p.returncode != 0:
        err = (p.stderr or "").strip().split("\n")
        for line in err[-8:]:
            print("    !! " + line, flush=True)
        raise RuntimeError(f"[{label}] exit={p.returncode}")
    return p.stdout


def newest(pattern):
    hits = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def pipeline(cid, roster, token=None, skip_gen=False, size=1024, skip_rig=False):
    c = roster[cid]
    en = c.get("en", cid.replace("-", ""))
    tag = cid.replace("-", "")
    tris = int(c.get("tris", 1600))
    mdir = os.path.join(_CHARS, "models", cid)
    img = os.path.join(_CHARS, "images", cid, "front", f"{cid}_front.png")
    stem = f"{tag}_{en}_{tris}"

    print(f"\n{'=' * 66}\n角色 {cid} {c.get('name')} ({en})  tris预算={tris}  "
          f"height={c.get('height')}\n{'=' * 66}", flush=True)

    # --- [1] 混元图生3D ------------------------------------------------------
    hi_glb = newest(os.path.join(mdir, "*.glb"))
    if not skip_gen:
        if not os.path.isfile(img):
            raise FileNotFoundError(f"缺概念图: {img}")
        if not token:
            raise RuntimeError("缺 token（--token-stdin），无法调混元生成")
        os.makedirs(mdir, exist_ok=True)
        # 注意：图生3D 不能同时带 --prompt，API 会拒
        run([PY_CLOUD, "-u", os.path.join(_HERE, "gen3d_from_image.py"),
             "--image", img, "--outdir", mdir, "--tag", tag,
             "--model", "3.1", "--face-count", "80000", "--token-stdin"],
            stdin_data=token, label=f"{cid} gen3d")
        hi_glb = newest(os.path.join(mdir, f"{tag}_*.glb"))
    if not hi_glb:
        raise FileNotFoundError(f"{cid}: 没有混元高模 GLB（{mdir}）")
    print(f"    高模 = {os.path.basename(hi_glb)}", flush=True)

    # --- [2] 减面 ------------------------------------------------------------
    lo_obj = os.path.join(mdir, "game_ready", f"{stem}tris.obj")
    out = run([PY_MESH, "-u", os.path.join(_HERE, "decimate_cluster.py"),
               "--input", hi_glb, "--target", str(tris), "--out", lo_obj],
              label=f"{cid} decimate")
    try:
        stats = json.loads(out[out.index("{"):])
        retention = stats.get("area_retention_pct", 0)
        if retention < 80.0:
            print(f"    ⚠ 面积保持率 {retention}% < 80%（拓扑可能退化，建议调大 target）",
                  flush=True)
    except (ValueError, json.JSONDecodeError):
        pass

    # --- [3] UV + 贴图 -------------------------------------------------------
    tex_dir = os.path.join(mdir, "textured")
    run([PY_MESH, "-u", os.path.join(_HERE, "bake_lowpoly.py"),
         "--input", lo_obj, "--size", str(size),
         "--outdir", tex_dir, "--name", stem], label=f"{cid} bake")
    baked = os.path.join(tex_dir, f"{stem}_baked.glb")

    # --- [4][5][6] 绑骨 + 动作 + 骨骼验证（非双足/不可移动角色可跳过） ---------
    rig_dir = os.path.join(mdir, "rigged")
    rigged = os.path.join(rig_dir, f"{stem}_rigged.glb")
    animated = os.path.join(rig_dir, f"{stem}_rigged_animated.glb")
    if skip_rig:
        # B-02 母体等：混元只出静态 mesh，本地人形 rig/行走 retarget 套不上、
        # 且本体不可移动无需 walk。只交付减面+烘焙后的静态 GLB（含 PBR 贴图）。
        print(f"    [SKIP] 跳过绑骨/动作/骨骼验证（非双足或不可移动角色）\n"
              f"           交付静态网格 = {os.path.basename(baked)}", flush=True)
        rigged, animated = None, None
    else:
        run([PY_CLOUD, "-u", os.path.join(_HERE, "rig_character.py"),
             "--input", baked, "--out", rigged, "--id", cid], label=f"{cid} rig")
        run([PY_CLOUD, "-u", os.path.join(_HERE, "retarget_bvh.py"),
             "--rigged", rigged, "--out", animated], label=f"{cid} anim")
        # validate_glb.py 签名：<rigged> [--animated <animated glb>]
        run([PY_CLOUD, "-u", os.path.join(_HERE, "validate_glb.py"),
             rigged, "--animated", animated], label=f"{cid} validate")

    return {"id": cid, "high": hi_glb, "lowpoly": lo_obj, "baked": baked,
            "rigged": rigged, "animated": animated}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", action="append", default=[], help="角色 ID，可多次")
    ap.add_argument("--all", action="store_true", help="跑 roster 全部角色")
    ap.add_argument("--skip-gen", action="store_true", help="跳过混元生成，用已有高模")
    ap.add_argument("--size", type=int, default=1024, help="贴图分辨率")
    ap.add_argument("--skip-rig", nargs="*", default=None,
                    help="跳过绑骨/动作/骨骼验证：--skip-rig B-02 只跳 B-02；"
                         "单独 --skip-rig 则跳过本次全部 ID（用于非双足/不可移动角色）")
    ap.add_argument("--token-stdin", action="store_true")
    args = ap.parse_args()

    token = sys.stdin.read().strip() if args.token_stdin else None
    roster = load_roster()
    ids = list(roster.keys()) if args.all else args.id
    if not ids:
        ap.error("需要 --id 或 --all")

    ok, fail = [], []
    t0 = time.time()
    for cid in ids:
        if cid not in roster:
            print(f"[SKIP] {cid} 不在 roster", flush=True)
            continue
        try:
            # --skip-rig 不带参数 = 跳过本次全部；带 ID 列表 = 只跳指定 ID
            skip_rig = args.skip_rig is not None and (
                len(args.skip_rig) == 0 or cid in args.skip_rig)
            ok.append(pipeline(cid, roster, token=token,
                               skip_gen=args.skip_gen, size=args.size,
                               skip_rig=skip_rig))
        except Exception as e:  # noqa: BLE001 — 单角色失败不该中断整批
            print(f"\n[FAIL] {cid}: {type(e).__name__}: {e}", flush=True)
            fail.append({"id": cid, "error": f"{type(e).__name__}: {e}"})

    print(f"\n{'=' * 66}")
    print(f"完成 {len(ok)}/{len(ok) + len(fail)}  耗时 {time.time() - t0:.0f}s")
    for r in ok:
        if r["animated"]:
            print(f"  OK   {r['id']}  ->  {os.path.relpath(r['animated'], _CHARS)}")
        else:
            print(f"  OK   {r['id']}  ->  {os.path.relpath(r['baked'], _CHARS)}  "
                  f"(static, no rig)")
    for r in fail:
        print(f"  FAIL {r['id']}  {r['error']}")
    print(json.dumps({"ok": ok, "fail": fail}, ensure_ascii=False, indent=2))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
