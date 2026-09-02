# -*- coding: utf-8 -*-
"""
生成「角色 Frame 施工图」HTML —— 画布施工的 1:1 底稿。

铁律：内容全部来自唯一真源，改设定请改 roster.json，改风格请改 tokens.json，
      然后重跑本脚本，不要手改产出的 HTML。

用法：
    python assets/characters/_tools/gen_canvas_preview.py

产出：
    assets/characters/角色Frame施工图.html
"""

import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
ROSTER = ROOT / "assets" / "characters" / "roster.json"
TOKENS = ROOT / "assets" / "style" / "tokens.json"
OUT = ROOT / "assets" / "characters" / "角色Frame施工图.html"

VIEW_KEYS = [("front", "正面 · FRONT"), ("side", "侧面 · SIDE"), ("attack", "攻击 · ATTACK")]


def esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def load():
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    tokens = json.loads(TOKENS.read_text(encoding="utf-8"))
    colors = {}
    for group in tokens["groups"].values():
        colors.update(group)
    return roster, colors


def css_vars(colors: dict) -> str:
    lines = []
    for name, value in colors.items():
        lines.append(f"      --{esc(name)}: {esc(value)};")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 单个角色 / Boss 的 Frame
# --------------------------------------------------------------------------

def stat_cells(unit: dict, is_boss: bool) -> str:
    stats = [
        ("HP", unit.get("hp")),
        ("移速", unit.get("speed")),
        ("三角面", f'{unit.get("tris"):,}' if isinstance(unit.get("tris"), int) else unit.get("tris")),
        ("弱点", unit.get("vulnerable") if is_boss else unit.get("weakness")),
    ]
    cells = []
    for i, (label, value) in enumerate(stats):
        x = 24 + i * (372 + 8)
        long_cls = " is-long" if label == "弱点" else ""
        cells.append(
            f'<div class="stat{long_cls}" style="left:{x}px">'
            f'<div class="stat-k">{esc(label)}</div>'
            f'<div class="stat-v">{esc(value)}</div>'
            f"</div>"
        )
    return "".join(cells)


def note_rows(unit: dict, is_boss: bool) -> str:
    """NPC 用整块注释行；Boss 用三行写三条攻击/阶段机制。"""
    if is_boss:
        rows = []
        for i, atk in enumerate(unit.get("attacks", [])):
            y = 768 + i * (32 + 6)
            key = atk.get("key", "")
            name = atk.get("name", "")
            en = atk.get("en", "")
            desc = atk.get("desc", "")
            tele = atk.get("telegraph", "")
            rows.append(
                f'<div class="bossnote" style="top:{y}px">'
                f'<span class="bn-key">{esc(key)}</span>'
                f'<span class="bn-name">{esc(name)}</span>'
                f'<span class="bn-en">{esc(en)}</span>'
                f'<span class="bn-desc">{esc(desc)}</span>'
                f'<span class="bn-tele">预警 · {esc(tele)}</span>'
                f"</div>"
            )
        return "".join(rows)

    lines = [
        ("定位", unit.get("role")),
        ("剪影", unit.get("silhouette")),
        ("预警", unit["attack"]["telegraph"] if unit.get("attack") else ""),
    ]
    text = "".join(
        f'<div class="note-line"><span class="note-k">{esc(k)}</span>{esc(v)}</div>'
        for k, v in lines
    )
    return f'<div class="noteblock" style="top:768px">{text}</div>'


def view_cards(unit: dict, style_suffix: str) -> str:
    cards = []
    for i, (key, label) in enumerate(VIEW_KEYS):
        x = 24 + i * 516  # 480 + 36 gap
        prompt = " ".join(
            p for p in [unit["ai"]["base"], unit["ai"].get(key, ""), style_suffix] if p
        )
        img_rel = f"images/{esc(unit['id'])}/{esc(key)}/{esc(unit['id'])}_{esc(key)}.png"
        img_abs = ROOT / "assets" / "characters" / img_rel
        if img_abs.is_file():
            img_html = (
                f'<img src="{img_rel}" alt="{esc(label)}" '
                f'style="max-width:100%;max-height:100%;object-fit:contain">'
            )
        else:
            img_html = (
                f'<div class="ph-title">{esc(label)}</div>'
                f'<div class="ph-sil">{esc(unit.get("silhouette", ""))}</div>'
                f'<pre class="ph-prompt">{esc(prompt)}</pre>'
            )
        cards.append(
            f'<div class="viewcard" style="left:{x}px;top:112px">'
            f'<div class="cardimg">{img_html}</div>'
            f'<div class="cardlabel">{esc(label)}</div>'
            f"</div>"
        )
    return "".join(cards)


def unit_frame(unit: dict, is_boss: bool, page: int, style_suffix: str, colors: dict,
               threat_colors: dict) -> str:
    threat = unit.get("threat", "")
    threat_token = threat_colors.get(threat, "teal")
    accent = unit.get("accent", "teal")

    return f"""
<div class="frame" data-unit="{esc(unit['id'])}">
  <div class="titlebar">
    <div class="badge" style="background:var(--{esc(accent)})">{esc(unit['id'])}</div>
    <div class="name-cn">{esc(unit['name'])}</div>
    <div class="name-en">{esc(unit['en'])}</div>
    <div class="threatpill" style="background:var(--{esc(threat_token)})">
      <span class="tp-k">威胁度</span><span class="tp-v">{esc(threat)}</span>
    </div>
  </div>
  {view_cards(unit, style_suffix)}
  <div class="bottompanel">
    <div class="panel-frame">{stat_cells(unit, is_boss)}{note_rows(unit, is_boss)}</div>
  </div>
  <div class="page-tag">PAGE {page}</div>
</div>"""


# --------------------------------------------------------------------------
# Page 15 · 图鉴索引
# --------------------------------------------------------------------------

def index_frame(roster: dict, colors: dict) -> str:
    acts = roster["levelStructure"]
    units = {u["id"]: u for u in roster["npcs"] + roster["bosses"]}

    head = "".join(f"<th>{esc(u['id'])}</th>" for u in roster["npcs"])
    head += "<th class='col-boss'>BOSS</th>"

    rows = []
    for act in acts:
        cells = []
        for npc in roster["npcs"]:
            on = npc["id"] in act["enemies"]
            mark = "●" if on else "·"
            cells.append(f"<td class='{'on' if on else 'off'}'>{mark}</td>")
        rows.append(
            f"<tr>"
            f"<td class='act'><span class='act-dot' style='background:var(--{esc(act['color'])})'></span>"
            f"<b>Act {act['act']}</b> {esc(act['name'])}"
            f"<span class='act-en'>{esc(act['en'])}</span></td>"
            f"<td class='waves'>{esc(act['waves'])} 波</td>"
            f"{''.join(cells)}"
            f"<td class='boss'><span style='color:var(--{esc(units[act['boss']].get('accent','gold'))})'>"
            f"{esc(act['boss'])} {esc(units[act['boss']]['name'])}</span></td>"
            f"<td class='arena'>{esc(act['arena'])}</td>"
            f"</tr>"
        )

    chips = []
    for u in roster["npcs"] + roster["bosses"]:
        chips.append(
            f"<div class='chip'>"
            f"<div class='chip-box' style='background:var(--{esc(u.get('accent','teal'))})'>{esc(u['id'])}</div>"
            f"<div class='chip-nm'>{esc(u['name'])}</div>"
            f"<div class='chip-sl'>{esc(u.get('silhouette',''))}</div>"
            f"</div>"
        )

    return f"""
<div class="frame" data-unit="IDX">
  <div class="titlebar">
    <div class="badge" style="background:var(--teal)">IDX</div>
    <div class="name-cn">敌群图鉴 · 投放矩阵</div>
    <div class="name-en">ENEMY CODEX · SPAWN MATRIX</div>
    <div class="threatpill" style="background:var(--gold)">
      <span class="tp-k">幕</span><span class="tp-v">4 · 共 12 波</span>
    </div>
  </div>

  <div class="idx-table" style="left:24px;top:112px;width:1512px">
    <table>
      <thead><tr>
        <th class='act'>幕 / ARENA</th><th class='waves'>WAVES</th>{head}<th class='arena'>场地特征</th>
      </tr></thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
  </div>

  <div class="idx-chips">
    <div class="chips-title">剪影对照 · 48px（出图后必须拼在一起复验：E-03 球腹细腿 vs E-05 正圆球 是唯一高风险对）</div>
    <div class="chips">{' '.join(chips)}</div>
  </div>
  <div class="page-tag">PAGE 15</div>
</div>"""


# --------------------------------------------------------------------------
# 页面骨架
# --------------------------------------------------------------------------

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0812;color:#FFF6E2;
  font-family:"Sarasa Gothic SC","更纱黑体 SC","Noto Sans SC","Microsoft YaHei",sans-serif;
  padding:28px 24px 80px}
h1{font-size:26px;font-weight:900;letter-spacing:.5px}
.sub{color:#9AA0A6;font-size:13px;margin-top:6px;line-height:1.7}
.num{font-family:"Inter","Arial Black",Impact,sans-serif;font-weight:900}

/* ---- 缩放器：内部一律用画布真实坐标 ---- */
.scaler{position:relative;margin:0 auto}
.frame{position:absolute;top:0;left:0;width:1560px;height:900px;
  transform:scale(var(--s));transform-origin:0 0;
  background:#0E0C16;outline:6px solid #14110F}

/* ---- 标题栏 ---- */
.titlebar{position:absolute;left:0;top:0;width:1560px;height:96px;
  background:#221E33;border:6px solid #14110F}
.badge{position:absolute;left:28px;top:20px;width:84px;height:56px;
  border:4px solid #14110F;color:#14110F;font-weight:900;font-size:24px;
  display:flex;align-items:center;justify-content:center}
.name-cn{position:absolute;left:132px;top:12px;font-size:40px;font-weight:900;line-height:1}
.name-en{position:absolute;left:132px;top:60px;font-size:20px;color:#9AA0A6;
  font-family:"Inter","Arial Black",sans-serif;font-weight:900;letter-spacing:1px}
.threatpill{position:absolute;left:1300px;top:26px;width:232px;height:44px;
  border:4px solid #14110F;display:flex;align-items:center;justify-content:center;gap:12px;color:#14110F}
.tp-k{font-size:18px;font-weight:900;opacity:.75}
.tp-v{font-size:26px;font-weight:900}
.page-tag{position:absolute;right:16px;bottom:10px;font-size:18px;color:#6B6880;
  font-family:"Inter",sans-serif;font-weight:900;letter-spacing:2px}

/* ---- 三视图卡 ---- */
.viewcard{position:absolute;width:480px;height:540px;
  background:#221E33;border:6px solid #14110F}
.cardimg{position:absolute;left:20px;top:20px;width:440px;height:420px;
  background:#0A0812;border:4px dashed #3A3550;overflow:hidden;padding:12px}
.ph-title{font-size:17px;font-weight:900;color:#FFC531;margin-bottom:8px}
.ph-sil{font-size:14px;color:#9AA0A6;line-height:1.5;margin-bottom:10px;
  max-height:60px;overflow:hidden}
.ph-prompt{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;line-height:1.45;
  color:#6B6880;white-space:pre-wrap;word-break:break-word}
.cardlabel{position:absolute;left:20px;top:452px;width:440px;height:68px;
  background:#14110F;color:#FFF6E2;display:flex;align-items:center;justify-content:center;
  font-size:26px;font-weight:900;letter-spacing:2px}

/* ---- 底部面板 ---- */
.bottompanel{position:absolute;left:24px;top:676px;width:1512px;height:200px;
  background:#221E33;border:6px solid #14110F}
.panel-frame{position:absolute;inset:0}
.stat{position:absolute;top:16px;width:372px;height:64px;
  background:#0A0812;border:4px solid #14110F;padding:6px 12px;overflow:hidden}
.stat-k{font-size:14px;color:#9AA0A6;font-weight:900;letter-spacing:1px}
.stat-v{font-size:24px;font-weight:900;color:#FFF6E2;line-height:1.15;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat.is-long .stat-v{font-size:15px;white-space:normal;line-height:1.25;
  max-height:38px;overflow:hidden}

.noteblock{position:absolute;left:24px;width:1464px;height:92px;
  background:#0A0812;border:4px solid #14110F;padding:6px 12px;overflow:hidden}
.note-line{font-size:15px;line-height:1.45;color:#FFF6E2;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note-k{display:inline-block;min-width:44px;color:#FFC531;font-weight:900;margin-right:10px}

.bossnote{position:absolute;left:24px;width:1464px;height:32px;
  background:#0A0812;border:4px solid #14110F;
  display:flex;align-items:center;gap:12px;padding:0 12px;overflow:hidden}
.bn-key{flex:0 0 auto;background:#FFC531;color:#14110F;font-weight:900;font-size:14px;
  padding:1px 8px;border:2px solid #14110F}
.bn-name{flex:0 0 auto;font-weight:900;font-size:16px;color:#FFF6E2}
.bn-en{flex:0 0 auto;font-size:12px;color:#6B6880;font-family:"Inter",sans-serif;font-weight:900}
.bn-desc{flex:1 1 auto;font-size:14px;color:#FFF6E2;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.bn-tele{flex:0 0 auto;font-size:13px;color:#2BC4D6;white-space:nowrap}

/* ---- 索引页 ---- */
.idx-table{position:absolute}
.idx-table table{width:1512px;border-collapse:collapse;background:#221E33;
  border:6px solid #14110F;font-size:15px}
.idx-table th{background:#0A0812;color:#9AA0A6;font-size:13px;padding:8px 6px;
  border:2px solid #14110F;letter-spacing:1px}
.idx-table td{padding:12px 10px;border:2px solid #14110F;color:#FFF6E2;vertical-align:middle}
.idx-table td.act{font-size:15px;font-weight:900}
.idx-table td.act b{color:#FFC531}
.idx-table td.act .act-en{color:#6B6880;font-size:12px;margin-left:8px;
  font-family:"Inter",sans-serif;font-weight:900}
.act-dot{display:inline-block;width:12px;height:12px;border:2px solid #14110F;
  margin-right:8px;vertical-align:middle}
.idx-table td.waves,.idx-table th.waves{text-align:center;color:#9AA0A6;
  font-family:"Inter",sans-serif;font-weight:900}
.idx-table td.on{text-align:center;color:#8FD14F;font-size:20px;font-weight:900}
.idx-table td.off{text-align:center;color:#3A3550;font-size:20px}
.idx-table td.boss{font-weight:900;font-size:14px;white-space:nowrap}
.idx-table td.arena{font-size:13px;color:#9AA0A6;line-height:1.4}

.idx-chips{position:absolute;left:24px;top:512px;width:1512px;height:150px;
  background:#221E33;border:6px solid #14110F;padding:10px 14px}
.chips-title{font-size:13px;color:#FFC531;font-weight:900;margin-bottom:8px}
.chips{display:flex;gap:8px}
.chip{flex:1;text-align:center}
.chip-box{width:48px;height:48px;margin:0 auto 6px;border:4px solid #14110F;
  color:#14110F;font-size:13px;font-weight:900;
  display:flex;align-items:center;justify-content:center}
.chip-nm{font-size:13px;font-weight:900;color:#FFF6E2}
.chip-sl{font-size:10px;color:#9AA0A6;line-height:1.25;margin-top:3px;height:26px;overflow:hidden}

/* ---- 页面装饰 ---- */
section{margin-top:44px}
h2{font-size:20px;font-weight:900;color:#FF9F1C;margin-bottom:6px;
  border-left:6px solid #FF9F1C;padding-left:10px}
.hint{font-size:13px;color:#9AA0A6;line-height:1.7;margin-bottom:16px}
.grid3{display:flex;flex-wrap:wrap;gap:18px;justify-content:center}
.contact{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;justify-items:center}
.contact .scaler{--s:.3}
.detail .scaler{--s:.8;margin-bottom:24px}
details{background:#221E33;border:4px solid #14110F;margin-bottom:10px}
summary{cursor:pointer;padding:10px 14px;font-weight:900;font-size:15px;color:#FFC531}
details pre{white-space:pre-wrap;word-break:break-word;padding:0 14px 14px;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;color:#FFF6E2}
details .pl{margin:0 14px 10px;font-size:12px;color:#9AA0A6;font-weight:900}
.warn{background:#3a1a12;border-left:6px solid #E8402A;padding:10px 14px;
  font-size:13px;line-height:1.7;color:#FFF6E2;margin:14px 0}
"""


def build() -> str:
    roster, colors = load()
    suffix = roster["styleSuffix"]
    threat_colors = roster["threatColors"]

    frames = []
    for f in roster["canvas"]["frames"]:
        cid = f["id"]
        if cid == "IDX":
            frames.append((f["page"], index_frame(roster, colors)))
            continue
        unit = next(
            (u for u in roster["npcs"] + roster["bosses"] if u["id"] == cid), None
        )
        if unit is None:
            continue
        is_boss = unit in roster["bosses"]
        frames.append((f["page"], unit_frame(unit, is_boss, f["page"], suffix,
                                             colors, threat_colors)))

    contact = "".join(
        f'<div class="scaler" style="width:{int(1560*.3)}px;height:{int(900*.3)}px">'
        f'<a href="#p{page}" style="display:block">{body}</a></div>'
        for page, body in frames
    )
    detail = "".join(
        f'<div id="p{page}" class="scaler" style="width:{int(1560*.8)}px;'
        f'height:{int(900*.8)}px">{body}</div>'
        for page, body in frames
    )

    prompt_blocks = []
    for u in roster["npcs"] + roster["bosses"]:
        items = []
        for key, label in VIEW_KEYS:
            p = " ".join(x for x in [u["ai"]["base"], u["ai"].get(key, ""), suffix] if x)
            items.append(f'<div class="pl">{esc(label)}</div><pre>{esc(p)}</pre>')
        prompt_blocks.append(
            f"<details><summary>{esc(u['id'])} {esc(u['name'])} · {esc(u['en'])}"
            f"</summary>{''.join(items)}</details>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>角色 Frame 施工图 · 末日尸潮</title>
<style>
:root{{
{css_vars(colors)}
}}
{CSS}
</style></head><body>

<h1>角色 Frame 施工图 · 末日尸潮</h1>
<div class="sub">
由 <code>assets/characters/roster.json</code> + <code>assets/style/tokens.json</code> 自动生成
（<code>_tools/gen_canvas_preview.py</code>）。<br>
坐标与 <code>画布施工交接单.md</code> 完全一致，可直接当作 Ardot 画布施工底稿。
改设定改 roster.json，改风格改 tokens.json，然后重跑脚本 —— 不要手改本文件。
</div>

<div class="warn">
<b>状态：</b>三视图卡内已嵌入当前 assets/characters/images/ 下的图；若某格缺失则回退显示完整提示词。
出图后重跑本脚本即可刷新。
</div>

<section>
  <h2>总览 · 9 Frame 落位</h2>
  <div class="hint">对应画布 Page 10–18（3 行 × 3 列）。点击可跳到该 Frame 明细。</div>
  <div class="contact">{contact}</div>
</section>

<section class="detail">
  <h2>Frame 明细 · 1:1 坐标</h2>
  <div class="hint">每格严格使用画布坐标：Frame 1560×900、标题栏 h96、视图卡 480×540、
    底部面板 1512×200、数据格 372×64（gap 8）。</div>
  {detail}
</section>

<section>
  <h2>AI 出图提示词 · 24 条</h2>
  <div class="hint">已按规则拼接为可直接投喂的完整提示词，展开即复制。</div>
  {''.join(prompt_blocks)}
</section>

</body></html>"""


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"written: {OUT}")
