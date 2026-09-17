"""38 张参考图 → 256px JPEG 缩略图（供 HTML 内嵌）。"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "..", "images")
OUT = os.path.join(HERE, "..", "..", "..", ".workbuddy", "tmp", "thumbs")
os.makedirs(OUT, exist_ok=True)

n = 0
for f in sorted(os.listdir(IMG)):
    if not f.endswith(".png"):
        continue
    im = Image.open(os.path.join(IMG, f)).convert("RGB")
    im.thumbnail((256, 256), Image.LANCZOS)
    im.save(os.path.join(OUT, f.replace(".png", ".jpg")), "JPEG", quality=82, optimize=True)
    n += 1
print(f"{n} thumbs -> {OUT}")
