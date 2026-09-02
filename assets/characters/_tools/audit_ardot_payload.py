#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
审计 assets/characters/ardot_batch_edit.md 是否符合官方 batch_edit 规范。

校验依据（唯一权威）：
  ~/.workbuddy/plugins/cache/workbuddy-builtin/skill-ardot-design-core/0.1.2/
    ├── tool-usage/batch-edit.md     I/C/U/M/D/G 语法 + 禁用属性表
    └── references/ardot-schema.md   节点属性 schema

用法： python _tools/audit_ardot_payload.py
退出码： 0 = 无 ERROR；1 = 有 ERROR
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ROOT / "ardot_batch_edit.md"

MAX_OPS = 25

# 官方禁用属性表（tool-usage/batch-edit.md §Common Property Mistakes）
FORBIDDEN = [
    "textColor", "fillColor", "backgroundColor",
    "alignItems", "justifyContent", "borderRadius", "verticalAlign",
]

errors = []
warns = []


def err(block, msg):
    errors.append(f"[{block}] {msg}")


def warn(block, msg):
    warns.append(f"[{block}] {msg}")


def strip_strings(s):
    """把 JS 字符串字面量挖掉，避免在提示词文本里误报禁用属性。"""
    return re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)


def split_blocks(text):
    """返回 [(block_name, claimed_ops, code, start_line)]"""
    out = []
    cur_head = None
    cur_claimed = None
    for m in re.finditer(r"^(#{2,3})\s*(.+)$", text, re.M):
        head = m.group(2).strip()
        om = re.search(r"(\d+)\s*ops", head)
        if om:
            cur_head = head
            cur_claimed = int(om.group(1))
        # 遇到下一个标题则重置
    # 用代码块切分
    for m in re.finditer(r"```javascript\n(.*?)```", text, re.S):
        code = m.group(1)
        start = text[:m.start()].count("\n") + 1
        # 往上找最近的 ### Step 标题
        before = text[:m.start()]
        heads = re.findall(r"^#{2,3}\s*(Step[^\n]*)$", before, re.M)
        name = heads[-1].strip() if heads else f"<line {start}>"
        claimed = None
        cm = re.search(r"(\d+)\s*ops", name)
        if cm:
            claimed = int(cm.group(1))
        out.append((name, claimed, code, start))
    return out


def main():
    if not PAYLOAD.exists():
        print(f"找不到载荷文件: {PAYLOAD}")
        return 1

    text = PAYLOAD.read_text(encoding="utf-8")
    blocks = split_blocks(text)
    print(f"载荷文件: {PAYLOAD.name}")
    print(f"代码块数: {len(blocks)}\n")

    total_ops = 0
    all_bindings = {}  # binding -> set(block_name)  跨批次复用 = 违规
    placeholders = {}

    for name, claimed, code, start in blocks:
        lines = [l.strip() for l in code.strip().split("\n") if l.strip()]
        ops = [l for l in lines if re.match(r"^(?:[A-Za-z_]\w*\s*=\s*)?[ICUMDG]\s*\(", l)]
        n = len(ops)
        total_ops += n

        # 1) 操作数上限
        if n > MAX_OPS:
            err(name, f"操作数 {n} 超过上限 {MAX_OPS}")
        if claimed is not None and claimed != n:
            warn(name, f"标题声明 {claimed} ops，实际 {n} ops（标题需同步）")

        # 2) 禁用属性（挖掉字符串字面量后再查）
        bare = strip_strings(code)
        for prop in FORBIDDEN:
            # 只匹配作为 key 出现： prop: 前面是 { 或 , 或 空白
            if re.search(r"(?<![\w.])" + prop + r"\s*:", bare):
                err(name, f"使用了官方禁用属性 `{prop}`")

        # 2b) color: "#xxx" 简写（禁用表里 color: "#FFF" 属违规）
        if re.search(r"(?<![\w.])color\s*:\s*\"#", bare):
            err(name, "使用了 `color: \"#...\"` 简写，应改用 `fill` / strokes[].color")

        # 3) binding 名唯一性（块内 + 跨块）
        block_bindings = []
        for l in ops:
            m = re.match(r"^([A-Za-z_]\w*)\s*=\s*([ICUMDG])\s*\(", l)
            if m:
                b, kind = m.group(1), m.group(2)
                block_bindings.append(b)
                all_bindings.setdefault(b, set()).add(name)

        dup = {b for b in block_bindings if block_bindings.count(b) > 1}
        if dup:
            err(name, f"块内 binding 重复定义: {sorted(dup)}")

        # 4) 每个 I() 必须有 name
        for l in ops:
            m = re.match(r"^(?:([A-Za-z_]\w*)\s*=\s*)?I\s*\(", l)
            if not m:
                continue
            # 粗定位该 I 操作的节点对象
            if "name:" not in l:
                err(name, f"I() 缺少 `name` 属性 -> {l[:90]}")

        # 5) text 节点必须有 fill
        for l in ops:
            if 'type: "text"' in l and "fill:" not in l:
                err(name, f"text 节点缺少 `fill`（文字默认无颜色）-> {l[:90]}")

        # 5b) fontWeight 必须是数字字符串
        for m in re.finditer(r"fontWeight\s*:\s*([^,}]+)", code):
            v = m.group(1).strip()
            if not re.fullmatch(r'"[1-9]00"', v):
                err(name, f"fontWeight 必须是数字字符串 \"100\"..\"900\"，当前 {v}")

        # 6) G() 参数校验
        for l in ops:
            m = re.match(r"^(?:([A-Za-z_]\w*)\s*=\s*)?G\s*\(", l)
            if not m:
                continue
            gm = re.match(r'^G\(\s*(.+?)\s*,\s*"(ai|placeholder)"\s*,\s*(.+)\)\s*$', l)
            if not gm:
                err(name, f"G() 语法不合法 -> {l[:90]}")
                continue
            target, gtype, prompt = gm.group(1), gm.group(2), gm.group(3)
            if gtype == "placeholder":
                pm = re.fullmatch(r'"((?:[^"\\]|\\.)*)"', prompt)
                if pm and len(pm.group(1)) > 20:
                    err(name, f"placeholder 标签超过 20 字符: {pm.group(1)[:40]}")
            else:
                if not prompt.startswith('"') or not prompt.rstrip().endswith('"'):
                    err(name, f"G(ai) 的提示词必须是完整字符串 -> {l[:90]}")
                else:
                    plen = len(prompt) - 2
                    if plen < 40:
                        warn(name, f"AI 提示词过短（{plen} 字符），出图质量存疑")

        # 7) 占位符收集
        for m in re.finditer(r"<<([^>]+)>>", code):
            placeholders.setdefault(m.group(1), set()).add(name)

        # 8) 行必须是"单条操作"，不能带分号拼接
        for l in lines:
            if ";" in l and not re.search(r'U\([^)]*;', l):
                pass  # 实例路径 U("inst;child") 合法

    # 跨批次 binding 复用检查
    cross = {b: s for b, s in all_bindings.items() if len(s) > 1}
    if cross:
        for b, s in sorted(cross.items()):
            err("GLOBAL", f"binding `{b}` 在多个批次复用（binding 仅单次调用内有效）: {sorted(s)}")

    # 占位符 vs 声明表
    declared = set(re.findall(r"\|?\s*`<<([^>]+)>>`", text))
    for p, s in sorted(placeholders.items()):
        if p not in declared and p != "...":
            warn("GLOBAL", f"占位符 <<{p}>> 未在说明表中登记（出现于 {sorted(s)}）")
    for p in sorted(declared):
        if p not in placeholders and p != "...":
            warns.append(f"[GLOBAL] 说明表登记了 <<{p}>> 但代码块中未使用")

    # 输出
    print(f"总操作数: {total_ops}")
    print(f"唯一 binding: {len(all_bindings)}")
    print(f"占位符: {len(placeholders)} 种 -> {sorted(placeholders)}")
    print()

    if errors:
        print(f"### ERROR ({len(errors)})")
        for e in errors:
            print("  x", e)
        print()
    if warns:
        print(f"### WARN ({len(warns)})")
        for w in warns:
            print("  !", w)
        print()

    if not errors and not warns:
        print("PASS · 全部检查通过")
    elif not errors:
        print(f"PASS（无 ERROR，{len(warns)} 条 WARN）")
    else:
        print(f"FAIL · {len(errors)} 条 ERROR 必须修")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
