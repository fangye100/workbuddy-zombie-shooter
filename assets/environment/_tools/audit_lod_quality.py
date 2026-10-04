# -*- coding: utf-8 -*-
"""Audit both environment LODs using GLB provenance, hashes and generation reports.
Texture format is only a legacy heuristic, never proof of geometric/visual quality.
Colour coverage is measured on a 256-pixel thumbnail for human diagnostics.
Run without arguments to refresh lod-quality.json; --check rejects stale/failed data.
"""
import argparse
import hashlib
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
    width, height = img.size
    img.thumbnail((256, 256))
    a = np.asarray(img, dtype=np.float32) / 255.0
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    mime = im.get("mimeType")
    return {
        "mime": mime,
        "texW": width,
        "texH": height,
        "colorful": round(float((sat > 0.25).mean()), 4),
        # 🔴 结构性判据：JPEG + 4096² = 路线 A 内嵌的混元原生贴图
        "alg": ("routeA-v2" if js.get('asset', {}).get('generator') == 'aether environment uvkeep-v2'
                else "routeA" if (mime == "image/jpeg" and width >= 4096) else "transfer"),
        "sha256": hashlib.sha256(open(path, 'rb').read()).hexdigest(),
        "tris": sum(js['accessors'][p['indices']]['count'] // 3 for m in js['meshes'] for p in m['primitives']),
        "baseColorFactor": mats[prim.get('material', 0)].get('pbrMetallicRoughness', {}).get('baseColorFactor', [1, 1, 1, 1]),
    }


def collect():
    rows = {}
    expected = json.load(open(os.path.join(ENV, 'props.json'), encoding='utf-8'))['entries']
    for eid in sorted(e['id'] for e in expected):
        lod = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
        if not os.path.exists(lod):
            rows[eid] = {'alg': 'unknown', 'error': 'missing LOD1'}
            continue
        try:
            r = probe(lod)
            if r:
                lod2 = os.path.join(MODELS, eid, 'tex2', f'{eid}_lod2.glb')
                r['lod2'] = probe(lod2) if os.path.exists(lod2) else None
                rows[eid] = r
            else:
                rows[eid] = {'alg': 'unknown', 'error': 'missing embedded baseColor texture'}
        except Exception as ex:
            rows[eid] = {"alg": "unknown", "error": type(ex).__name__}
    return rows


def build(rows):
    return {
        "_comment": "本文件由 assets/environment/_tools/audit_lod_quality.py 生成，"
                    "gen_manifest.mjs 读它给 asset browser 打算法标记。别手改。",
        "_judge": "v2 uses explicit generator provenance plus source/output hashes and numeric reports; legacy texture format is only a heuristic.",
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
    rA = [k for k, v in rows.items() if v["alg"] in ("routeA", "routeA-v2")]

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
            elif c != v:
                bad.append(f"{k}: LOD hash/texture/material/geometry data is stale")
            if v.get('alg') == 'unknown':
                bad.append(f'{k}: cannot inspect model')
            for level in (v, v.get('lod2')):
                if level and level.get('baseColorFactor') != [1, 1, 1, 1]:
                    bad.append(f'{k}: baseColorFactor must be white')
            if v.get('alg') == 'routeA-v2':
                second = v.get('lod2')
                if not second or second.get('alg') != 'routeA-v2' or second['tris'] >= v['tris']:
                    bad.append(f'{k}: missing/invalid textured LOD2')
                meta = json.load(open(os.path.join(MODELS, k, 'tex2', f'{k}_baked.glb.meta.json'), encoding='utf-8'))
                report = meta.get('userData', {}).get('lodBuildResult', {})
                if report.get('config') != meta.get('userData', {}).get('lodBuild'):
                    bad.append(f'{k}: stale generation settings')
                props = json.load(open(os.path.join(ENV, 'props.json'), encoding='utf-8'))['entries']
                if report.get('footprint') != next(e['footprint'] for e in props if e['id'] == k):
                    bad.append(f'{k}: stale placement dimensions')
                source = os.path.join(MODELS, k, f'{k}.glb')
                if report.get('sourceHash') != hashlib.sha256(open(source, 'rb').read()).hexdigest():
                    bad.append(f'{k}: stale LOD source')
                levels = report.get('levels', [])
                if len(levels) != 2 or any(x.get('failures') for x in levels):
                    bad.append(f'{k}: missing/failed generation checks')
                elif levels[0]['sha256'] != v['sha256'] or not second or levels[1]['sha256'] != second['sha256']:
                    bad.append(f'{k}: generation report does not match delivered LODs')
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
    with open(OUT + ".pending", "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(OUT + ".pending", OUT)
    print(f"写入 {OUT}")
    print(f"routeA {len(rA)} / transfer {len(rows) - len(rA)}")
    print("transfer: " + " ".join(k for k, v in rows.items() if v["alg"] not in ("routeA", "routeA-v2")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
