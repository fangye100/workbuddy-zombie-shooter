"""复算 docs/12 §4 的「门面化」指标：LabRenderer 各方法体的实质行数。

口径（本轮重写，务必用同一份脚本对比不同版本）：
  - 方法起始：缩进 2 空格、以标识符开头、后接 `(` 或 `<` 或 ` =` 的行；
    排除 if/for/while/switch/catch/else/return/} 等控制流与字段名误判
  - 方法体：起始行 → 下一个缩进 2 的 `}` / `};`
  - 实质行：去掉空行、纯注释行、仅 `}` 的行、仅 `});` 的行

用法：
  python facade_metric.py <file.ts> [标签]
"""
import re
import sys

KEYWORDS = {
    "if", "for", "while", "switch", "catch", "else", "return", "do", "try",
    "const", "let", "var", "new", "typeof", "case",
}
# 修饰符必须显式吃掉：写成 `^  (\w+)\s*[(<]` 时 `private packLights(` 会被回溯判掉，
# 结果所有带修饰符的方法全部漏检（第一版就踩过这个坑，漏掉了整整 20 个方法）。
MOD = r"(?:(?:private|public|protected|static|abstract|async|readonly|get|set)\s+)*"
START = re.compile(r"^  " + MOD + r"([A-Za-z_$][\w$]*)\s*(?:[(<]|=)")


def measure(lines):
    methods = []
    i = 0
    while i < len(lines):
        stripped = lines[i].rstrip()
        # 必须有函数体开头，否则 `public readonly characterIndex = 1;` 这类字段会被当成
        # 方法，然后一路吞到下一个 `  }`，把几十个字段的行数全算到它头上（第二版踩的坑）。
        opens_body = stripped.endswith(("{", "(", ",", "=>"))
        m = START.match(lines[i])
        if m and m.group(1) not in KEYWORDS and opens_body:
            name = m.group(1)
            j = i + 1
            body = []
            while j < len(lines):
                if lines[j] in ("  }", "  };", "  })", "  }));"):
                    break
                body.append(lines[j])
                j += 1
            real = [
                b
                for b in body
                if b.strip()
                and not b.strip().startswith(("//", "*", "/*"))
                and b.strip() not in ("}", "});", ");")
            ]
            methods.append((name, len(real)))
            i = j
        i += 1
    return methods


def report(path, label):
    lines = open(path, encoding="utf-8").read().splitlines()
    methods = measure(lines)
    total = len(methods)
    delegates = [m for m in methods if m[1] <= 2]
    fat = [m for m in methods if m[1] > 10]
    fat_lines = sum(n for _, n in fat)
    all_lines = sum(n for _, n in methods)
    pct = fat_lines / all_lines * 100 if all_lines else 0
    print(f"[{label}] {path}")
    print(f"  文件行数            : {len(lines)}")
    print(f"  方法总数            : {total}")
    print(f"  ≤2 行委托（门面）    : {len(delegates)}")
    print(f"  >10 行实质逻辑      : {len(fat)}")
    print(f"  方法体实质行合计     : {all_lines}")
    print(f"  其中 >10 行方法合计  : {fat_lines}  ({pct:.0f}%)")
    print(f"  最重 5 个方法       : " + ", ".join(f"{n} {nm}" for nm, n in sorted(methods, key=lambda x: -x[1])[:5]))
    return dict(total=total, delegates=len(delegates), fat=len(fat), fat_lines=fat_lines, all=all_lines, pct=pct)


if __name__ == "__main__":
    report(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "current")
