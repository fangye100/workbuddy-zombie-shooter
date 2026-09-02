# -*- coding: utf-8 -*-
"""
verify_roster.py — 全名册资产校验（数据层，无需浏览器/无头 Chrome）。

扫 roster.json 的 8 个角色，对每个已生成角色：
  - glob `models/<id>/rigged/*_rigged_animated.glb`（不依赖 manifest 里的写死文件名，
    防止重命名导致索引漂移）
  - 跑 validate_glb.py 做 bind-pose LBS 自洽 + animated sanity
  - 汇总成 8 行状态矩阵 + 6/8 计数

用途
----
- 每次新增/重烤角色后一键核对全名册状态。
- 与 roster_manifest.json 互补：manifest 是「意图索引」（给引擎/编辑器消费），
  本脚本是「实际核对」（从磁盘 glob，独立发现产物）。
- 不碰 git、不启动浏览器，秒级跑完。

用法
----
    python verify_roster.py
"""
import glob
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))  # 项目根 (_tools⊂characters⊂assets⊂root)
ROSTER = os.path.normpath(os.path.join(_HERE, "..", "roster.json"))
VALIDATE = os.path.join(_HERE, "validate_glb.py")
PY = r"C:/Users/fangy/.workbuddy/binaries/python/versions/3.13.12/python.exe"


def load_roster_ids():
    with open(ROSTER, encoding="utf-8") as f:
        d = json.load(f)
    ids = []
    for key in ("npcs", "bosses"):
        for c in d.get(key, []):
            ids.append((c["id"], c.get("name"), c.get("en")))
    return ids


def latest(pattern):
    hits = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def check_one(cid):
    base = os.path.join(_ROOT, "assets", "characters", "models", cid, "rigged")
    rigged = latest(os.path.join(base, "*_rigged.glb"))
    animated = latest(os.path.join(base, "*_rigged_animated.glb"))
    if not animated:
        return {"id": cid, "state": "MISSING", "detail": "无 *_rigged_animated.glb"}
    if not rigged:
        return {"id": cid, "state": "PARTIAL", "detail": "有 animated 但缺 rigged"}

    out = subprocess.run(
        [PY, "-u", VALIDATE, rigged, "--animated", animated],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    log = (out.stdout or "") + (out.stderr or "")
    ok = (out.returncode == 0) and ("[FAIL]" not in log) and ("[PASS]" in log)
    # 提取关键 PASS 行
    passes = [ln.strip() for ln in log.splitlines() if ln.strip().startswith("[PASS]")]
    return {
        "id": cid,
        "state": "OK" if ok else "FAIL",
        "rigged": os.path.basename(rigged),
        "animated": os.path.basename(animated),
        "detail": " | ".join(passes) if passes else (log.strip().splitlines()[-1] if log.strip() else "no output"),
    }


def main():
    rows = []
    for cid, name, en in load_roster_ids():
        r = check_one(cid)
        r["name"] = name
        r["en"] = en
        rows.append(r)

    done = sum(1 for r in rows if r["state"] == "OK")
    n = len(rows)

    print(f"{'ID':<6}{'角色':<10}{'EN':<14}{'状态':<9}{'资产 / 校验'}")
    print("-" * 78)
    for r in rows:
        tag = {"OK": "✅ DONE", "FAIL": "❌ FAIL", "MISSING": "⏳ PENDING", "PARTIAL": "⚠ PARTIAL"}[r["state"]]
        asset = r.get("animated") or r.get("detail", "")
        print(f"{r['id']:<6}{r['name']:<10}{(r['en'] or '')[:12]:<14}{tag:<9}{asset}")
        if r["state"] in ("OK", "FAIL"):
            for p in (r.get("detail", "") or "").split(" | "):
                if p:
                    print(f"{'':<6}{'':<10}{'':<14}{'':<9}   ↳ {p}")

    print("-" * 78)
    print(f"名册资产状态: {done}/{n} 通过校验")
    pending = [r["id"] for r in rows if r["state"] in ("MISSING", "PARTIAL", "FAIL")]
    if pending:
        print(f"待处理: {', '.join(pending)}")
        if any(r["state"] == "MISSING" for r in rows):
            print("  MISSING = 混元每日 5 次提交上限挡住，待额度刷新后 "
                  "`pipeline_character.py --id <id>` 补齐")
    return 0 if done == n else 1


if __name__ == "__main__":
    sys.exit(main())
