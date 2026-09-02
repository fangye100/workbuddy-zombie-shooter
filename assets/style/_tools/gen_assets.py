#!/usr/bin/env python3
"""从 tokens.json 生成 .ase 色板与 .cube 3D LUT。

用法（用受管 Python 运行，纯标准库，无需安装依赖）:
    C:/Users/fangy/.workbuddy/binaries/python/versions/3.13.12/python.exe _tools/gen_assets.py
"""
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = json.loads((ROOT / "tokens.json").read_text(encoding="utf-8"))


# ---------- helpers ----------
def hex_to_rgb01(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def rgb01_to_hex(c):
    return "#{:02X}{:02X}{:02X}".format(*(max(0, min(255, round(v * 255))) for v in c))


def utf16be_name(name: str) -> bytes:
    return name.encode("utf-16-be") + b"\x00\x00"


# ---------- ASE (Adobe Swatch Exchange) ----------
def block(btype: int, payload: bytes) -> bytes:
    return struct.pack(">HI", btype, len(payload)) + payload


def group_start(name: str) -> bytes:
    n = utf16be_name(name)
    return block(0xC001, struct.pack(">H", len(name) + 1) + n)


def group_end() -> bytes:
    return block(0xC002, b"")


def color_entry(name: str, hex_value: str) -> bytes:
    r, g, b = hex_to_rgb01(hex_value)
    payload = struct.pack(">H", len(name) + 1) + utf16be_name(name)
    payload += b"RGB "
    payload += struct.pack(">ffff", r, g, b, 1.0)[:12]
    payload += struct.pack(">H", 0)  # 0 = global / 1 = spot / 2 = normal
    return block(0x0001, payload)


def build_ase() -> bytes:
    out = b"ASEF" + struct.pack(">HHI", 1, 0, 0)  # version 1.0, block count patched later
    count = 0
    body = b""
    for group_name, colors in TOKENS["groups"].items():
        body += group_start(group_name)
        count += 1
        for name, value in colors.items():
            body += color_entry(name, value)
            count += 1
        body += group_end()
        count += 1
    return b"ASEF" + struct.pack(">HHI", 1, 0, count) + body


# ---------- Toon Ramp 3D LUT ----------
def saturate(c, k):
    l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    return tuple(max(0.0, min(1.0, l + (v - l) * k)) for v in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0))) if e1 != e0 else (1.0 if x >= e1 else 0.0)
    return t * t * (3.0 - 2.0 * t)


def apply_ramp(rgb):
    """整体调色（grading）——温和版，只调饱和/暗部色相/亮部。"""
    colors = {name: hex_to_rgb01(v)
              for g in TOKENS["groups"].values() for name, v in g.items()}
    stops = TOKENS["grading"]["stops"]
    soft = TOKENS["grading"]["edgeSoftness"]
    lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

    out = (0.0, 0.0, 0.0)
    for i, s in enumerate(stops):
        lo, hi = s["range"]
        # 档位权重：以 soft 做窄边过渡，避免 LUT 分辨率造成的锯齿
        w = smoothstep(lo - soft, lo + soft, lum)
        if i < len(stops) - 1:
            w *= 1.0 - smoothstep(hi - soft, hi + soft, lum)
        if w <= 0.0:
            continue
        c = tuple(v * s["multiply"] for v in rgb)
        c = saturate(c, s["saturation"])
        if s.get("mixTo"):
            c = mix(c, colors[s["mixTo"]], s["mix"])
        out = tuple(o + v * w for o, v in zip(out, c))

    return tuple(max(0.0, min(1.0, v)) for v in out)


def build_cube(size: int = 17) -> str:
    lines = [
        'TITLE "末日尸潮 Toon Ramp"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
        "# 生成自 tokens.json（_tools/gen_assets.py），勿手改",
        "",
    ]
    # .cube 规定 R 变化最快，其次 G，其次 B
    last = size - 1
    for bi in range(size):
        for gi in range(size):
            for ri in range(size):
                rgb = (ri / last, gi / last, bi / last)
                o = apply_ramp(rgb)
                lines.append("{:.6f} {:.6f} {:.6f}".format(*o))
    return "\n".join(lines) + "\n"


def main():
    (ROOT / "末日尸潮-Tokens.ase").write_bytes(build_ase())
    (ROOT / "末日尸潮-ToonRamp.cube").write_text(build_cube(), encoding="utf-8")

    # 顺手打印一份明暗阶验证表，便于人眼核对
    colors = {n: h for g in TOKENS["groups"].values() for n, h in g.items()}
    print("明暗阶抽样（0=暗 1=亮）:")
    for name in ("zombie", "blood", "teal", "gold", "paper"):
        base = hex_to_rgb01(colors[name])
        row = "  {:8s} base {} -> ".format(name, colors[name])
        for t in (0.2, 0.5, 0.8, 1.0):
            c = apply_ramp(tuple(v * t for v in base))
            row += "{} ".format(rgb01_to_hex(c))
        print(row)
    print("\n已生成: 末日尸潮-Tokens.ase / 末日尸潮-ToonRamp.cube")


if __name__ == "__main__":
    main()
