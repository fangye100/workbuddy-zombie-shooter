#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""角色美术素材进度核对 + 缺失项提示词导出。

真源：assets/characters/roster.json（不要在这里改设定）
用法：
    python assets/characters/_tools/check_assets.py              # 打印 24 格进度表
    python assets/characters/_tools/check_assets.py --missing    # 额外打印缺失项的完整提示词
    python assets/characters/_tools/check_assets.py --json       # 机器可读输出

约定目录：assets/characters/images/<ID>/<view>/<ID>_<view>.png
    ID   = E-01..E-05 / B-01..B-03
    view = front / side / attack
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # assets/
ROSTER = ROOT / "characters" / "roster.json"
IMGDIR = ROOT / "characters" / "images"

VIEWS = ("front", "side", "attack")
VIEW_LABEL = {"front": "正面", "side": "侧面", "attack": "攻击"}


def load_units() -> list[dict]:
    data = json.loads(ROSTER.read_text(encoding="utf-8"))
    units = data["npcs"] + data["bosses"]
    return data, units


def img_path(uid: str, view: str) -> Path:
    return IMGDIR / uid / view / f"{uid}_{view}.png"


def build_prompt(unit: dict, view: str, style_suffix: str) -> str:
    """roster 里的拼接规则：base + view + styleSuffix。改规则改这里一处。"""
    return " ".join(
        p.strip()
        for p in (unit["ai"]["base"], unit["ai"][view], style_suffix)
        if p and p.strip()
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--missing", action="store_true", help="打印缺失项的完整提示词")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    data, units = load_units()
    suffix = data["styleSuffix"]

    rows, missing = [], []
    for u in units:
        uid = u["id"]
        rec = {"id": uid, "name": u["name"], "en": u["en"], "views": {}}
        for v in VIEWS:
            p = img_path(uid, v)
            ok = p.is_file()
            rec["views"][v] = {"ok": ok, "path": str(p.relative_to(ROOT)) if ok else None}
            if not ok:
                missing.append(
                    {
                        "id": uid,
                        "name": u["name"],
                        "view": v,
                        "viewLabel": VIEW_LABEL[v],
                        "outPath": str(p.relative_to(ROOT)),
                        "prompt": build_prompt(u, v, suffix),
                    }
                )
        rows.append(rec)

    total = len(units) * len(VIEWS)
    done = total - len(missing)

    if args.json:
        print(json.dumps({"total": total, "done": done, "missing": missing},
                         ensure_ascii=False, indent=2))
        return 0

    print(f"进度：{done}/{total}")
    print()
    head = "ID    角色        " + "  ".join(f"{VIEW_LABEL[v]:<4}" for v in VIEWS)
    print(head)
    print("-" * len(head.encode("gbk", errors="ignore")) if False else "-" * 40)
    for r in rows:
        cells = "  ".join(("OK  " if r["views"][v]["ok"] else " -- ") for v in VIEWS)
        print(f"{r['id']:<6}{r['name']:<10}  {cells}")

    # 额外扫描：目录里存在但不属于任何格子的文件
    stray = [
        str(p.relative_to(ROOT))
        for p in IMGDIR.rglob("*.png")
        if not any(p.samefile(img_path(r["id"], v))
                   for r in rows for v in VIEWS if img_path(r["id"], v).is_file())
    ]
    if stray:
        print(f"\n未归入标准命名的文件 {len(stray)} 个：")
        for s in stray:
            print("  ", s)

    if missing:
        print(f"\n缺失 {len(missing)} 项：")
        for m in missing:
            print(f"  - {m['id']} {m['name']} / {m['viewLabel']} ({m['view']}) -> {m['outPath']}")
        if args.missing:
            print("\n" + "=" * 70)
            print("完整提示词（可直接复制投喂 ImageGen）")
            print("=" * 70)
            for m in missing:
                print(f"\n### {m['id']} {m['name']} · {m['viewLabel']} {m['view'].upper()}")
                print(f"# 落地: {m['outPath']}")
                print(m["prompt"])
    else:
        print("\n24 格全齐。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
