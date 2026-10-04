# -*- coding: utf-8 -*-
"""扫面数预算 → 找每件达到「UV 密度 p99/med < 5」所需的最小面数。

背景
----
环境 LOD1 走路线 A 后，18/38 件几何崩坏（UV 密度 5~21，渲染出来是碎面），
根因是**面数预算太低**：props.json 的 tris 是给「聚类减面 + 顶点色」那代定的，
那条路的低模是给顶点色看的，糊一点无所谓；路线 A 要保留原生 UV 并直接采贴图，
同样的面数下UV 布局会被压烂。

本脚本回答：每件要多少面才能把 UV 密度压到阈值内。用于给 props.json 重新定档。

用法
----
  python tune_env_budget.py                 # 扫全部 38 件
  python tune_env_budget.py --only P-41     # 单件（快一点）
  python tune_env_budget.py --thresh 3.0    # 更严的阈值
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", ".."))
MODELS = os.path.join(ASSETS, "environment", "models")
PROPS = os.path.join(ASSETS, "environment", "props.json")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


UK = load("decimate_uvkeep", os.path.join(ASSETS, "characters", "_tools", "decimate_uvkeep.py"))


def uv_density(glb_path):
    """UV 面积 / 3D 面积的 p99/med —— 判「有没有面跨接缝/被拉伸」。"""
    js, bd = UK.read_glb(glb_path)
    pr = js["meshes"][0]["primitives"][0]
    P = UK.read_acc(js, bd, pr["attributes"]["POSITION"])
    T = UK.read_acc(js, bd, pr["indices"]).astype(np.int64).reshape(-1, 3)
    UV = UK.read_acc(js, bd, pr["attributes"]["TEXCOORD_0"])
    a, b, c = UV[T[:, 0]], UV[T[:, 1]], UV[T[:, 2]]
    uva = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1])
                 - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2
    pa, pb, pc = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    va = np.linalg.norm(np.cross(pb - pa, pc - pa), axis=1) / 2
    ok = (va > 1e-12) & (uva > 1e-12)
    if ok.sum() == 0:
        return None
    r = uva[ok] / va[ok]
    med = float(np.median(r))
    return float(np.percentile(r, 99)) / med if med > 0 else None


def try_target(raw, target, tmpdir):
    """跑一次路线 A，返回 (面数, UV 密度, 面积保持%)。失败返回 None。"""
    try:
        geo = UK.low_geometry(raw, target, tmpdir, log=lambda *a, **k: None)
    except Exception:
        return None
    V = geo["V"]
    retention = geo["retention"]
    # 直接在几何上算 UV 密度，省去打包。
    # geo["pairs"] 结构 = [ [(v_idx, vt_idx) × 3] per face ]（list of list of tuple）
    V = np.asarray(V, dtype=np.float64)
    VT = np.asarray(geo["VT"], dtype=np.float64)
    P3 = np.array([[p[0] for p in tri] for tri in geo["pairs"]], dtype=np.int64)  # (F,3) 位置索引
    T3 = np.array([[p[1] for p in tri] for tri in geo["pairs"]], dtype=np.int64)  # (F,3) wedge UV 索引
    a, b, c = VT[T3[:, 0]], VT[T3[:, 1]], VT[T3[:, 2]]
    uva = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1])
                 - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2
    pa, pb, pc = V[P3[:, 0]], V[P3[:, 1]], V[P3[:, 2]]
    va = np.linalg.norm(np.cross(pb - pa, pc - pa), axis=1) / 2
    ok = (va > 1e-12) & (uva > 1e-12)
    if ok.sum() == 0:
        return None
    r = uva[ok] / va[ok]
    med = float(np.median(r))
    return (len(geo["pairs"]),
            (float(np.percentile(r, 99)) / med if med > 0 else None),
            retention)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--thresh", type=float, default=5.0, help="UV 密度上限")
    ap.add_argument("--max-factor", type=float, default=12.0,
                    help="面数最多放大到原预算的多少倍")
    args = ap.parse_args()

    props = {e["id"]: e for e in json.load(open(PROPS, encoding="utf-8"))["entries"]}
    if args.only:
        ids = [args.only]
    else:
        ids = sorted(props)

    print(f"{'ID':6} {'现预算':>7} {'现UVd':>7} → {'达标面数':>9} {'UVd':>6} {'倍数':>6} {'面积%':>7}")
    print("-" * 66)
    out = {}
    for eid in ids:
        raw = os.path.join(MODELS, eid, f"{eid}.glb")
        if not os.path.exists(raw):
            continue
        cur_path = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
        cur_uv = uv_density(cur_path) if os.path.exists(cur_path) else None
        budget = props[eid]["tris"]
        if cur_uv is not None and cur_uv <= args.thresh:
            print(f"{eid:6} {budget:7d} {cur_uv:7.1f} → {'已达标':>9} {cur_uv:6.1f} {'-':>6} {'-':>7}")
            out[eid] = {"budget": budget, "current_uv": cur_uv, "ok": True}
            continue
        # 逐级向上探，取**最小达标面数**（不是第一个达标的）。
        # 🔴 探针起点必须贴着预算往上：P-41 预算 500，1500 面就能到 UVd3.7（3×），
        #    但从 12× 起步会一路探到 6000 才return，白烧 5 倍时间还给出 4 倍偏高的建议。
        tmpdir = tempfile.mkdtemp(prefix=f"tune_{eid}_")
        try:
            ladder = [int(budget * m) for m in (1, 2, 3, 4, 6, 8, 12)
                      if m == 1 or int(budget * m) != int(budget * (m - 1))]
            hits = []
            for t in ladder:
                r = try_target(raw, t, tmpdir)
                if not r or r[1] is None:
                    continue
                faces, uvd, ret = r
                mark = "✓" if uvd <= args.thresh else " "
                print(f"{eid:6} {budget:7d} {(cur_uv or 0):7.1f} →{mark}{t:8d} {uvd:6.1f} "
                      f"{t / budget:5.1f}x {ret:6.1f}%")
                if uvd <= args.thresh:
                    hits.append((t, uvd, faces, ret))
                    break          # 从小到大，第一个达标即最小
            if hits:
                best = hits[0]
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        if best:
            out[eid] = {"budget": budget, "current_uv": cur_uv, "ok": True,
                        "suggest_faces": best[0], "uv_at_suggest": best[1],
                        "factor": round(best[0] / budget, 2)}
        else:
            out[eid] = {"budget": budget, "current_uv": cur_uv, "ok": False,
                        "note": f"放大到 {args.max_factor}x 仍不达标"}
            print(f"{eid:6} {budget:7d} {(cur_uv or 0):7.1f} → {'无可行解':>9} "
                  f"{'':6} {args.max_factor:5.1f}x")

    okc = sum(1 for v in out.values() if v.get("ok"))
    print("-" * 66)
    print(f"当前达标 {okc}/{len(out)}")
    sug = {k: v["suggest_faces"] for k, v in out.items() if "suggest_faces" in v}
    if sug:
        print("\n建议的新面数（可直接写回 props.json 的 tris）：")
        print(json.dumps(sug, ensure_ascii=False))
        rep = os.path.join(ASSETS, "..", ".workbuddy", "tmp", "lodtest", "budget_suggest.json")
        json.dump(out, open(rep, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("报告：" + os.path.normpath(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())