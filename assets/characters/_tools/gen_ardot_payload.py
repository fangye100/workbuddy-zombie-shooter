# -*- coding: utf-8 -*-
"""
生成 Ardot 画布 batch_edit 施工载荷 —— 9 个角色 Frame 的逐条操作脚本。

铁律：内容全部来自唯一真源。改设定请改 roster.json，改风格请改 tokens.json，
      然后重跑本脚本，不要手改产出的 md / 画布上的字。

语法依据（官方，勿凭记忆改）：
    ~/.workbuddy/plugins/cache/workbuddy-builtin/skill-ardot-design-core/0.1.2/
        references/ardot-schema.md   节点属性 schema
        tool-usage/batch-edit.md     操作语法 + 禁用属性表
        rules/design-rules.md        effects / fills 写法

关键约束：binding 名只在**单次 batch_edit 调用内**有效；跨批次必须用真实节点 ID。
          因此每个 Frame 的第 1 步以页面根为父，后续步骤用 <<占位符>> 承接上一步返回的 ID。

用法：
    python assets/characters/_tools/gen_ardot_payload.py

产出：
    assets/characters/ardot_batch_edit.md
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
ROSTER = ROOT / "assets" / "characters" / "roster.json"
TOKENS = ROOT / "assets" / "style" / "tokens.json"
OUT = ROOT / "assets" / "characters" / "ardot_batch_edit.md"

PAGE_ROOT = "0:1"
MAX_OPS = 25  # batch_edit 官方上限

VIEWS = [("front", "正面 · FRONT"), ("side", "侧面 · SIDE"), ("attack", "攻击 · ATTACK")]

CN_FONT = '{family: "Sarasa Gothic SC", style: "Bold"}'
EN_FONT = '{family: "Inter", style: "Black"}'

SOLID = '{type: "SOLID", color: {r: %s, g: %s, b: %s}, opacity: 1, visible: true, blendMode: "NORMAL"}'
SHADOW = ('[{type: "DROP_SHADOW", color: {r: %s, g: %s, b: %s, a: 1}, '
          'offset: {x: %d, y: %d}, radius: 0, spread: 0, visible: true, '
          'blendMode: "NORMAL", showShadowBehindNode: true, boundVariables: {}}]')

THREAT_TOKEN = {"低": "teal", "中": "warn", "高": "blood", "极高": "gold"}


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def hex2rgb(h: str):
    h = h.lstrip("#")
    return tuple(round(int(h[i:i + 2], 16) / 255, 2) for i in (0, 2, 4))


def solid(h: str) -> str:
    return SOLID % hex2rgb(h)


def shadow(h: str, off: int = 6) -> str:
    return SHADOW % (hex2rgb(h) + (off, off))


def jstr(s) -> str:
    """普通内容 → 安全 JS 双引号字面量。"""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def jsvg(svg: str) -> str:
    """SVG 源码 → 安全 JS 双引号字面量（属性双引号转义为 \\\"）。"""
    return '"' + svg.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "") + '"'


def ph(key: str) -> str:
    """跨批次占位符：<<E01_FRAME_ID>>"""
    return f"<<{key}>>"


def load():
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    tokens = json.loads(TOKENS.read_text(encoding="utf-8"))
    colors = {}
    for group in tokens["groups"].values():
        colors.update(group)
    return roster, colors


def T(bind, name, content, size, fill, parent="PARENT", font=CN_FONT, weight='"700"',
      width=None, autoresize='"WIDTH_AND_HEIGHT"', extra=""):
    """text 节点插入操作。"""
    w = f", width: {width}" if width else ""
    ar = f", textAutoResize: {autoresize}" if autoresize else ""
    ex = (", " + extra) if extra else ""
    return (f'{bind}=I({parent}, {{type: "text", name: {jstr(name)}, '
            f'content: {jstr(content)}, fontSize: {size}, fill: {jstr(fill)}, '
            f'fontName: {font}, fontWeight: {weight}{w}{ar}{ex}}})')


def box(bind, name, x, y, w, h, fill, parent="PARENT", radius=18, sw=4, ink=None,
        hard_shadow=True, layout=None, extra=""):
    """frame 节点插入操作（默认 ink 描边 + 6px 硬边投影）。"""
    stroke = f', strokes: [{solid(ink)}], strokeWeight: {sw}' if ink else ""
    eff = f", effects: {shadow(ink)}" if (ink and hard_shadow) else ""
    lay = f', layout: "{layout}"' if layout else ""
    ex = (", " + extra) if extra else ""
    return (f'{bind}=I({parent}, {{type: "frame", name: {jstr(name)}, '
            f'x: {x}, y: {y}, width: {w}, height: {h}, fill: {jstr(fill)}, '
            f'cornerRadius: {radius}{stroke}{eff}{lay}{ex}}})')


# --------------------------------------------------------------------------
# 48px 剪影 SVG（按 roster.silhouette 关键词落形，viewBox 0 0 48 64）
# --------------------------------------------------------------------------

def svg_wrap(inner: str, ink: str) -> str:
    return (f'<svg width="48" height="64" viewBox="0 0 48 64" fill="none" '
            f'xmlns="http://www.w3.org/2000/svg"><g fill="{ink}" stroke="{ink}" '
            f'stroke-linecap="round" stroke-linejoin="round">{inner}</g></svg>')


SILHOUETTES = {
    # 倒三角躯干 + 双臂垂过膝 + 头部低垂
    "E-01": ('<circle cx="24" cy="15" r="7"/>'
             '<path d="M13 24h22l-6 22H19z"/>'
             '<rect x="8" y="24" width="5" height="31" rx="2.5"/>'
             '<rect x="35" y="24" width="5" height="31" rx="2.5"/>'
             '<rect x="17" y="46" width="5" height="16" rx="2"/>'
             '<rect x="26" y="46" width="5" height="16" rx="2"/>'),
    # 水平压缩 + 四肢外张 + 前倾头颅
    "E-02": ('<circle cx="40" cy="20" r="5.5"/>'
             '<ellipse cx="24" cy="29" rx="17" ry="8"/>'
             '<path d="M13 22l3-7 3 7 3-7 3 7 3-7 3 7z"/>'
             '<path d="M11 34L4 49M18 36l-4 16M30 36l4 16M37 34l7 15" stroke-width="4"/>'
             '<path d="M8 27Q0 23-2 16" stroke-width="3"/>'),
    # 巨大球腹 + 萎缩细肢 + 上仰喷口头
    "E-03": ('<circle cx="24" cy="35" r="15"/>'
             '<circle cx="25" cy="15" r="5.5"/>'
             '<path d="M30 12l12-6v14l-12-2z"/>'
             '<rect x="7" y="33" width="4" height="14" rx="2"/>'
             '<rect x="37" y="33" width="4" height="14" rx="2"/>'
             '<rect x="19" y="47" width="3.5" height="14" rx="1.5"/>'
             '<rect x="25.5" y="47" width="3.5" height="14" rx="1.5"/>'),
    # 厚重金属矩形 + 单侧巨大盾板 · 左右强不对称
    "E-04": ('<rect x="3" y="13" width="19" height="44" rx="2"/>'
             '<rect x="24" y="16" width="15" height="40" rx="3"/>'
             '<rect x="24" y="7" width="15" height="11" rx="2"/>'
             '<rect x="26" y="11" width="11" height="3" fill="#F5E7C8" stroke="none"/>'
             '<rect x="38" y="22" width="9" height="27" rx="4.5"/>'
             '<rect x="26" y="54" width="5" height="8" rx="2"/>'
             '<rect x="33" y="54" width="5" height="8" rx="2"/>'),
    # 正圆球 + 无脖子 + 最小头身比
    "E-05": ('<circle cx="24" cy="37" r="18"/>'
             '<circle cx="24" cy="16" r="5"/>'
             '<rect x="5" y="40" width="6" height="13" rx="3"/>'
             '<rect x="37" y="40" width="6" height="13" rx="3"/>'
             '<rect x="17" y="53" width="5" height="9" rx="2"/>'
             '<rect x="26" y="53" width="5" height="9" rx="2"/>'
             '<path d="M14 33l6 4-3 6M28 33l6 4-3 6" stroke="#FFC531" stroke-width="2"/>'),
    # 宽肩倒梯形 + 右臂单点长垂（肉钩）
    "B-01": ('<path d="M7 16h34l-6 25H13z"/>'
             '<circle cx="24" cy="10" r="6"/>'
             '<path d="M39 20l5 20v12" stroke-width="4"/>'
             '<path d="M44 52q0 8-8 8" stroke-width="4"/>'
             '<rect x="1" y="21" width="9" height="19" rx="4.5"/>'
             '<rect x="15" y="40" width="6" height="21" rx="2"/>'
             '<rect x="26" y="40" width="6" height="21" rx="2"/>'
             '<path d="M14 62h8M26 62h8" stroke-width="2"/>'),
    # 上下双体（地面产卵囊 + 反折上身）+ 双臂拖地
    "B-02": ('<ellipse cx="24" cy="45" rx="18" ry="15"/>'
             '<path d="M19 34q-9-13 3-21" stroke-width="7" fill="none"/>'
             '<circle cx="30" cy="10" r="5"/>'
             '<path d="M18 30L6 51M30 32l14 20" stroke-width="4.5" fill="none"/>'
             '<rect x="3" y="0" width="42" height="3" rx="1.5"/>'),
    # 瘦高 + 破碎下摆 + 胸腔纵向裂口发光
    "B-03": ('<circle cx="24" cy="9" r="5.5"/>'
             '<rect x="19" y="15" width="10" height="30" rx="3"/>'
             '<path d="M24 20l3 10-3 8-3-8z" fill="#9B5DE5" stroke="#9B5DE5"/>'
             '<path d="M13 40h22l-2 12-5-6-4 8-4-8-5 6z"/>'
             '<rect x="20" y="52" width="4" height="10" rx="1.5"/>'
             '<rect x="25" y="52" width="4" height="10" rx="1.5"/>'
             '<path d="M8 20v40M4 24h8" stroke-width="2" fill="none"/>'),
}


# --------------------------------------------------------------------------
# 角色 / Boss Frame
# --------------------------------------------------------------------------

def unit_stats(u: dict, is_boss: bool):
    tris = u.get("tris")
    tris = f"{tris:,}" if isinstance(tris, int) else tris
    return [
        ("HP", str(u.get("hp"))),
        ("移速", str(u.get("speed"))),
        ("三角面", str(tris)),
        ("弱点", (u.get("vulnerable") if is_boss else u.get("weakness")) or "—"),
    ]


def build_unit_frame(u: dict, is_boss: bool, spec: dict, L: dict, C: dict,
                     suffix: str) -> list:
    """返回 [(title, [op, ...]), ...]，每步 <= MAX_OPS。"""
    ink, paper, bone = C["ink"], C["paper"], C["bone"]
    panel, deep, dim = C["panel"], C["panel-deep"], C["text-dim"]
    accent = C.get(u.get("accent"), bone)
    threat = u.get("threat", "低")
    tcolor = C.get(THREAT_TOKEN[threat], bone)

    fw, fh = spec["w"], spec["h"]
    key = u["id"]
    tag = key.replace("-", "")
    steps = []

    # ---- Step 1：外框 + 标题栏 + 三视图卡（父 = 页面根）----
    ops = []
    ops.append(f'{tag}F=I("{PAGE_ROOT}", {{type: "frame", '
               f'name: {jstr(f'{key} {u["name"]} {u["en"]}')}, '
               f'x: {spec["x"]}, y: {spec["y"]}, '
               f'width: {fw}, height: {fh}, fill: {jstr(panel)}, cornerRadius: 24, '
               f'strokes: [{solid(ink)}], strokeWeight: 6}})')

    tbh = L["titleBar"]["h"]
    ops.append(box(f"{tag}TB", "标题栏", 0, 0, fw, tbh, panel, parent=f"{tag}F",
                   radius=24, sw=6, ink=ink, hard_shadow=False,
                   extra="topLeftRadius: 24, topRightRadius: 24, "
                         "bottomLeftRadius: 0, bottomRightRadius: 0"))

    b = L["badge"]
    ops.append(box(f"{tag}BG", "Badge", b["x"], b["y"], b["w"], b["h"], accent,
                   parent=f"{tag}TB", radius=10, sw=4, ink=ink))

    ops.append(T(f"{tag}CN", "名称-中", u["name"], 40, bone, parent=f"{tag}TB",
                 extra=f'x: {L["nameCn"]["x"]}, y: {L["nameCn"]["y"]}'))
    ops.append(T(f"{tag}EN", "名称-英", u["en"], 20, dim, parent=f"{tag}TB",
                 font=EN_FONT,
                 extra=f'x: {L["nameEn"]["x"]}, y: {L["nameEn"]["y"]}'))

    p = L["threatPill"]
    ops.append(box(f"{tag}TP", "威胁度", p["x"], p["y"], p["w"], p["h"], tcolor,
                   parent=f"{tag}TB", radius=22, sw=4, ink=ink, layout="horizontal",
                   extra='primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"'))
    ops.append(T(f"{tag}TPT", "威胁度-文字", f"威胁度 {threat}", 22, ink,
                 parent=f"{tag}TP"))

    ci, cl = L["cardImage"], L["cardLabel"]
    for i, (vk, label) in enumerate(VIEWS):
        card = L["viewCards"][i]
        short = label.split(" · ")[0]
        cb = f"{tag}C{i + 1}"
        ops.append(box(cb, f"视图卡-{short}", card["x"], card["y"], card["w"],
                       card["h"], deep, parent=f"{tag}F", radius=18, sw=4, ink=ink))
        ops.append(box(f"{cb}I", f"图-{short}", ci["x"], ci["y"], ci["w"], ci["h"],
                       paper, parent=cb, radius=12, sw=0, hard_shadow=False))
        ops.append(f'G({cb}I, "ai", {jstr(" ".join([u["ai"]["base"], u["ai"][vk], suffix]))})')
        ops.append(box(f"{cb}L", f"标签-{short}", cl["x"], cl["y"], cl["w"], cl["h"],
                       panel, parent=cb, radius=12, sw=4, ink=ink, layout="horizontal",
                       extra='primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"'))
        ops.append(T(f"{cb}LT", f"标签文字-{short}", label, 24, bone, parent=f"{cb}L"))

    steps.append((f"Step {key}-1 · 外框 / 标题栏 / 三视图卡", ops, None))

    # ---- Step 2：底部数据面板（父 = 上一步返回的外框 ID）----
    root = ph(f"{key}_FRAME_ID")
    ops2 = []
    bp = L["bottomPanel"]
    ops2.append(box(f"{tag}BP", "数据面板", bp["x"], bp["y"], bp["w"], bp["h"], deep,
                    parent=root, radius=18, sw=4, ink=ink))

    sc = L["statCells"]
    for i, (label, value) in enumerate(unit_stats(u, is_boss)):
        cx = i * (sc["w"] + sc["gap"])
        cbind = f"{tag}S{i + 1}"
        ops2.append(box(cbind, f"数据-{label}", cx, sc["y"], sc["w"], sc["h"], panel,
                        parent=f"{tag}BP", radius=12, sw=4, ink=ink, layout="vertical",
                        extra='paddingTop: 8, paddingLeft: 12, paddingRight: 12, itemSpacing: 2'))
        ops2.append(T(f"{cbind}K", f"数据-{label}-名", label, 14, dim, parent=cbind,
                      weight='"500"'))
        long = len(value) > 18
        ops2.append(T(f"{cbind}V", f"数据-{label}-值", value, 20 if long else 22, bone,
                      parent=cbind, width=sc["w"] - 24 if long else None,
                      autoresize='"HEIGHT"' if long else '"WIDTH_AND_HEIGHT"'))

    if is_boss:
        bn = L["bossNoteRows"]
        for i, at in enumerate(u.get("attacks", [])[:bn["count"]]):
            ry = bn["y"] + i * (bn["h"] + bn["gap"])
            rbind = f"{tag}N{i + 1}"
            ops2.append(box(rbind, f"机制-{at['key']}", 16, ry, bp["w"] - 32, bn["h"],
                            panel, parent=f"{tag}BP", radius=10, sw=0,
                            hard_shadow=False, layout="horizontal",
                            extra='paddingLeft: 12, itemSpacing: 10, counterAxisAlignItems: "CENTER"'))
            ops2.append(T(f"{rbind}K", f"机制-{at['key']}-键", at["key"], 16, accent,
                          parent=rbind, weight='"900"'))
            ops2.append(T(f"{rbind}V", f"机制-{at['key']}-文",
                          f'{at["name"]} · {at["desc"]}', 15, bone, parent=rbind,
                          weight='"500"', width=bp["w"] - 120, autoresize='"HEIGHT"'))
    else:
        nr = L["noteRow"]
        ops2.append(box(f"{tag}NR", "注释", 16, nr["y"], bp["w"] - 32, nr["h"], panel,
                        parent=f"{tag}BP", radius=10, sw=0, hard_shadow=False,
                        extra='paddingTop: 10, paddingLeft: 12, paddingRight: 12'))
        note = (f'剪影：{u["silhouette"]}　｜　预警：{u["attack"]["telegraph"]}'
                f'　｜　定位：{u["role"]}')
        ops2.append(T(f"{tag}NRT", "注释-文字", note, 16, bone, parent=f"{tag}NR",
                      weight='"500"', width=bp["w"] - 56, autoresize='"HEIGHT"'))

    steps.append((f"Step {key}-2 · 底部数据面板", ops2, f"{key}_FRAME_ID"))
    return steps


# --------------------------------------------------------------------------
# Page 15 · 敌群图鉴索引
# --------------------------------------------------------------------------

def build_index(roster: dict, spec: dict, L: dict, C: dict) -> list:
    ink, paper, bone = C["ink"], C["paper"], C["bone"]
    panel, deep, dim = C["panel"], C["panel-deep"], C["text-dim"]
    fw = spec["w"]
    steps = []

    # ---- Step 1：外框 + 标题栏（父 = 页面根）----
    ops = []
    ops.append(f'IDXF=I("{PAGE_ROOT}", {{type: "frame", '
               f'name: {jstr("IDX 敌群图鉴 · 投放矩阵")}, '
               f'x: {spec["x"]}, y: {spec["y"]}, '
               f'width: {fw}, height: {spec["h"]}, fill: {jstr(panel)}, '
               f'cornerRadius: 24, strokes: [{solid(ink)}], strokeWeight: 6}})')
    tbh = L["titleBar"]["h"]
    ops.append(box("IDXTB", "标题栏", 0, 0, fw, tbh, panel, parent="IDXF", radius=24,
                   sw=6, ink=ink, hard_shadow=False,
                   extra="topLeftRadius: 24, topRightRadius: 24, "
                         "bottomLeftRadius: 0, bottomRightRadius: 0"))
    b = L["badge"]
    ops.append(box("IDXBG", "Badge", b["x"], b["y"], b["w"], b["h"], C["gold"],
                   parent="IDXTB", radius=10, sw=4, ink=ink))
    ops.append(T("IDXCN", "名称-中", "敌群图鉴 · 投放矩阵", 40, bone, parent="IDXTB",
                 extra=f'x: {L["nameCn"]["x"]}, y: {L["nameCn"]["y"]}'))
    ops.append(T("IDXEN", "名称-英", "ENEMY CODEX · SPAWN MATRIX", 20, dim,
                 parent="IDXTB", font=EN_FONT,
                 extra=f'x: {L["nameEn"]["x"]}, y: {L["nameEn"]["y"]}'))
    p = L["threatPill"]
    ops.append(box("IDXTP", "索引标", p["x"], p["y"], p["w"], p["h"], C["teal"],
                   parent="IDXTB", radius=22, sw=4, ink=ink, layout="horizontal",
                   extra='primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"'))
    ops.append(T("IDXTPT", "索引标-文字", "索引 · INDEX", 22, ink, parent="IDXTP"))
    steps.append(("Step IDX-1 · 外框 / 标题栏", ops, None))

    # ---- 投放矩阵：4 幕 × 3 波 ----
    cols = [("幕", 280), ("波次", 120), ("场景", 660), ("敌种", 280), ("BOSS", 172)]
    mw = fw - 48
    row_style = ('layout: "horizontal", counterAxisAlignItems: "MIN", '
                 'strokeTopWeight: 0, strokeRightWeight: 0, strokeLeftWeight: 0, '
                 'strokeBottomWeight: 3')

    def row_ops(bind, name, texts, parent, fill, size=16, weight='"500"', color=None):
        """texts 为 5 段文本，列宽取 cols[i][1]。"""
        assert len(texts) == len(cols), f"{name}: {len(texts)} 段文本 != {len(cols)} 列"
        o = [f'{bind}=I({parent}, {{type: "frame", name: {jstr(name)}, '
             f'x: 0, y: 0, width: "fill_container", height: "hug_contents", '
             f'fill: {jstr(fill)}, strokes: [{solid(ink)}], {row_style}, '
             f'paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10}})']
        for i, text in enumerate(texts):
            o.append(T(f"{bind}C{i + 1}", f"{name}-{cols[i][0]}", text, size,
                       color or bone, parent=bind, weight=weight,
                       width=cols[i][1] - 16, autoresize='"HEIGHT"'))
        return o

    acts = roster["levelStructure"]

    # Step 2：矩阵容器 + 表头 + Act1–2
    root = ph("IDX_FRAME_ID")
    ops = []
    ops.append(f'IDXMTX=I({root}, {{type: "frame", name: "投放矩阵", x: 24, '
               f'y: {tbh + 24}, width: {mw}, height: "hug_contents", '
               f'fill: {jstr(deep)}, cornerRadius: 18, strokes: [{solid(ink)}], '
               f'strokeWeight: 4, layout: "vertical", paddingTop: 0, '
               f'paddingBottom: 0, itemSpacing: 0}})')
    ops += row_ops("IDXH", "表头", [c[0] for c in cols], "IDXMTX", panel, size=17,
                   weight='"900"', color=C["gold"])
    for i, act in enumerate(acts[:2]):
        ops += row_ops(f"IDXR{i + 1}", f"Act{act['act']}",
                       [f'ACT {act["act"]} · {act["name"]}', f'W{act["waves"]}',
                        act["arena"], " ".join(act["enemies"]), act["boss"]],
                       "IDXMTX", deep if i % 2 == 0 else panel)
    steps.append(("Step IDX-2 · 投放矩阵 表头 + Act1–2", ops, "IDX_FRAME_ID"))

    # Step 3：Act3–4（父 = 上一步建的矩阵容器 ID）
    ops = []
    mtx = ph("IDX_MTX_ID")
    for i, act in enumerate(acts[2:], start=2):
        ops += row_ops(f"IDXR{i + 1}", f"Act{act['act']}",
                       [f'ACT {act["act"]} · {act["name"]}', f'W{act["waves"]}',
                        act["arena"], " ".join(act["enemies"]), act["boss"]],
                       mtx, deep if i % 2 == 0 else panel)
    steps.append(("Step IDX-3 · 投放矩阵 Act3–4", ops, "IDX_MTX_ID"))

    # ---- 剪影对照 ----
    units = [(u["id"], u["name"]) for u in roster["npcs"]] + \
            [(u["id"], u["name"]) for u in roster["bosses"]]

    def sil_ops(ids, parent, start):
        o = []
        for i, (uid, uname) in enumerate(ids, start=start):
            cb = f"IDXSV{i + 1}"
            o.append(box(cb, f"剪影-{uid}", 0, 0, 160, 220, panel, parent=parent,
                         radius=14, sw=4, ink=ink, layout="vertical",
                         extra='primaryAxisAlignItems: "CENTER", itemSpacing: 8, paddingTop: 14'))
            o.append(f'{cb}G=I({cb}, {{type: "frame", name: {jstr(f"剪影图-{uid}")}, '
                     f'width: 48, height: 64, fill: {jstr(paper)}, cornerRadius: 8, '
                     f'svg: {jsvg(svg_wrap(SILHOUETTES[uid], ink))}}})')
            o.append(T(f"{cb}T", f"剪影名-{uid}", f"{uid} {uname}", 16, bone,
                       parent=cb, weight='"700"'))
        return o

    # Step 4：剪影容器 + 前 4 个
    ops = [f'IDXS=I({root}, {{type: "frame", name: "剪影对照", x: 24, y: 560, '
           f'width: {mw}, height: 300, fill: {jstr(deep)}, cornerRadius: 18, '
           f'strokes: [{solid(ink)}], strokeWeight: 4, layout: "horizontal", '
           f'primaryAxisAlignItems: "SPACE_BETWEEN", paddingLeft: 24, '
           f'paddingRight: 24, paddingTop: 20}})']
    ops += sil_ops(units[:4], "IDXS", 0)
    steps.append(("Step IDX-4 · 剪影对照 1–4", ops, "IDX_FRAME_ID"))

    # Step 5：后 4 个
    ops = sil_ops(units[4:], ph("IDX_S_ID"), 4)
    steps.append(("Step IDX-5 · 剪影对照 5–8", ops, "IDX_S_ID"))
    return steps


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------

def render(roster: dict, C: dict) -> str:
    cv = roster["canvas"]
    L = cv["frameLayout"]
    fs = cv["frameSize"]
    by_id = {u["id"]: (u, False) for u in roster["npcs"]}
    by_id.update({u["id"]: (u, True) for u in roster["bosses"]})

    o = []
    o.append("# 末日尸潮 · 角色 Frame batch_edit 施工载荷")
    o.append("")
    o.append("> **自动生成**，源：`assets/characters/_tools/gen_ardot_payload.py`")
    o.append("> 改设定改 `roster.json`，改风格改 `tokens.json`，重跑脚本即可。**不要手改本文件。**")
    o.append("")
    o.append(f"设计文件 `{cv['fileId']}`　页面根 `{PAGE_ROOT}`　Frame {fs['w']}×{fs['h']}")
    o.append("")

    o.append("## 0 · 施工前必做")
    o.append("")
    o.append(f"1. `open_design({{fileId: \"{cv['fileId']}\"}})` —— **必须先开**，")
    o.append("   否则 `batch_edit` / `capture_screenshot` 等扩展工具不会出现。")
    o.append("2. `get_available_fonts({keyword: \"Sarasa\"})`、`get_available_fonts({keyword: \"Inter\"})`，")
    o.append("   用返回的**精确 family + style** 校正下文所有 `fontName`。")
    o.append("   本文件默认 `Sarasa Gothic SC / Bold`（中文）与 `Inter / Black`（数字英文）。")
    o.append("3. `locate_available_space` 确认 y=2640 / 3680 / 4720 三行是空的")
    o.append("   （已有 01–09 占 y=60 / 920 / 1780）。")
    o.append("")
    o.append("### 占位符 `<<...>>`")
    o.append("")
    o.append("`binding` 名只在**单次 batch_edit 调用内**有效。跨批次必须换成上一步返回的真实 ID：")
    o.append("")
    o.append("| 占位符 | 来源 |")
    o.append("|---|---|")
    for spec in cv["frames"]:
        k = spec["id"]
        if k == "IDX":
            o.append(f"| `<<IDX_FRAME_ID>>` | Step IDX-1 返回的 `IDXF` 节点 ID |")
            o.append(f"| `<<IDX_MTX_ID>>` | Step IDX-2 返回的 `IDXMTX` 节点 ID |")
            o.append(f"| `<<IDX_S_ID>>` | Step IDX-4 返回的 `IDXS` 节点 ID |")
        else:
            o.append(f"| `<<{k}_FRAME_ID>>` | Step {k}-1 返回的 `{k.replace('-', '')}F` 节点 ID |")
    o.append("")
    o.append("### 硬规则")
    o.append("")
    o.append(f"- 每次 `batch_edit` **最多 {MAX_OPS} 个操作**，本文件已按此切分，**勿合并步骤**。")
    o.append("- 一批里任一操作失败 → **整批回滚**；返回的 `potentialIssues` 在下一批修。")
    o.append("- 禁止 `textColor` / `alignItems` / `justifyContent` / `borderRadius` / `backgroundColor`（官方禁用属性表）。")
    o.append("- 文字颜色走 `fill`，圆角走 `cornerRadius`，对齐走 `primaryAxisAlignItems` / `counterAxisAlignItems`。")
    o.append("")

    o.append("## 1 · 施工顺序")
    o.append("")
    for spec in cv["frames"]:
        k = spec["id"]
        if k == "IDX":
            o.append(f"- **Page {spec['page']} · IDX 敌群图鉴 · 投放矩阵**　`IDX-1 → IDX-5`")
        else:
            u = by_id[k][0]
            o.append(f"- **Page {spec['page']} · {k} {u['name']} {u['en']}**　`{k}-1 → {k}-2`")
    o.append("")
    o.append("---")
    o.append("")

    for spec in cv["frames"]:
        k = spec["id"]
        fspec = {"x": spec["x"], "y": spec["y"], "w": fs["w"], "h": fs["h"]}
        if k == "IDX":
            steps = build_index(roster, fspec, L, C)
            o.append(f"## Page {spec['page']} · IDX 敌群图鉴 · 投放矩阵"
                     f"（x={spec['x']} y={spec['y']}）")
        else:
            u, is_boss = by_id[k]
            steps = build_unit_frame(u, is_boss, fspec, L, C, roster["styleSuffix"])
            o.append(f"## Page {spec['page']} · {k} {u['name']} {u['en']}"
                     f"（x={spec['x']} y={spec['y']}）")
        o.append("")

        for title, ops, _dep in steps:
            n = len(ops)
            flag = "" if n <= MAX_OPS else "　⚠️ **超过 25 ops，需再切分**"
            o.append(f"### {title}　`{n} ops`{flag}")
            o.append("")
            o.append("```javascript")
            o += ops
            o.append("```")
            o.append("")

        if k != "IDX":
            u = by_id[k][0]
            o.append("**AI 出图提示词**（已内联进 `G()`，此处备查）")
            o.append("")
            for vk, label in VIEWS:
                o.append(f"- `{label}`　`{' '.join([u['ai']['base'], u['ai'][vk], roster['styleSuffix']])}`")
            o.append("")
        o.append("---")
        o.append("")

    o.append("## 2 · 施工后必查")
    o.append("")
    o.append("1. **E-03 呕吐者 与 E-05 爆尸 是唯一高风险的一对** —— 剪影都是球体，只靠主色（绿 / 黄）二次区分。")
    o.append("   出图后并排缩到 48px 看；分不出来就拉开体型比例（E-03 球腹+细腿，E-05 正圆+小头）重出。")
    o.append("2. 每个角色剪影关键词互不相同，48px 下必须 0.3s 可辨：")
    for u in roster["npcs"] + roster["bosses"]:
        o.append(f"   - `{u['id']}`　{u['silhouette']}")
    o.append("3. 预警形状语言不能串：扇形(E-01) → 直线(E-02/E-04) → 落点圈(E-03) → 弧形(B-01) → 十字(B-02) → 体态突变(B-03)。")
    o.append("4. Page 15 剪影是**手工 SVG 底稿**，三视图出完后回头按真实立绘校准。")
    o.append("")
    return "\n".join(o) + "\n"


def main():
    roster, colors = load()
    text = render(roster, colors)
    OUT.write_text(text, encoding="utf-8")
    steps = text.count("\n### ")
    gops = len([l for l in text.splitlines() if l.startswith("G(")])
    print(f"written : {OUT}")
    print(f"steps   : {steps}")
    print(f"G() ops : {gops}")
    over = [l for l in text.splitlines() if "超过 25" in l]
    print(f"over-25 : {len(over)}")
    for l in over:
        print("  !", l.strip())


if __name__ == "__main__":
    main()
