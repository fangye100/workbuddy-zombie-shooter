#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成「角色美术素材审阅页」HTML —— 24 张真图 + 剪影验收 + 数据对照。

真源：assets/characters/roster.json + assets/style/tokens.json
用法：
    python assets/characters/_tools/gen_asset_review.py

产出：
    assets/characters/角色美术素材审阅.html
"""
from __future__ import annotations

import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
ROSTER = ROOT / "assets" / "characters" / "roster.json"
TOKENS = ROOT / "assets" / "style" / "tokens.json"
OUT = ROOT / "assets" / "characters" / "角色美术素材审阅.html"

VIEWS = [("front", "正面"), ("side", "侧面"), ("attack", "攻击")]


def esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def load():
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    tokens = json.loads(TOKENS.read_text(encoding="utf-8"))
    colors: dict = {}
    for group in tokens["groups"].values():
        colors.update(group)
    return roster, colors


def img_exists(uid: str, view: str) -> bool:
    return (ROOT / "assets" / "characters" / "images" / uid / view / f"{uid}_{view}.png").is_file()


def img_path(uid: str, view: str) -> str:
    return f"images/{uid}/{view}/{uid}_{view}.png"


def css_vars(colors: dict) -> str:
    return "\n".join(f"      --{esc(k)}: {esc(v)};" for k, v in colors.items())


CSS = """
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:#0A0812;color:#FFF6E2;font-family:"Sarasa Gothic SC","更纱黑体 SC","Noto Sans SC","Microsoft YaHei",sans-serif;padding:28px 24px 80px}
h1{font-size:28px;font-weight:900;letter-spacing:.5px}
h2{font-size:20px;font-weight:900;color:#FF9F1C;margin:40px 0 14px;border-left:6px solid #FF9F1C;padding-left:12px}
h3{font-size:17px;font-weight:900;color:#FFF6E2;margin:18px 0 8px}
.sub{color:#9AA0A6;font-size:13px;margin-top:8px;line-height:1.7}
.num{font-family:"Inter","Arial Black",Impact,sans-serif;font-weight:900}
code{font-family:ui-monospace,Consolas,monospace;background:#171327;padding:2px 6px;border-radius:4px;font-size:12px}

.badge{display:inline-flex;align-items:center;justify-content:center;padding:4px 12px;border:3px solid #14110F;font-weight:900;font-size:14px;color:#14110F;margin-right:10px}
.hero{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.done{background:#8FD14F}

.warn{background:#3a1a12;border-left:6px solid #E8402A;padding:12px 16px;font-size:13px;line-height:1.7;color:#FFF6E2;margin:18px 0}
.ok{background:#1a3312;border-left-color:#8FD14F}

/* ---- 48px 剪影验收 ---- */
.sil-group{display:inline-flex;flex-direction:column;align-items:center;gap:6px;margin-right:18px}
.sil-imgs{display:flex;gap:6px}
.sil-imgs img{width:48px;height:48px;object-fit:contain;background:#221E33;border:3px solid #14110F}
.sil-id{font-size:12px;font-weight:900;color:#FFC531}
.sil-name{font-size:10px;color:#9AA0A6;max-width:66px;text-align:center;line-height:1.2}
.sil-row{overflow-x:auto;padding:14px;background:#171327;border:4px solid #14110F;white-space:nowrap}

/* ---- 角色卡片 ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:22px}
.card{background:#221E33;border:5px solid #14110F;padding:16px}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.card-title{display:flex;align-items:center;gap:10px}
.card-id{font-size:22px;font-weight:900;font-family:"Inter",sans-serif}
.card-cn{font-size:20px;font-weight:900}
.card-en{font-size:12px;color:#9AA0A6;font-family:"Inter",sans-serif;font-weight:900}
.card-threat{font-size:14px;font-weight:900;padding:4px 12px;border:3px solid #14110F;color:#14110F}
.card-views{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.view{position:relative;background:#0A0812;border:4px solid #14110F;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden}
.view img{max-width:100%;max-height:100%;object-fit:contain}
.view-lbl{position:absolute;bottom:0;left:0;right:0;background:rgba(20,17,15,0.85);color:#FFF6E2;font-size:12px;font-weight:900;padding:4px 8px;text-align:center}
.missing{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#E8402A;font-size:13px;font-weight:900}

.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}
.stat{background:#0A0812;border:3px solid #14110F;padding:8px 10px}
.stat-k{font-size:11px;color:#9AA0A6;font-weight:900;letter-spacing:1px}
.stat-v{font-size:15px;font-weight:900;color:#FFF6E2;line-height:1.3;word-break:break-word}

.meta{font-size:13px;line-height:1.6;color:#FFF6E2;margin-bottom:6px}
.meta b{color:#FFC531}

/* ---- 预警矩阵 ---- */
table{width:100%;border-collapse:collapse;background:#221E33;border:4px solid #14110F;font-size:14px;margin-top:10px}
th{background:#0A0812;color:#9AA0A6;padding:10px;border:2px solid #14110F;text-align:left}
td{padding:10px;border:2px solid #14110F;vertical-align:top}
td.id{font-weight:900;color:#FFC531;white-space:nowrap}
td.shape{color:#2BC4D6;font-weight:900}

/* ---- 投放矩阵 ---- */
.spawn td,.spawn th{text-align:center}
.spawn td.on{color:#8FD14F;font-weight:900;font-size:18px}
.spawn td.off{color:#3A3550}
.spawn td.act{text-align:left;font-weight:900}
.spawn .act-en{font-size:11px;color:#6B6880;margin-left:6px}

.footer{margin-top:60px;color:#6B6880;font-size:12px}
"""


def silhouette_section(units: list[dict]) -> str:
    groups = []
    for u in units:
        imgs = []
        for key, label in VIEWS:
            if img_exists(u["id"], key):
                src = img_path(u["id"], key)
                imgs.append(f'<img src="{src}" title="{esc(u["name"])} · {esc(label)}">')
            else:
                imgs.append(f'<img src="" alt="缺失" title="缺失" class="missing">')
        groups.append(
            f'<div class="sil-group">'
            f'<div class="sil-imgs">{ "".join(imgs) }</div>'
            f'<div class="sil-id">{esc(u["id"])}</div>'
            f'<div class="sil-name">{esc(u["name"])}</div>'
            f'</div>'
        )
    return f"""
<section>
  <h2>48px 剪影验收</h2>
  <div class="sub">把 24 张图缩到游戏内实际可读尺寸，8 角色必须 0.3s 可辨。重点看 E-03（球腹细腿）vs E-05（正圆球）、B-02（上下双体）vs B-03（瘦高）。</div>
  <div class="sil-row">{''.join(groups)}</div>
</section>
"""


def stat_block(label: str, value) -> str:
    return f'<div class="stat"><div class="stat-k">{esc(label)}</div><div class="stat-v">{esc(value)}</div></div>'


def card(unit: dict, is_boss: bool, threat_colors: dict) -> str:
    threat = unit.get("threat", "")
    threat_color = threat_colors.get(threat, "teal")
    uid = unit["id"]

    views = []
    for key, label in VIEWS:
        if img_exists(uid, key):
            views.append(
                f'<div class="view"><img src="{img_path(uid, key)}" alt="{esc(label)}"><div class="view-lbl">{esc(label)}</div></div>'
            )
        else:
            views.append(f'<div class="view"><div class="missing">缺失</div><div class="view-lbl">{esc(label)}</div></div>')

    stats = [
        stat_block("HP", unit.get("hp")),
        stat_block("移速", unit.get("speed")),
        stat_block("三角面", f'{unit.get("tris"):,}' if isinstance(unit.get("tris"), int) else unit.get("tris")),
        stat_block("身高", unit.get("height")),
    ]

    if is_boss:
        vuln = unit.get("vulnerable", "")
        arena = unit.get("arena", "")
        notes = f"<b>场景:</b> {esc(arena)}　<b>破防:</b> {esc(vuln)}"
    else:
        notes = f"<b>定位:</b> {esc(unit.get('role',''))}"

    atk_tele = ""
    if is_boss:
        tele_lines = [f"<b>{esc(a['key'])}</b> {esc(a['name'])} — {esc(a['telegraph'])}" for a in unit.get("attacks", [])]
        atk_tele = "<br>".join(tele_lines)
    elif unit.get("attack"):
        a = unit["attack"]
        atk_tele = f"<b>{esc(a['name'])}</b> — {esc(a['telegraph'])}"

    return f"""
<div class="card" id="{esc(uid)}">
  <div class="card-head">
    <div class="card-title">
      <span class="card-id">{esc(uid)}</span>
      <div>
        <div class="card-cn">{esc(unit['name'])}</div>
        <div class="card-en">{esc(unit['en'])}</div>
      </div>
    </div>
    <div class="card-threat" style="background:var(--{esc(threat_color)})">{esc(threat)}</div>
  </div>
  <div class="card-views">{''.join(views)}</div>
  <div class="stats">{''.join(stats)}</div>
  <div class="meta">{notes}</div>
  <div class="meta"><b>剪影:</b> {esc(unit.get('silhouette',''))}</div>
  <div class="meta"><b>预警:</b> {atk_tele}</div>
</div>
"""


def character_section(units: list[dict], threat_colors: dict) -> str:
    all_units = units["npcs"] + units["bosses"]
    cards = "".join(card(u, u in units["bosses"], threat_colors) for u in all_units)
    return f"""
<section>
  <h2>角色卡 · 8 个单位 × 3 视图</h2>
  <div class="sub">真源驱动的卡片，改设定请改 roster.json，然后重跑脚本。</div>
  <div class="grid">{cards}</div>
</section>
"""


def telegraph_matrix(units: list[dict]) -> str:
    rows = []
    for u in units["npcs"] + units["bosses"]:
        is_boss = u in units["bosses"]
        if is_boss:
            shapes = " / ".join(f"{a['key']}={a['telegraph'].split('，')[0].split('。')[0]}" for a in u.get("attacks", []))
        else:
            shapes = u["attack"]["telegraph"].split("，")[0].split("。")[0] if u.get("attack") else ""
        rows.append(
            f"<tr><td class='id'>{esc(u['id'])} {esc(u['name'])}</td>"
            f"<td class='shape'>{esc(shapes)}</td>"
            f"<td>{esc(u.get('silhouette',''))}</td></tr>"
        )
    return f"""
<section>
  <h2>预警形状语言矩阵</h2>
  <div class="sub">确保同一幕内不会出现读错的预警形状。扇形 → 直线 → 落点圈 → 弧形 → 十字 → 体态突变，分级不能串。</div>
  <table>
    <thead><tr><th>角色</th><th>预警形状</th><th>剪影关键词</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
</section>
"""


def spawn_matrix(roster: dict) -> str:
    units = {u["id"]: u for u in roster["npcs"] + roster["bosses"]}
    head = "".join(f"<th>{esc(u['id'])}</th>" for u in roster["npcs"])
    head += "<th>BOSS</th><th>场地</th>"
    rows = []
    for act in roster["levelStructure"]:
        cells = []
        for npc in roster["npcs"]:
            on = npc["id"] in act["enemies"]
            cells.append(f"<td class='{'on' if on else 'off'}'>{'●' if on else '·'}</td>")
        boss = units[act["boss"]]
        rows.append(
            f"<tr>"
            f"<td class='act' style='color:var(--{esc(act['color'])});text-align:left'>"
            f"<b>Act {act['act']}</b> {esc(act['name'])}"
            f"<span class='act-en'>{esc(act['en'])}</span></td>"
            f"<td>{esc(act['waves'])} 波</td>"
            f"{''.join(cells)}"
            f"<td style='color:var(--{esc(boss.get('accent','gold'))});font-weight:900'>"
            f"{esc(act['boss'])} {esc(boss['name'])}</td>"
            f"<td style='font-size:12px;color:#9AA0A6'>{esc(act['arena'])}</td>"
            f"</tr>"
        )
    return f"""
<section>
  <h2>投放矩阵</h2>
  <table class="spawn">
    <thead><tr><th>幕</th><th>波</th>{head}</tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
</section>
"""


def build() -> str:
    roster, colors = load()
    all_units = roster["npcs"] + roster["bosses"]
    done = sum(1 for u in all_units for k, _ in VIEWS if img_exists(u["id"], k))
    total = len(all_units) * len(VIEWS)

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>角色美术素材审阅 · 末日尸潮</title>
<style>
:root{{
{css_vars(colors)}
}}
{CSS}
</style></head><body>

<div class="hero">
  <span class="badge {'done' if done==total else ''}">{done}/{total}</span>
  <div>
    <h1>角色美术素材审阅 · 末日尸潮</h1>
    <div class="sub">由 <code>assets/characters/roster.json</code> + <code>assets/style/tokens.json</code> + <code>images/</code> 自动生成
      （<code>_tools/gen_asset_review.py</code>）。改设定改 roster.json，改风格改 tokens.json，不要手改本文件。</div>
  </div>
</div>

{'' if done==total else f'<div class="warn">还缺 {total-done} 张，补完后重跑脚本刷新。</div>'}

{silhouette_section(all_units)}

{character_section(roster, roster['threatColors'])}

{telegraph_matrix(roster)}

{spawn_matrix(roster)}

<div class="footer">末日尸潮 · 横屏肉鸽射击 UI · 角色美术素材审阅页</div>

</body></html>"""


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"written: {OUT}")
