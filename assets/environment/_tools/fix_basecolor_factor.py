# -*- coding: utf-8 -*-
"""修复环境 LOD1 的 baseColorFactor —— 「LOD 色彩没继承」的真正根因。

症状
----
同一件道具在 asset browser 里切LOD0（混元 raw）/ LOD1（低模），色彩完全不一样，
LOD1 明显发灰发暗。

根因
----
LOD1 材质里带 `pbrMetallicRoughness.baseColorFactor = [0.4, 0.4, 0.4, 1]`。
glTF 规范里 baseColorFactor 是**乘在贴图上**的整体色调 —— 0.4 灰乘子把贴图压暗到 40%，
所以贴图本身再准也全灰。跟 UV / 贴图内容**无关**。

来源：`env_transfer.py` 的 `pack_glb()` 用 trimesh 导出，trimesh 的
`TextureVisuals` 会硬写这个 0.4（它自己的默认材质色）。trimesh 不暴露该参数，
只能在导出后改 JSON —— 生成器那边已修（`_fix_base_color_factor`），本工具修存量。

实测：11 件中招，恰好等于「旧转移烘焙」那11 件（P-01 P-02 P-05 P-11 P-12 P-16
P-43 P-44 S-01 S-02 S-07）。27 件路线 A 产物不受影响（decimate_uvkeep 自己写 glb，
baseColorFactor 是 1,1,1）。

用法
----
  python fix_basecolor_factor.py            # 修复（先备份 .pre-bcf.bak）
  python fix_basecolor_factor.py --check    # 门禁：只校验，有残留 exit 1
"""
import argparse
import json
import os
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.normpath(os.path.join(HERE, ".."))
MODELS = os.path.join(ENV, "models")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BAK = ".pre-bcf.bak"


def read_chunks(path):
    raw = open(path, "rb").read()
    json_len = struct.unpack_from("<I", raw, 12)[0]
    js = json.loads(raw[20:20 + json_len].decode("utf-8"))
    padded = json_len + ((4 - json_len % 4) % 4)
    return raw, js, 20 + padded


def offenders(path):
    """返回 [(materialIndex, factor)]，factor 非 1.0 即中招。"""
    _, js, _ = read_chunks(path)
    out = []
    for i, m in enumerate(js.get("materials") or []):
        f = (m.get("pbrMetallicRoughness") or {}).get("baseColorFactor")
        if f and any(abs(v - 1.0) > 1e-3 for v in f[:3]):
            out.append((i, f))
    return out


def fix(path):
    raw, js, bin_off = read_chunks(path)
    changed = 0
    for m in js.get("materials") or []:
        pbr = m.setdefault("pbrMetallicRoughness", {})
        f = pbr.get("baseColorFactor")
        if f and any(abs(v - 1.0) > 1e-3 for v in f[:3]):
            pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
            changed += 1
    if not changed:
        return 0
    new_json = json.dumps(js, separators=(",", ":")).encode("utf-8")
    new_json += b" " * ((4 - len(new_json) % 4) % 4)      # JSON chunk 补空格（0x20）
    bin_chunk = raw[bin_off:]
    total = 12 + 8 + len(new_json) + len(bin_chunk)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(new_json), 0x4E4F534A) + new_json
    out += bin_chunk
    open(path, "wb").write(bytes(out))
    return changed


def targets():
    """所有 tex2/<ID>_baked.glb（环境 LOD1 的实际存放处）。"""
    for eid in sorted(os.listdir(MODELS)):
        p = os.path.join(MODELS, eid, "tex2", f"{eid}_baked.glb")
        if os.path.exists(p):
            yield eid, p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，有残留 exit 1")
    args = ap.parse_args()

    rows = []
    for eid, p in targets():
        try:
            offs = offenders(p)
        except Exception as ex:
            print(f"{eid:6} ERR {type(ex).__name__}: {ex}")
            continue
        rows.append((eid, p, offs))

    bad = [(e, p, o) for e, p, o in rows if o]

    if args.check:
        if bad:
            print(f"[FAIL] {len(bad)} 件环境 LOD1 的 baseColorFactor != 1（会被压暗到 40%）:")
            for e, _, o in bad:
                print(f"  - {e}: {o[0][1]}")
            print("修复：python assets/environment/_tools/fix_basecolor_factor.py")
            return 1
        print(f"[check] {len(rows)} 件环境 LOD1 的 baseColorFactor 全部为 1")
        return 0

    if not bad:
        print(f"[noop] {len(rows)} 件全部正常，无需修复")
        return 0

    print(f"修复 {len(bad)} 件：\n")
    for eid, p, offs in bad:
        bak = p + BAK
        if not os.path.exists(bak):
            shutil.copy2(p, bak)
        n = fix(p)
        left = offenders(p)
        flag = "OK" if not left else f"仍残留 {left}"
        print(f"  {eid:6} baseColorFactor {offs[0][1][:3]} → 1,1,1 "
              f"（改 {n} 个材质, 备份 {os.path.basename(bak)}） {flag}")

    # 修完复核
    still = [e for e, p in targets() if offenders(p)]
    print()
    if still:
        print(f"[FAIL] 修复后仍有残留: {still}")
        return 1
    print(f"[OK] {len(rows)} 件全部为1.0（备份后缀 {BAK}，已 gitignore）")
    return 0


if __name__ == "__main__":
    sys.exit(main())