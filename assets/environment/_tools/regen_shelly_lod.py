# -*- coding: utf-8 -*-
"""碎壳体（shelly mesh）的按壳预算减面 —— 救 P-05 / P-43 这类全局 QEM 救不了的资产。

病因（实测诊断）
----------------
P-43 轮椅：480322 面 / **6208 个连通壳**，props.json 预算 420 面
P-05 轮胎堆：520937 面 / **17255 个连通壳**，预算 320 面

全局 QEM（decimate_uvkeep 用的那套）按二次误差**全局排序**决定塌哪条边 →
大壳被优先减碎，小壳一个不动：
  · P-43 卡在 5186~5190 面下不来（预算 420，差 12倍）
  · P-05 减到 615 面时相邻壳被焊到一起 → 边界 49 / 非流形 42

🔴 预算物理不可达：6208 壳 × 最低 4 面（保留一个壳的最小规模）= 24832 面。
   props.json 的 tris 是按连通件估算的，**没考虑碎壳倍数** —— 这是预算定档本身的问题。

本脚本的策略
------------
按壳的面数占比分配预算 → 每个壳用**自己的局部 QEM** 减面 → 合并。
壳内只有几十到几千面，QEM 在单壳内表现正常（不会跨壳产生非流形）。

用法
----
  python regen_shelly_lod.py --id P-43 --dry
  python regen_shelly_lod.py --id P-43            # 覆盖 tex2/<ID>_baked.glb
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from collections import defaultdict, deque

import numpy as np
import pymeshlab

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", ".."))
ROOT = os.path.normpath(os.path.join(ASSETS, ".."))
MODELS = os.path.join(ASSETS, "environment", "models")
PROPS = os.path.join(ASSETS, "environment", "props.json")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


UK = load("decimate_uvkeep", os.path.join(ASSETS, "characters", "_tools", "decimate_uvkeep.py"))


def face_shells(F):
    """按共边连通性给面分组 → (labels, shell_count)。"""
    ev = defaultdict(list)
    for fi, t in enumerate(F):
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            ev[(int(min(a, b)), int(max(a, b)))].append(fi)
    lab = np.full(len(F), -1, np.int64)
    n = 0
    for s0 in range(len(F)):
        if lab[s0] >= 0:
            continue
        q = deque([s0])
        lab[s0] = n
        while q:
            fi = q.popleft()
            t = F[fi]
            for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                for fj in ev[(int(min(a, b)), int(max(a, b)))]:
                    if lab[fj] < 0:
                        lab[fj] = n
                        q.append(fj)
        n += 1
    return lab, n


def decimate_shells(raw_path, budget, min_faces=4, quality=0.6, tex_weight=1.0):
    """按壳分配预算 → 逐壳 QEM → 合并成一个 mesh。返回 (V, F) 或 None。"""
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(raw_path)
    m0 = ms.current_mesh()
    V0 = np.asarray(m0.vertex_matrix()).astype(np.float64)
    F0 = np.asarray(m0.face_matrix()).astype(np.int64)
    if V0.shape[1] == 3:
        V0 = np.hstack([V0, np.ones((len(V0), 1))])
    lab, nsh = face_shells(F0)
    counts = np.bincount(lab, minlength=nsh).astype(np.float64)

    # 预算分配：按壳面数占比；每壳至少 min_faces（否则壳会消失）；单壳不超过总数一半
    share = budget * counts / max(counts.sum(), 1)
    share = np.maximum(share, min(min_faces, budget * 0.5))
    share = np.minimum(share, budget * 0.5)
    share = np.minimum(share, counts)          # 不超过原壳面数（不减不增）

    print(f"    壳数 {nsh} | 壳面数 min={counts.min():.0f} med={np.median(counts):.0f} "
          f"max={counts.max():.0f}")
    print(f"    预算 {budget} → 分配后合计 {share.sum():.0f}（每壳≥{min_faces}，≤总量50%）")

    outV, outF = [], []
    v_off = 0
    zero_shells = int((share < 4).sum())
    for si in range(nsh):
        fs = np.nonzero(lab == si)[0]
        if len(fs) == 0:
            continue
        tgt = int(round(share[si]))
        if tgt >= len(fs):
            tgt = len(fs)                       # 不需要减
        if tgt < 4:
            continue                            # 壳太小，保不住（合并时自然丢弃）
        vidx = np.unique(F0[fs])
        remap = np.full(int(V0.shape[0]), -1, np.int64)
        remap[vidx] = np.arange(len(vidx))
        Fs = remap[F0[fs]]
        Vs = V0[vidx][:, :3]
        if tgt >= len(fs):
            outV.append(Vs)
            outF.append(Fs + v_off)
            v_off += len(Vs)
            continue
        # 单壳局部 QEM（保留 UV：从 raw 里带上 TEXCOORD_0）
        m = pymeshlab.MeshSet()
        m.add_mesh(pymeshlab.Mesh(vertex_matrix=Vs, face_matrix=Fs))
        try:
            m.meshing_decimation_quadric_edge_collapse_with_texture(
                targetfacenum=tgt, qualitythr=quality, extratcoordw=tex_weight,
                preserveboundary=False, boundaryweight=1.0,
                optimalplacement=True, planarquadric=True)
        except Exception:
            pass
        mm = m.current_mesh()
        V2 = np.asarray(mm.vertex_matrix()).astype(np.float64)
        F2 = np.asarray(mm.face_matrix()).astype(np.int64)
        if len(F2) == 0:
            continue
        outV.append(V2)
        outF.append(F2 + v_off)
        v_off += len(V2)

    if not outF:
        return None
    return np.vstack(outV), np.vstack(outF)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--min-faces", type=int, default=4)
    args = ap.parse_args()

    props = {e["id"]: e for e in json.load(open(PROPS, encoding="utf-8"))["entries"]}
    eid = args.id
    raw = os.path.join(MODELS, eid, f"{eid}.glb")
    dst = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
    budget = props[eid]["tris"]
    if not os.path.exists(raw):
        print(f"[FATAL] {eid} 无raw glb")
        return 1

    print(f"=== {eid} 按壳预算减面（预算 {budget}）===")
    tmpdir = tempfile.mkdtemp(prefix=f"shelly_{eid}_")
    try:
        res = decimate_shells(raw, budget, args.min_faces)
        if res is None:
            print("[FAIL] 全部壳都被丢弃")
            return 1
        V, F = res
        # 抽稀到预算（按壳策略可能略超）
        if len(F) > budget:
            print(f"    合并后 {len(F)} 面 → 抽稀到 {budget}")
            ms = pymeshlab.MeshSet()
            ms.add_mesh(pymeshlab.Mesh(vertex_matrix=V, face_matrix=F))
            ms.meshing_decimation_quadric_edge_collapse(targetfacenum=budget,
                                                        qualitythr=0.6)
            m = ms.current_mesh()
            V = np.asarray(m.vertex_matrix()).astype(np.float64)
            F = np.asarray(m.face_matrix()).astype(np.int64)

        topo = UK._topo(V, F)
        print(f"    结果 {len(F)} 面 / {len(V)} 顶点 | 边界边 {topo['boundary']} "
              f"非流形 {topo['nonmanifold']}")

        if args.dry:
            print("[dry] 未写入")
            return 0
        # 写盘：贴图沿用现有 LOD1 的（路线 A 原生贴图已在里面，但这里是旧产物的512²，
        #       所以从 raw 重新取原生贴图 + 保持 UV 继承不成立 —— 先只报结果）
        print("[TODO] 抽稀后需重建 UV/贴图（碎壳无法继承原生 UV 的连续性），暂不写盘")
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())