# -*- coding: utf-8 -*-
"""生成 assets/_data/lod-quality.json —— asset browser 的 LOD 算法溯源数据。

用途
----
`asset-browser.html` 要能一眼看出每件道具的 LOD1 是「路线 A」还是「旧转移烘焙」，
让 2026-10-04 那批 LOD 重做的成果在页面上可见、可查、可复核。

判据（结构性、零阈值、100% 自证）
----------------------------------
  LOD1 内嵌贴图 = JPEG + 4096²  → routeA   （decimate_uvkeep 直接内嵌混元原生 4096²
                                           贴图，>4MB 自动转 JPEG q92）
  LOD1 内嵌贴图 = PNG  + 512²   → transfer（env_transfer 用 --size 512 烘的顶点色转移版）
实测 38 件 → JPEG 27 / PNG 11，与「pre-lodregen.bak 备份在不在」的判定 27/11 完全一致。

🔴 为什么不用备份文件判定：备份是本地回滚用、已 gitignore，换机器/重新克隆后不在，
   全部资产会被误标成旧法。
🔴 为什么不用彩度阈值判定：旧产物的彩度是连续长尾（0% ~ 43%，中位 26.4%），
   与路线 A 产物（87.0%）**有重叠**（P-05=43% / P-43=38% / P-11=37% 都是旧产物但彩度不低）
   → 单一阈值必然误判。贴图格式+尺寸是结构性的，不存在这个问题。

用法
----
  python audit_lod_quality.py            # 写入 assets/_data/lod-quality.json
  python audit_lod_quality.py --check    # 只校验现文件与实测是否一致（门禁用）
"""
import argparse
import json
import os
import struct
import sys
import time
from io import BytesIO

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", ".."))   # ← assets/
ENV = os.path.join(ASSETS, "environment")
MODELS = os.path.join(ENV, "models")
# 🔴 输出在 assets/_data/（与 asset-manifest.json 同级），不是 assets/environment/_data/。
#    gen_manifest.mjs 从 ASSETS/_data/lod-quality.json 读，两边必须一致。
OUT = os.path.join(ASSETS, "_data", "lod-quality.json")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_glb(path):
    raw = open(path, "rb").read()
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


def probe(path):
    """→ {mime,texW,texH,colorful,alg} 或 None（无内嵌贴图）。"""
    js, bd = read_glb(path)
    prim = js["meshes"][0]["primitives"][0]
    mats = js.get("materials") or []
    bct = mats[prim.get("material", 0)].get("pbrMetallicRoughness", {}).get("baseColorTexture") if mats else None
    if not bct:
        return None
    im = js["images"][js["textures"][bct["index"]]["source"]]
    if "bufferView" not in im:
        return None
    bv = js["bufferViews"][im["bufferView"]]
    blob = bd[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    img = Image.open(BytesIO(blob)).convert("RGB")
    a = np.asarray(img, dtype=np.float32) / 255.0
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    mime = im.get("mimeType")
    return {
        "mime": mime,
        "texW": img.size[0],
        "texH": img.size[1],
        "colorful": round(float((sat > 0.25).mean()), 4),
        # 🔴 结构性判据：JPEG + 4096² = 路线 A 内嵌的混元原生贴图
        "alg": "routeA" if (mime == "image/jpeg" and img.size[0] >= 4096) else "transfer",
    }


def collect():
    rows = {}
    for eid in sorted(os.listdir(MODELS)):
        lod = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
        if not os.path.exists(lod):
            continue
        try:
            r = probe(lod)
            if r:
                rows[eid] = r
        except Exception as ex:
            rows[eid] = {"alg": "unknown", "error": type(ex).__name__}
    return rows


def build(rows):
    return {
        "_comment": "本文件由 assets/environment/_tools/audit_lod_quality.py 生成，"
                    "gen_manifest.mjs 读它给 asset browser 打算法标记。别手改。",
        "_judge": "LOD1 内嵌贴图 JPEG+4096²=路线A(decimate_uvkeep 直接内嵌混元原生贴图)；"
                  "PNG+512²=旧转移烘焙(env_transfer --size 512)。结构性判据，无阈值。",
        "_colorful": "LOD1 贴图彩色占比 = 饱和度>0.25 的像素比例。仅供人工判读，"
                     "不做算法判定（旧产物彩度与路线 A 有重叠，见脚本 docstring）。",
        "_generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environments": rows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验现文件与实测一致，不写盘")
    args = ap.parse_args()
    rows = collect()
    doc = build(rows)
    rA = [k for k, v in rows.items() if v["alg"] == "routeA"]

    if args.check:
        if not os.path.exists(OUT):
            print(f"[FAIL] {OUT} 不存在，先跑 python audit_lod_quality.py")
            return 1
        cur = json.load(open(OUT, encoding="utf-8"))
        curEnv = cur.get("environments", {})
        bad = []
        for k, v in rows.items():
            c = curEnv.get(k)
            if not c:
                bad.append(f"{k}: 现文件缺该件")
            elif c.get("alg") != v["alg"]:
                bad.append(f"{k}: alg 现={c.get('alg')} 实测={v['alg']}")
            elif c.get("mime") != v["mime"] or c.get("texW") != v["texW"]:
                bad.append(f"{k}: 贴图 {c.get('mime')} {c.get('texW')} ≠ 实测 {v['mime']} {v['texW']}")
        for k in curEnv:
            if k not in rows:
                bad.append(f"{k}: 现文件多出该件")
        if bad:
            print(f"[FAIL] lod-quality.json 与磁盘不同步（{len(bad)} 项）：")
            for b in bad[:12]:
                print("  - " + b)
            print("修复：python assets/environment/_tools/audit_lod_quality.py")
            return 1
        print(f"[check] lod-quality.json 与磁盘一致（{len(rows)} 件 · 路线A {len(rA)}）")
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # 🔴 必须 newline="" + 显式指定换行，否则 Windows 上 Python 文本模式默认写 CRLF，
    #    git 会拒收（fatal: CRLF would be replaced by LF）且仓库标准是 LF。
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"写入 {OUT}")
    print(f"routeA {len(rA)} / transfer {len(rows) - len(rA)}")
    print("transfer: " + " ".join(k for k, v in rows.items() if v["alg"] != "routeA"))
    return 0


if __name__ == "__main__":
    sys.exit(main())