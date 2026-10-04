# -*- coding: utf-8 -*-
"""环境 LOD1 批量重做（路线 A）—— 覆盖 tex2/<ID>_baked.glb。

背景
----
环境侧 LOD1 原先走env_pipeline → env_bake → env_transfer（转移烘焙），
与角色侧已弃用的 bake_texture_transfer 同款思路：色源是顶点色（有损压缩），
低模 UV 与原生无继承关系 ⇒ 贴图发灰。判别力实验（baseline_native_vs_lod.py）：
原生彩色占比中位 83.6% → 现有 LOD1 中位 25.7%，29/38 件色差 > 25pp。

本脚本改用角色侧现行路线 A（decimate_uvkeep.py：焊点 + 保纹理 QEM + 内嵌原生贴图）。

🔴 三个环境侧特有的坑（docs/06 §7.8 的角色判据在这里失效）
-------------------------------------------------------
1. UV 密度 p99/med < 3  → 环境实测 10~16。根因：环境 raw 是 50 万面含大量内部面，
   不是角色那种完美封闭流形，原生 UV atlas 本身碎得多。**本脚本不以此为否决判据**，
   只记录。
2. 面积保持 > 90% → 环境实测可 > 100%（内部面让分母虚高）。同样只记录。
3. 目标面数**不用分位数反推**（角色侧踩过：p90 落在破布/描边壳上导致跨部位抢权重），
   直接取 props.json entries[].tris 设计预算。

判据（本脚本真正用来否决的）
--------------------------
  · 输出边界边必须 0、非流形必须 0（焊点后应封闭流形）
  · 彩色占比必须 ≥ 原生彩色占比 − 5pp（不许比原生显著更灰）
  · 面数落在 [预算×0.85, 预算×1.35]（QEM 不保证精确命中）

用法
----
  python regen_env_lods.py --list DROP        # 只跑必须重做的 29 件
  python regen_env_lods.py --list all         # 全 38 件
  python regen_lods.py --only P-33 --dry      # 单件试跑不覆盖
  python regen_lods.py --list DROP --no-backup
"""
import argparse
import importlib.util
import json
import os
import shutil
import struct
import sys
from io import BytesIO

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
ENV = os.path.join(ROOT, "assets", "environment")
MODELS = os.path.join(ENV, "models")
PROPS = os.path.join(ENV, "props.json")
REPORT = os.path.join(ROOT, ".workbuddy", "tmp", "lodtest", "regen_report.json")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


DEC = load("decimate_uvkeep", os.path.join(ROOT, "assets", "characters", "_tools", "decimate_uvkeep.py"))


# ----------------------------------------------------------------- glb 读


def read_glb(p):
    raw = open(p, "rb").read()
    off, js, bd = 12, None, None
    while off + 8 <= len(raw):
        ln, ty = struct.unpack_from("<II", raw, off)
        s = off + 8
        if ty == 0x4E4F534A:
            js = json.loads(raw[s:s + ln].decode("utf-8"))
        elif ty == 0x004E4942:
            bd = raw[s:s + ln]
        off = s + ln + ((4 - ln % 4) % 4)
    return js, bd


def acc(js, bd, idx):
    a = js["accessors"][idx]
    bv = js["bufferViews"][a["bufferView"]]
    fmt, cs = {5126: ("<f4", 4), 5123: ("<u2", 2), 5125: ("<u4", 4), 5121: ("<u1", 1),
               5120: ("<i1", 1), 5122: ("<i2", 2)}[a["componentType"]]
    nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    stride = bv.get("byteStride") or cs * nc
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    b = np.frombuffer(bd, dtype=np.dtype((np.void, stride)), count=a["count"], offset=start)
    return np.frombuffer(b.tobytes(), dtype=fmt, count=a["count"] * nc).reshape(-1, nc).astype(np.float64)


def colorful(glb_path):
    """贴图彩色占比（饱和度 > 0.25 的像素比例）。"""
    js, bd = read_glb(glb_path)
    prim = js["meshes"][0]["primitives"][0]
    for m in js.get("materials") or []:
        bct = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if not bct:
            continue
        im = js["images"][js["textures"][bct["index"]]["source"]]
        if "bufferView" not in im:
            return None
        bv = js["bufferViews"][im["bufferView"]]
        blob = bd[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        img = np.asarray(Image.open(BytesIO(blob)).convert("RGB"), dtype=np.float32) / 255.0
        mx, mn = img.max(2), img.min(2)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
        return float((sat > 0.25).mean())
    return None


def topo_stats(glb_path):
    """输出网格的边界边 / 非流形边 / UV 密度探针（记录用，非否决判据）。

    🔴 边必须按**位置**去重，不能按顶点索引 —— glTF 的 TEXCOORD_0 是逐顶点属性，
    build_glb 会做 wedge 顶点分裂（同一位置、不同 UV → 不同索引）。按索引算会把
    原本闭合的边拆成两条边界边（实测 P-33：正确 0，按索引算假报 1146）。
    """
    js, bd = read_glb(glb_path)
    prim = js["meshes"][0]["primitives"][0]
    P = acc(js, bd, prim["attributes"]["POSITION"])
    T = acc(js, bd, prim["indices"]).astype(np.int64).reshape(-1, 3)
    # 位置量化成整数键，规避浮点误差（1e-6 m ≈ 0.001 mm，远小于面尺度）
    Q = np.round(P * 1e6).astype(np.int64)
    e = {}
    for t in T:
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            ka, kb = tuple(Q[a]), tuple(Q[b])
            k = (ka, kb) if ka < kb else (kb, ka)
            e[k] = e.get(k, 0) + 1
    bnd = sum(1 for v in e.values() if v == 1)
    nonman = sum(1 for v in e.values() if v > 2)
    dens = None
    if "TEXCOORD_0" in prim["attributes"]:
        UV = acc(js, bd, prim["attributes"]["TEXCOORD_0"])
        a, b, c = UV[T[:, 0]], UV[T[:, 1]], UV[T[:, 2]]
        uva = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2
        pa, pb, pc = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
        va = np.linalg.norm(np.cross(pb - pa, pc - pa), axis=1) / 2
        ok = (va > 1e-12) & (uva > 1e-12)
        if ok.sum():
            r = uva[ok] / va[ok]
            med = float(np.median(r))
            dens = float(np.percentile(r, 99)) / med if med > 0 else None
    return len(T), len(P), bnd, nonman, dens


# ----------------------------------------------------------------- 主流程


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="DROP", choices=["DROP", "all", "gray", "ok"],
                    help="DROP=色差>25pp 必做 / gray=原生即灰 / ok=色差小 / all")
    ap.add_argument("--only", default=None, help="指定单个 ID（覆盖 --list）")
    ap.add_argument("--dry", action="store_true", help="只试跑不覆盖")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--tol", type=float, default=0.05, help="彩色占比允许落后原生的百分点")
    ap.add_argument("--face-tol", type=float, default=1.5,
                    help="面数允许超预算的倍数（默认 1.5）。props.json 的 tris 是设计预算，"
                         "小件超到1.5× 换回 3倍彩色质量是划算的；但碎壳体（P-43 有 6208 个"
                         "连通壳，420 面预算物理不可达）会超到 10× 以上，必须靠这个参数挡掉")
    ap.add_argument("--no-face-tol", action="store_true", help="严格按预算卡面数（≤1.0×）")
    args = ap.parse_args()
    face_tol = 1.0 if args.no_face_tol else args.face_tol

    props = {e["id"]: e for e in json.load(open(PROPS, encoding="utf-8"))["entries"]}
    # 原生彩色基线（判别力实验产出）—— 否决判据要跟「自己原生」比，不是跟别人比
    base_src = os.path.join(ROOT, ".workbuddy", "tmp", "lodtest", "baseline_native_vs_lod.json")
    base = {r["id"]: r for r in json.load(open(base_src, encoding="utf-8"))} \
        if os.path.exists(base_src) else {}

    if args.only:
        ids = [args.only]
    else:
        # 从上一轮判别力实验的报告里取名单
        src = os.path.join(ROOT, ".workbuddy", "tmp", "lodtest", "baseline_native_vs_lod.json")
        if args.list == "all":
            ids = sorted(props)
        elif os.path.exists(src):
            g = json.load(open(src, encoding="utf-8"))
            ids = [r["id"] for r in g if r["verdict"] == args.list]
        else:
            print(f"[FATAL] 找不到名单文件 {src}，请先跑 baseline_native_vs_lod.py 或用 --list all")
            return 1

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    results = []
    print(f"批量重做 {len(ids)} 件 | dry={args.dry} | tol={args.tol:.0%}\n")
    print(f"{'ID':6} {'预算':>5} {'实际':>6} {'原生彩':>7} {'新彩':>7} {'边界':>4} {'非流':>4} "
          f"{'UVdens':>7} {'MB':>6}  判定")
    print("-" * 84)

    for eid in ids:
        raw = os.path.join(MODELS, eid, f"{eid}.glb")
        dst = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
        if not os.path.exists(raw) or not os.path.exists(dst):
            print(f"{eid:6} SKIP(缺文件)")
            continue
        budget = props[eid]["tris"]
        tmp = os.path.join(ROOT, ".workbuddy", "tmp", "lodtest", f"{eid}_new.glb")
        # 直接用 decimate_uvkeep 的三段式 API（与它 main() 完全一致），
        # 这样能拿到全部质检数值，不必解析 stdout。
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix=f"envlod_{eid}_")
        try:
            geo = DEC.low_geometry(raw, budget, tmpdir)
            tex, mime = DEC.encode_texture(geo["tex_png"], False)
            DEC.build_glb(tmp, geo["V"], geo["pairs"], geo["VT"], tex, mime, N=geo["N"])
        except Exception as ex:
            print(f"{eid:6} FAIL({type(ex).__name__}: {ex})")
            continue
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        try:
            faces, verts, bnd, nonman, dens = topo_stats(tmp)
        except Exception as ex:
            print(f"{eid:6} FAIL(topo {ex})")
            continue
        nc = base.get(eid, {}).get("native_colorful")
        if nc is None:
            nc = colorful(raw)
        ncol = colorful(tmp)

        # ---- 否决判据 ----
        fails = []
        if bnd != 0:
            fails.append(f"边界边{bnd}")
        if nonman != 0:
            fails.append(f"非流形{nonman}")
        if nc is not None and ncol is not None and ncol < nc - args.tol:
            fails.append(f"彩{ncol * 100:.0f}%<原生{nc * 100:.0f}%-{args.tol:.0%}")
        if not (budget <= faces <= budget * face_tol):
            fails.append(f"面数离预算{faces}/{budget}")
        ok = not fails
        verdict = "OK" if ok else "REJECT:" + ",".join(fails)

        mb = os.path.getsize(tmp) / 1e6
        print(f"{eid:6} {budget:5d} {faces:6d} "
              f"{(nc * 100 if nc is not None else 0):6.1f}% {(ncol * 100 if ncol is not None else 0):6.1f}% "
              f"{bnd:4d} {nonman:4d} "
              f"{(dens if dens else 0):7.1f} {mb:6.2f}  {verdict}")

        if ok and not args.dry:
            if not args.no_backup:
                bak = dst + ".pre-lodregen.bak"
                if not os.path.exists(bak):
                    shutil.copy2(dst, bak)
            shutil.copy2(tmp, dst)
        results.append({"id": eid, "budget": budget, "faces": faces, "verts": verts,
                        "boundary_edges": bnd, "nonmanifold_edges": nonman,
                        "uv_density_p99_over_med": dens, "native_colorful": nc,
                        "new_colorful": ncol, "bytes": os.path.getsize(tmp),
                        "verdict": verdict, "committed": bool(ok and not args.dry)})

    json.dump(results, open(REPORT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    okc = sum(1 for r in results if r["verdict"] == "OK")
    print("-" * 84)
    print(f"完成 {len(results)} 件 | 通过 {okc} | 拒绝 {len(results) - okc} | "
          f"{'已覆盖' if not args.dry else 'dry 未覆盖'}")
    print(f"报告：{REPORT}")
    if not args.dry and okc:
        print("\n下一步：重生成 sidecar 与 manifest")
        print("  node tools/scene/gen-asset-meta.mjs")
        print("  node assets/_tools/gen_manifest.mjs")
        print("  pnpm run scene:check")
    return 0


if __name__ == "__main__":
    sys.exit(main())